import type { ReindexResponse } from "@worlds/sdk/search-index";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import type { VectorSearchIndex } from "./vector-search/mod.ts";
import type { VectorSyncReport } from "./vector-sync-report.ts";

/**
 * CloudflareReindexResponse is the SDK ReindexResponse plus the vector sync
 * report, so a reindex whose vector half failed is distinguishable from a
 * complete one (worlds-cloudflare#40).
 */
export interface CloudflareReindexResponse extends ReindexResponse {
  vectorSync: VectorSyncReport;
}

/**
 * CloudflareSearchIndexOptions defines the structured configuration and dependency parameters needed to construct the Cloudflare D1 search engine.
 */
export interface CloudflareSearchIndexOptions extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** worldId scopes the vector query via the world_id metadata filter. */
  worldId?: string;

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
