import type * as rdfjs from "@rdfjs/types";
import type { ProjectSearchChunksOptions } from "./project-search-chunks.ts";
import { projectSearchChunks } from "./project-search-chunks.ts";
import { rebuildD1SearchIndexFromQuads } from "./rebuild-d1-search-index-from-quads.ts";

export interface D1SearchIndexProjectorOptions
  extends ProjectSearchChunksOptions {
  // Currently, options are exactly ProjectSearchChunksOptions.
}

/**
 * D1SearchIndexProjector encapsulates search projection operations.
 * It manages FTS chunk generation and indexing synchronization decoupled
 * from the primary quad storage path.
 */
export class D1SearchIndexProjector {
  public constructor(
    private readonly options: D1SearchIndexProjectorOptions,
  ) {}

  /**
   * projectNovelQuads processes new facts to project and index textual values.
   */
  public async projectNovelQuads(
    novelInsertions: rdfjs.Quad[],
    novelQuadIds: string[],
  ): Promise<void> {
    if (novelQuadIds.length > 0) {
      await projectSearchChunks(
        novelInsertions,
        novelQuadIds,
        this.options,
      );
    }
  }

  /**
   * reindexAll rebuilds the entire search index directly from durable quads.
   */
  public async reindexAll(): Promise<void> {
    await rebuildD1SearchIndexFromQuads({
      ...this.options,
    });
  }
}
