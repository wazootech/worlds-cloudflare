import {
  normalizeRrfScore,
  type ReindexRequest,
  type ReindexResponse,
  type SearchIndexInterface,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from "@worlds/sdk/search-index";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { rebuildD1SearchIndexFromQuads } from "./rebuild-d1-search-index-from-quads.ts";

/**
 * CloudflareSearchIndexOptions defines the structured configuration and dependency parameters needed to construct the Cloudflare D1 search engine.
 */
export interface CloudflareSearchIndexOptions extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

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

  /** limit establishes optional page sizing constraints for search result sets, defaulting to 100. */
  limit?: number;

  /** maxWriteBatchSize caps statements per D1 batch during reindex (default 500). */
  maxWriteBatchSize?: number;
}

/**
 * CloudflareSearchIndex implements the query pathway over D1's FTS5
 * external-content `chunks_fts` table. Keyword matches rank via reciprocal
 * rank fusion against the reference constant.
 *
 * The vector signal lives outside D1 (Vectorize). Until a Vectorize binding is
 * wired (Phase C), searches degrade to keyword-only with a warning — there is
 * no JS cosine fallback per the cloudflare architecture decision
 * (worlds-sdk-ts#63).
 */
export class CloudflareSearchIndex implements SearchIndexInterface {
  public constructor(
    private readonly options: CloudflareSearchIndexOptions,
  ) {}

  /**
   * search executes a keyword query against the current FTS5 index.
   */
  public async search(request: SearchRequest): Promise<SearchResponse> {
    if (this.options.embeddingService) {
      console.warn(
        "[Search Warning] CloudflareSearchIndex runs keyword-only until a Vectorize binding is wired (Phase C). Embedding service is ignored.",
      );
    }

    // Provider-internal candidate pool: the SQL window that gets ranked before
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

    const minScore = request.minScore ?? 0;
    const results: SearchResult[] = [];

    // Rows arrive ordered by combined_rank DESC (best first), so the 0-based
    // row position is the rrf rank. Normalize to the contract [0, 1] scale
    // (score = k/(k+rank), rank 0 → 1.0) so minScore is a meaningful floor.
    for (let rowIndex = 0; rowIndex < resultSet.rows.length; rowIndex++) {
      const row = resultSet.rows[rowIndex];
      const score = normalizeRrfScore(rowIndex);
      if (score < minScore) continue;

      const searchResultBase = {
        subject: String(row["subject"]),
        predicate: String(row["predicate"]),
        graph: String(row["graph"]),
        text: String(row["value"]),
      };
      results.push({
        id: await buildSearchResultId(searchResultBase),
        ...searchResultBase,
        score,
        scoreType: "rrf",
      });
    }

    return { results };
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
