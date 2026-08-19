import type {
  ReindexRequest,
  ReindexResponse,
  SearchIndexInterface,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "@worlds/sdk/search-index";
import { buildSearchResultId } from "./build-search-result-id.ts";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { rebuildD1SearchIndexFromQuads } from "./rebuild-d1-search-index-from-quads.ts";

/**
 * SearchRequestWithProfile extends SearchRequest with memory profile overrides for topK and minScore.
 * These fields will be added to the upstream SearchRequest interface in a future release.
 */
interface SearchRequestWithProfile extends SearchRequest {
  topK?: number;
  minScore?: number;
}

/**
 * CloudflareSearchIndexOptions defines the structured configuration and dependency parameters needed to construct the Cloudflare D1 search engine.
 */
export interface CloudflareSearchIndexOptions extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** searchQueryBuilder must match the schema and commit path used when materializing chunk vectors. */
  searchQueryBuilder: D1SearchQueryBuilder;

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

    const profileRequest = request as SearchRequestWithProfile;
    const searchLimit = profileRequest.topK ?? this.options.limit ?? 100;

    const { sql, args } = this.options.searchQueryBuilder.buildSearchQuery(
      request,
      {
        limit: searchLimit,
      },
    );

    const resultSet = await this.options.connection.execute({ sql, args });

    const minScore = profileRequest.minScore ?? 0;
    const results: SearchResult[] = [];

    for (const row of resultSet.rows) {
      const score = Number(row["combined_rank"]);
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
