import type { SqlProjectionOptions } from "@worlds/sqlite/sql-core";
import { D1VectorSync } from "./d1-vector-sync.ts";
import {
  type ProjectSearchChunksOptions,
  toProjectionOptions,
} from "./project-search-chunks-options.ts";
import { purgeWorldVectors } from "./project-search-chunks-vectors.ts";
import { rebuildD1SearchIndexFromQuads } from "./rebuild-d1-search-index-from-quads.ts";
import type { VectorSyncReport } from "./vector-sync-report.ts";

export type { ProjectSearchChunksOptions } from "./project-search-chunks-options.ts";

export interface D1SearchIndexProjectorOptions
  extends ProjectSearchChunksOptions {
  // Currently, options are exactly ProjectSearchChunksOptions.
}

/**
 * D1SearchIndexProjector holds what search projection needs beyond the shared
 * SQL commit core: the chunking and embedding options, the outside-D1 vector
 * sync, and the full rebuild. The commit itself runs in `commitD1Patch`.
 */
export class D1SearchIndexProjector {
  public constructor(
    private readonly options: D1SearchIndexProjectorOptions,
  ) {}

  /** projection is the shared core's chunking and embedding configuration. */
  public get projection(): SqlProjectionOptions {
    return toProjectionOptions(this.options);
  }

  /** createVectorSync starts a sync of chunk-row vectors to the outside-D1 index for one commit or rebuild. */
  public createVectorSync(): D1VectorSync {
    return new D1VectorSync(this.options);
  }

  /**
   * reindexAll rebuilds the entire search index directly from durable quads.
   */
  public async reindexAll(): Promise<void> {
    await rebuildD1SearchIndexFromQuads({
      ...this.options,
    });
  }

  /**
   * purgeVectors deletes every vector this world holds in the outside-D1
   * vector index (worlds-cloudflare#71 item 3).
   */
  public async purgeVectors(): Promise<VectorSyncReport> {
    return await purgeWorldVectors(this.options);
  }
}
