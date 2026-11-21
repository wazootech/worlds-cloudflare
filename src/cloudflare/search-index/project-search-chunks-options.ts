import type { QuadFilter } from "@worlds/sdk/quad-store";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { SqlProjectionOptions } from "@worlds/sqlite/sql-core";
import { buildChunkFtsValue } from "@worlds/sqlite/sql-core";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import type { VectorSearchIndex } from "./vector-search/mod.ts";

export interface ProjectSearchChunksOptions extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  textSplitter: TextSplitterInterface;
  maxWriteBatchSize?: number;
  searchQueryBuilder: D1SearchQueryBuilder;

  /**
   * vectorSearch syncs chunk vectors to the outside-D1 vector index (Phase C).
   * Only active when an embeddingService is also configured; otherwise chunks
   * stay keyword-only.
   */
  vectorSearch?: VectorSearchIndex;

  worldId?: string;
}

export function vectorSyncEnabled(
  options: ProjectSearchChunksOptions,
): boolean {
  return Boolean(options.embeddingService && options.vectorSearch);
}

/**
 * toProjectionOptions maps D1's options to the shared core's chunking and
 * embedding options. Embedding runs only when both an embedding service and a
 * vector index are wired; an embedding failure throws, as on every backend.
 */
export function toProjectionOptions(
  options: ProjectSearchChunksOptions,
): SqlProjectionOptions {
  return {
    textSplitter: options.textSplitter,
    embeddingService: vectorSyncEnabled(options)
      ? options.embeddingService
      : undefined,
    ftsValueOf: buildChunkFtsValue,
    vectorDimensions: options.vectorDimensions ??
      options.searchQueryBuilder.vectorDimensions,
  };
}

/** isFullRebuild is true when no include/exclude filter narrows a search-index rebuild. */
export function isFullRebuild(filter: QuadFilter): boolean {
  const narrows = (criteria: QuadFilter["include"]) =>
    Boolean(
      criteria?.subjects?.length || criteria?.predicates?.length ||
        criteria?.graphs?.length,
    );
  return !narrows(filter.include) && !narrows(filter.exclude);
}
