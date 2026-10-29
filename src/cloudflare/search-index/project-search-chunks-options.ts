import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";

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
  vectorSearch?: import("./vector-search/mod.ts").VectorSearchIndex;

  worldId?: string;
}

export function vectorSyncEnabled(
  options: ProjectSearchChunksOptions,
): boolean {
  return Boolean(options.embeddingService && options.vectorSearch);
}
