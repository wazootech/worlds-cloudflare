import type * as rdfjs from "@rdfjs/types";
import { hashQuads } from "@worlds/sdk/quad-store";
import {
  D1BatchExecutor,
  DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
  effectiveLookupChunkSize,
} from "@/cloudflare/d1/d1-batch-executor.ts";
import {
  emptyVectorSyncReport,
  logVectorSyncDrift,
  mergeVectorSyncReports,
  type VectorSyncReport,
} from "./vector-sync-report.ts";
import {
  type ProjectSearchChunksOptions,
  vectorSyncEnabled,
} from "./project-search-chunks-options.ts";
import {
  buildChunkDeletionStatementsChunked,
  buildChunkStatements,
} from "./project-search-chunks-build.ts";
import {
  deleteStaleVectors,
  syncVectors,
} from "./project-search-chunks-vectors.ts";

export type { ProjectSearchChunksOptions } from "./project-search-chunks-options.ts";

/** PreparedSearchChunks is chunked and embedded text that has not been written yet. */
export type PreparedSearchChunks = Awaited<
  ReturnType<typeof buildChunkStatements>
>;

/**
 * prepareSearchChunks chunks and embeds novel quads without touching D1 or the
 * vector index, so a caller can do it before any write. See buildChunkStatements.
 */
export async function prepareSearchChunks(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectSearchChunksOptions,
): Promise<PreparedSearchChunks> {
  return await buildChunkStatements(novelInsertions, novelQuadIds, options);
}

/**
 * writeSearchChunks stores prepared chunk rows and syncs their vectors to the
 * outside-D1 index. Vector sync failures never fail an import (D1 stays the
 * source of truth), but they are counted in the returned report and logged as
 * drift.
 */
export async function writeSearchChunks(
  built: PreparedSearchChunks,
  options: ProjectSearchChunksOptions,
): Promise<VectorSyncReport> {
  const chunkStatements = built.statements;
  const vectorEntries = built.vectorEntries;

  if (chunkStatements.length > 0) {
    const writeBatchSize = options.maxWriteBatchSize ??
      DEFAULT_D1_MAX_WRITE_BATCH_SIZE;
    try {
      const executor = new D1BatchExecutor({
        connection: options.connection,
        writeBatchSize,
      });
      await executor.stage(chunkStatements);
      await executor.flush();
    } catch (cause) {
      throw new Error("failed to execute search chunk sync batch", { cause });
    }
  }

  const report = mergeVectorSyncReports(
    built.report,
    await syncVectors(options, vectorEntries),
  );
  logVectorSyncDrift(report, {
    worldId: options.worldId,
    operation: "import",
  });
  return report;
}

/**
 * projectSearchChunks processes novel quads to create and store FTS chunks
 * plus embedded vectors (when an embeddingService + vectorSearch are wired).
 */
export async function projectSearchChunks(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectSearchChunksOptions,
): Promise<VectorSyncReport> {
  const built = await prepareSearchChunks(
    novelInsertions,
    novelQuadIds,
    options,
  );
  return await writeSearchChunks(built, options);
}

/**
 * refreshSearchChunksForQuads deletes existing chunk rows for the given quads and rebuilds FTS projections.
 * Durable `quads` rows are not modified. Returns the number of chunk rows
 * written and the vector sync report for the refreshed chunks.
 */
export async function refreshSearchChunksForQuads(
  quads: rdfjs.Quad[],
  options: ProjectSearchChunksOptions,
): Promise<{ chunkRowCount: number; vectorSync: VectorSyncReport }> {
  if (quads.length === 0) {
    return {
      chunkRowCount: 0,
      vectorSync: emptyVectorSyncReport(vectorSyncEnabled(options)),
    };
  }

  const lookupChunkSize = effectiveLookupChunkSize(
    options.maxLookupChunkSize,
    Boolean(options.worldId),
  );
  const writeBatchSize = options.maxWriteBatchSize ??
    DEFAULT_D1_MAX_WRITE_BATCH_SIZE;

  const quadIds = await hashQuads(quads);
  const built = await buildChunkStatements(quads, quadIds, options);
  const chunkInsertStatements = built.statements;

  const executor = new D1BatchExecutor({
    connection: options.connection,
    writeBatchSize,
  });

  try {
    await executor.stage(
      buildChunkDeletionStatementsChunked(
        quadIds,
        options.searchQueryBuilder,
        lookupChunkSize,
      ),
    );
    await executor.stage(chunkInsertStatements);
    await executor.flush();
  } catch (cause) {
    throw new Error("failed to refresh search chunks", { cause });
  }

  const staleDelete = await deleteStaleVectors(
    options,
    quadIds,
    lookupChunkSize,
  );
  const vectorSync = mergeVectorSyncReports(
    mergeVectorSyncReports(built.report, staleDelete),
    await syncVectors(options, built.vectorEntries),
  );

  return { chunkRowCount: chunkInsertStatements.length, vectorSync };
}
