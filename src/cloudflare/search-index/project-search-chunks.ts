import type * as rdfjs from "@rdfjs/types";
import { hashQuads } from "@worlds/sdk/quad-store";
import type {
  ChunkRowPayload,
  TextSplitterInterface,
} from "@worlds/sdk/search-index/quad-chunker";
import { chunkQuads } from "@worlds/sdk/search-index/quad-chunker";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { buildChunkFtsValue } from "@worlds/sqlite/sql-core";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import type { VectorSearchEntry } from "./vector-search/mod.ts";
import {
  D1BatchExecutor,
  DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
} from "@/cloudflare/d1/d1-batch-executor.ts";
import type { D1Statement } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  emptyVectorSyncReport,
  logVectorSyncDrift,
  mergeVectorSyncReports,
  recordVectorSyncError,
  type VectorSyncReport,
} from "./vector-sync-report.ts";

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

/**
 * projectSearchChunks processes novel quads to create and store FTS chunks
 * plus embedded vectors (when an embeddingService + vectorSearch are wired).
 * Vector sync failures never fail an import (D1 stays the source of truth),
 * but they are counted in the returned report and logged as drift.
 */
export async function projectSearchChunks(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectSearchChunksOptions,
): Promise<VectorSyncReport> {
  const built = await buildChunkStatements(
    novelInsertions,
    novelQuadIds,
    options,
  );
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

  const lookupChunkSize = options.maxLookupChunkSize ?? 100;
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

function vectorSyncEnabled(options: ProjectSearchChunksOptions): boolean {
  return Boolean(options.embeddingService && options.vectorSearch);
}

function buildChunkDeletionStatementsChunked(
  quadIds: string[],
  queryBuilder: D1SearchQueryBuilder,
  chunkSize: number,
): D1Statement[] {
  const statements: D1Statement[] = [];
  for (let index = 0; index < quadIds.length; index += chunkSize) {
    const quadIdBatch = quadIds.slice(index, index + chunkSize);
    statements.push(queryBuilder.buildDeleteByQuadIds(quadIdBatch));
  }
  return statements;
}

async function buildChunkStatements(
  quads: rdfjs.Quad[],
  quadIds: string[],
  options: ProjectSearchChunksOptions,
): Promise<{
  statements: D1Statement[];
  vectorEntries: VectorSearchEntry[];
  report: VectorSyncReport;
}> {
  const statements: D1Statement[] = [];
  const vectorEntries: VectorSearchEntry[] = [];
  const report = emptyVectorSyncReport(vectorSyncEnabled(options));

  let chunks: ChunkRowPayload[];
  try {
    chunks = await chunkQuads(quads, options.textSplitter, quadIds);
  } catch (cause) {
    throw new Error("failed to chunk novel textual facts", { cause });
  }

  if (chunks.length === 0) {
    return { statements, vectorEntries, report };
  }

  const chunksWithFtsValue = chunks.map((chunk) => ({
    chunk,
    fts_value: buildChunkFtsValue(chunk),
  }));

  // Phase C: embed chunk text only when both an embedding service and a
  // vector index are wired. Embedding failure stores the chunks without
  // vectors (keyword-only) and is counted in the report; reindex repairs it.
  let vectors: Array<Float32Array | undefined> | undefined;
  let embedFailed = false;
  if (options.embeddingService && options.vectorSearch) {
    try {
      const embedded = await options.embeddingService.embed(
        chunksWithFtsValue.map(({ chunk }) => chunk.value),
      );
      vectors = embedded.map((vector) => new Float32Array(vector));
    } catch (error) {
      embedFailed = true;
      report.embeddingFailures += chunksWithFtsValue.length;
      recordVectorSyncError(report, "embed", error);
    }
  }

  for (let index = 0; index < chunksWithFtsValue.length; index++) {
    const { chunk, fts_value } = chunksWithFtsValue[index];
    const vector = embedFailed ? undefined : vectors?.[index];

    statements.push(
      options.searchQueryBuilder.buildInsertChunk({
        quad_id: chunk.quad_id,
        subject: chunk.subject,
        predicate: chunk.predicate,
        graph: chunk.graph,
        value: chunk.value,
        fts_value,
        vector,
        world_id: options.worldId,
      }),
    );

    if (vector) {
      vectorEntries.push({
        id: await buildSearchResultId({
          subject: chunk.subject,
          predicate: chunk.predicate,
          graph: chunk.graph,
          text: chunk.value,
        }),
        vector,
        metadata: {
          // VectorizeVectorSearchIndex stamps and enforces world_id; it is
          // never constructed without one (worlds-cloudflare#41).
          ...(options.worldId ? { world_id: options.worldId } : {}),
          subject: chunk.subject,
          predicate: chunk.predicate,
          graph: chunk.graph,
          value: chunk.value,
        },
      });
    }
  }

  return { statements, vectorEntries, report };
}

/**
 * syncVectors upserts embedded vectors into the outside-D1 vector index and
 * reports the outcome. A failed upsert does not throw (the D1 write already
 * committed); it is counted so callers and logs can see the drift.
 */
async function syncVectors(
  options: ProjectSearchChunksOptions,
  entries: VectorSearchEntry[],
): Promise<VectorSyncReport> {
  const report = emptyVectorSyncReport(vectorSyncEnabled(options));
  if (entries.length === 0 || !options.vectorSearch) return report;
  report.attempted = entries.length;
  try {
    await options.vectorSearch.upsert(entries);
    report.upserted = entries.length;
  } catch (error) {
    report.failedUpserts = entries.length;
    recordVectorSyncError(report, "upsert", error);
  }
  return report;
}

/**
 * deleteStaleVectors removes vectors for chunk rows being refreshed, computed
 * deterministically from the chunk quad ids before the D1 rows are replaced.
 * A failure leaves stale vectors behind; it is counted, not thrown.
 */
async function deleteStaleVectors(
  options: ProjectSearchChunksOptions,
  quadIds: string[],
  chunkSize: number,
): Promise<VectorSyncReport> {
  const report = emptyVectorSyncReport(vectorSyncEnabled(options));
  if (!options.vectorSearch || !options.embeddingService) return report;
  for (let index = 0; index < quadIds.length; index += chunkSize) {
    const quadIdBatch = quadIds.slice(index, index + chunkSize);
    const ids: string[] = [];
    try {
      const resultSet = await options.connection.execute(
        options.searchQueryBuilder.buildChunkVectorLookupByQuadIds(
          quadIdBatch,
        ),
      );
      for (const row of resultSet.rows) {
        ids.push(
          await buildSearchResultId({
            subject: String(row.subject),
            predicate: String(row.predicate),
            graph: String(row.graph),
            text: String(row.value),
          }),
        );
      }
      if (ids.length > 0) {
        await options.vectorSearch.deleteByIds(ids);
      }
    } catch (error) {
      report.staleDeleteFailures += Math.max(ids.length, 1);
      recordVectorSyncError(report, "delete-stale", error);
    }
  }
  return report;
}
