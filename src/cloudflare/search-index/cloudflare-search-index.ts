import {
  normalizeRrfScore,
  type ReindexRequest,
  type SearchIndexInterface,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from "@worlds/sdk/search-index";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import type { VectorSearchHit } from "./vector-search/mod.ts";
import { rebuildD1SearchIndexFromQuads } from "./rebuild-d1-search-index-from-quads.ts";
import { fuseRankedLists } from "./cloudflare-search-index-fusion.ts";
import type {
  CloudflareReindexResponse,
  CloudflareSearchIndexOptions,
} from "./cloudflare-search-index-options.ts";

export type {
  CloudflareReindexResponse,
  CloudflareSearchIndexOptions,
} from "./cloudflare-search-index-options.ts";

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
              ...(this.options.worldId
                ? { filter: { world_id: this.options.worldId } }
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
   * reindex rebuilds FTS chunk rows (and, when wired, re-embeds and re-upserts
   * vectors) from durable quads without re-importing graph data. It is the
   * repair path for vector drift; `vectorSync` reports what reached the index.
   */
  public async reindex(
    request?: ReindexRequest,
  ): Promise<CloudflareReindexResponse> {
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
