import type * as rdfjs from "@rdfjs/types";
import { hashQuads } from "@worlds/sdk/quad-store";
import type { EmbeddedChunk } from "@worlds/sdk/search-index/quad-chunker";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import { effectiveLookupChunkSize } from "@/cloudflare/d1/d1-batch-executor.ts";
import type { VectorSearchEntry } from "./vector-search/mod.ts";
import {
  deleteStaleVectors,
  purgeWorldVectors,
  syncVectors,
} from "./project-search-chunks-vectors.ts";
import {
  type ProjectSearchChunksOptions,
  vectorSyncEnabled,
} from "./project-search-chunks-options.ts";
import {
  emptyVectorSyncReport,
  logVectorSyncDrift,
  mergeVectorSyncReports,
  type VectorSyncReport,
} from "./vector-sync-report.ts";

/**
 * D1VectorSync keeps the outside-D1 vector index (Vectorize) in step with the
 * chunk rows the shared commit core writes to D1. D1 batches and Vectorize
 * writes cannot share a transaction, so the vectors are synced after the D1
 * write lands: a failure there is counted and logged as drift, never thrown
 * (D1 stays the source of truth and a reindex repairs it).
 */
export class D1VectorSync {
  /** report accumulates everything this sync did to the vector index. */
  public report: VectorSyncReport;

  private pending: EmbeddedChunk[] = [];

  public constructor(private readonly options: ProjectSearchChunksOptions) {
    this.report = emptyVectorSyncReport(vectorSyncEnabled(options));
  }

  /** collect remembers the vectors of chunk rows the core just built. */
  public collect = (rows: readonly EmbeddedChunk[]): void => {
    if (!this.report.enabled) return;
    for (const row of rows) if (row.vector) this.pending.push(row);
  };

  /** flush upserts the collected vectors into the outside-D1 index. */
  public async flush(): Promise<void> {
    const rows = this.pending.splice(0);
    const entries: VectorSearchEntry[] = [];
    for (const { chunk, vector } of rows) {
      const { subject, predicate, graph, value } = chunk;
      entries.push({
        id: await buildSearchResultId({
          subject,
          predicate,
          graph,
          text: value,
        }),
        vector: new Float32Array(vector!),
        metadata: {
          // VectorizeVectorSearchIndex stamps and enforces world_id; it is
          // never constructed without one (worlds-cloudflare#41).
          ...(this.options.worldId ? { world_id: this.options.worldId } : {}),
          subject,
          predicate,
          graph,
          value,
        },
      });
    }
    this.merge(await syncVectors(this.options, entries));
  }

  /**
   * beforePage runs before each page of a rebuild: the previous page is
   * fully written by now, so its vectors sync, and the vectors of the chunk
   * rows this page is about to replace are removed.
   */
  public beforePage = async (quads: rdfjs.Quad[]): Promise<void> => {
    await this.flush();
    await this.deleteStale(hashQuads(quads));
  };

  /** purgeWorld deletes every vector of this world from the outside-D1 index. */
  public async purgeWorld(): Promise<void> {
    this.merge(await purgeWorldVectors(this.options));
  }

  /** deleteStale removes the vectors of the chunk rows about to be replaced for these quads. */
  public async deleteStale(quadIds: string[]): Promise<void> {
    const chunkSize = effectiveLookupChunkSize(
      this.options.maxLookupChunkSize,
      Boolean(this.options.worldId),
    );
    this.merge(await deleteStaleVectors(this.options, quadIds, chunkSize));
  }

  /** logDrift logs one structured error when this sync left the index out of step with D1. */
  public logDrift(operation: string): void {
    logVectorSyncDrift(this.report, {
      worldId: this.options.worldId,
      operation,
    });
  }

  private merge(report: VectorSyncReport): void {
    this.report = mergeVectorSyncReports(this.report, report);
  }
}
