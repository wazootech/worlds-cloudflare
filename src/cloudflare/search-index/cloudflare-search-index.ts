import {
  normalizeRrfScore,
  type ReindexRequest,
  type ReindexResponse,
  type SearchIndexInterface,
  type SearchMode,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from "@worlds/sdk/search-index";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import type {
  VectorSearchHit,
  VectorSearchIndex,
} from "./vector-search/mod.ts";
import { rebuildD1SearchIndexFromQuads } from "./rebuild-d1-search-index-from-quads.ts";

/**
 * CloudflareSearchIndexOptions defines the structured configuration and dependency parameters needed to construct the Cloudflare D1 search engine.
 */
export interface CloudflareSearchIndexOptions extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** worldUid scopes the vector query via the world_uid metadata filter. */
  worldUid?: string;

  /** searchQueryBuilder must match the schema and commit path used when materializing chunk vectors. */
  searchQueryBuilder: D1SearchQueryBuilder;

  /**
   * candidateCount sizes the internal candidate pool at the SQL level — the
   * number of ranked hits fetched before normalization and post-ranking
   * minScore filtering. Provider-internal per the hosted search contract
   * (worlds-api#30 D2); callers pass `max(limit, world.topK)`. Defaults to
   * `limit` (100).
   */
  candidateCount?: number;

  /**
   * vectorSearch is the outside-D1 vector index (Phase C, worlds-api#1). When
   * both vectorSearch and an embeddingService are wired, searches become
   * hybrid (FTS + vector fused by the contract's deterministic ids) and
   * `mode` reports semantic/hybrid/keyword accordingly.
   */
  vectorSearch?: VectorSearchIndex;

  /** limit establishes optional page sizing constraints for search result sets, defaulting to 100. */
  limit?: number;

  /** maxWriteBatchSize caps statements per D1 batch during reindex (default 500). */
  maxWriteBatchSize?: number;
}

/**
 * CloudflareSearchIndex implements the query pathway over D1's FTS5
 * external-content `chunks_fts` table fused with an outside-D1 vector index
 * (Phase C): keyword matches rank via reciprocal rank fusion against the
 * reference constant; when an embeddingService + Vectorize-bound
 * vectorSearch are wired, the query is embedded and the two lists fuse.
 *
 * Ranked semantics come from the reported `mode` — hybrid (both lists),
 * semantic (vector-only), keyword (FTS-only). No JS cosine fallback exists
 * per the cloudflare architecture decision (worlds-sdk-ts#63); any vector
 * failure degrades gracefully to keyword-only.
 */
export class CloudflareSearchIndex implements SearchIndexInterface {
  public constructor(
    private readonly options: CloudflareSearchIndexOptions,
  ) {}

  /**
   * search executes a keyword and/or vector query against the index and fuses
   * the ranked lists on the contract's deterministic result ids.
   */
  public async search(request: SearchRequest): Promise<SearchResponse> {
    if (this.options.embeddingService && !this.options.vectorSearch) {
      console.warn(
        "[Search Warning] embeddingService configured without a vector index (Phase C); running keyword-only.",
      );
    }

    // Provider-internal candidate pool: the window that gets ranked before
    // normalization and post-ranking minScore filtering. `topK` is no longer a
    // per-request override per the hosted search contract (worlds-api#30 D1).
    const candidateCount = this.options.candidateCount ??
      this.options.limit ?? 100;

    const { sql, args } = this.options.searchQueryBuilder.buildSearchQuery(
      request,
      {
        limit: candidateCount,
      },
    );

    const resultSet = await this.options.connection.execute({ sql, args });

    // Keyword list: rows arrive ordered by combined_rank DESC (best first), so
    // the 0-based row position is the rrf rank. Normalize to the contract
    // [0, 1] scale (score = k/(k+rank), rank 0 → 1.0).
    interface KeywordHit extends SearchResult {
      rankIndex: number;
    }
    const keywordHits: KeywordHit[] = [];
    for (let rowIndex = 0; rowIndex < resultSet.rows.length; rowIndex++) {
      const row = resultSet.rows[rowIndex];
      const searchResultBase = {
        subject: String(row["subject"]),
        predicate: String(row["predicate"]),
        graph: String(row["graph"]),
        text: String(row["value"]),
      };
      keywordHits.push({
        id: await buildSearchResultId(searchResultBase),
        ...searchResultBase,
        score: normalizeRrfScore(rowIndex),
        scoreType: "rrf",
        rankIndex: rowIndex,
      });
    }

    // Vector list (Phase C). Any failure (embedding down, index error) logs
    // and degrades to keyword-only — searches never crash on vector hiccups.
    let vectorHits: VectorSearchHit[] = [];
    if (this.options.embeddingService && this.options.vectorSearch) {
      try {
        const embedded = await this.options.embeddingService.embed([
          request.query,
        ]);
        const queryVector = embedded[0]
          ? new Float32Array(embedded[0])
          : undefined;
        if (queryVector) {
          vectorHits = await this.options.vectorSearch.query(
            Array.from(queryVector),
            {
              topK: candidateCount,
              ...(this.options.worldUid
                ? { filter: { world_uid: this.options.worldUid } }
                : {}),
            },
          );
        }
      } catch (error) {
        console.warn(
          "[Search Warning] vector query failed; falling back to keyword-only",
          error,
        );
      }
    }

    const { results, mode } = fuseRankedLists(keywordHits, vectorHits);
    const minScore = request.minScore ?? 0;
    return {
      mode,
      results: results
        .filter(({ score }) => score >= minScore)
        .map(({ result }) => result),
    };
  }

  /**
   * reindex rebuilds FTS chunk rows from durable quads without re-importing graph data.
   */
  public async reindex(
    request?: ReindexRequest,
  ): Promise<ReindexResponse> {
    const textSplitter = this.options.textSplitter;
    if (!textSplitter) {
      throw new Error(
        "CloudflareSearchIndex reindex requires textSplitter in CloudflareSearchIndexOptions",
      );
    }

    const include = request?.include ?? this.options.include;
    const exclude = request?.exclude ?? this.options.exclude;

    return await rebuildD1SearchIndexFromQuads({
      ...this.options,
      textSplitter,
      include,
      exclude,
      readPageSize: request?.readPageSize,
    });
  }
}

interface RankedCandidate {
  score: number;
  result: SearchResult;
}

/**
 * fuseRankedLists merges the keyword and vector ranked lists into the final
 * ranked result set (contract D7, hybrid factor):
 *
 * - Keyword-only: every hit is `rrf` with its normalized keyword rank score.
 * - Vec-only (semantic): every hit is `cosine` with `max(0, cosine)`.
 * - Hybrid: hits present in BOTH lists score the mean of their normalized
 *   keyword and vector ranks (rank 0 in both → 1.0) as `rrf` (fused
 *   reciprocal rank); hits only in the vector list stay `cosine`; hits only
 *   in the keyword list stay `rrf`. Final order is score-descending (stable).
 *
 * `mode` reports what actually ran so consumers never assume semantic.
 */
function fuseRankedLists(
  keywordHits: Array<SearchResult & { rankIndex: number }>,
  vectorHits: VectorSearchHit[],
): { results: RankedCandidate[]; mode: SearchMode } {
  if (vectorHits.length === 0) {
    return {
      mode: "keyword",
      results: keywordHits.map((hit) => ({ score: hit.score, result: hit })),
    };
  }

  if (keywordHits.length === 0) {
    const results = vectorHits.map((hit) => ({
      score: clampCosine(hit.score),
      result: hitToSearchResult(hit),
    }));
    return { mode: "semantic", results };
  }

  const keywordById = new Map(keywordHits.map((hit) => [hit.id, hit]));
  const results: RankedCandidate[] = [];

  for (let vectorRank = 0; vectorRank < vectorHits.length; vectorRank++) {
    const hit = vectorHits[vectorRank];
    const keywordMatch = keywordById.get(hit.id);
    if (keywordMatch) {
      // Present in both lists: mean of normalized ranks (rank 0 in both → 1.0).
      const fused = (keywordMatch.score + normalizeRrfScore(vectorRank)) / 2;
      results.push({
        score: fused,
        result: {
          id: keywordMatch.id,
          subject: keywordMatch.subject,
          predicate: keywordMatch.predicate,
          graph: keywordMatch.graph,
          text: keywordMatch.text,
          score: fused,
          scoreType: "rrf",
        },
      });
      keywordById.delete(hit.id);
    } else {
      results.push({
        score: clampCosine(hit.score),
        result: hitToSearchResult(hit),
      });
    }
  }

  for (const keywordOnly of keywordById.values()) {
    results.push({ score: keywordOnly.score, result: keywordOnly });
  }

  // Stable descending order by emitted score.
  results.sort((a, b) => b.score - a.score);
  return { mode: "hybrid", results };
}

function hitToSearchResult(hit: VectorSearchHit): SearchResult {
  return {
    id: hit.id,
    subject: hit.metadata?.subject ?? "",
    predicate: hit.metadata?.predicate ?? "",
    graph: hit.metadata?.graph ?? "",
    text: hit.metadata?.value ?? "",
    score: clampCosine(hit.score),
    scoreType: "cosine",
  };
}

/** Vectorize returns cosine similarity in [-1, 1]; clamp to the contract [0, 1]. */
function clampCosine(score: number): number {
  return Math.max(0, Math.min(1, score));
}
