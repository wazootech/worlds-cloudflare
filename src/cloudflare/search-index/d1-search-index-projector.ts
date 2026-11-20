import type * as rdfjs from "@rdfjs/types";
import type { ProjectSearchChunksOptions } from "./project-search-chunks.ts";
import {
  type PreparedSearchChunks,
  prepareSearchChunks,
  projectSearchChunks,
  writeSearchChunks,
} from "./project-search-chunks.ts";
import { purgeWorldVectors } from "./project-search-chunks-vectors.ts";
import { rebuildD1SearchIndexFromQuads } from "./rebuild-d1-search-index-from-quads.ts";
import type { VectorSyncReport } from "./vector-sync-report.ts";

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
  ): Promise<VectorSyncReport | undefined> {
    if (novelQuadIds.length > 0) {
      return await projectSearchChunks(
        novelInsertions,
        novelQuadIds,
        this.options,
      );
    }
    return undefined;
  }

  /**
   * prepareProjection chunks and embeds novel quads without writing anything,
   * so a commit can do it before its first write. Returns undefined when there
   * are no novel quads.
   */
  public async prepareProjection(
    novelInsertions: rdfjs.Quad[],
    novelQuadIds: string[],
  ): Promise<PreparedSearchChunks | undefined> {
    if (novelQuadIds.length === 0) return undefined;
    return await prepareSearchChunks(
      novelInsertions,
      novelQuadIds,
      this.options,
    );
  }

  /**
   * writeProjection stores chunk rows from prepareProjection and syncs their vectors.
   */
  public async writeProjection(
    prepared: PreparedSearchChunks,
  ): Promise<VectorSyncReport> {
    return await writeSearchChunks(prepared, this.options);
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
   * vector index (worlds-cloudflare#71 item 3). The commit hook calls it
   * after a replace-import wipe when chunk projection runs incrementally; in
   * deferred mode the reindex that follows reconciles vectors itself.
   */
  public async purgeVectors(): Promise<VectorSyncReport> {
    return await purgeWorldVectors(this.options);
  }
}
