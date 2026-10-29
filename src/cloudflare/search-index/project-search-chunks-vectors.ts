import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import type { VectorSearchEntry } from "./vector-search/mod.ts";
import {
  emptyVectorSyncReport,
  recordVectorSyncError,
  type VectorSyncReport,
} from "./vector-sync-report.ts";
import {
  type ProjectSearchChunksOptions,
  vectorSyncEnabled,
} from "./project-search-chunks-options.ts";

/**
 * syncVectors upserts embedded vectors into the outside-D1 vector index and
 * reports the outcome. A failed upsert does not throw (the D1 write already
 * committed); it is counted so callers and logs can see the drift.
 */
export async function syncVectors(
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
export async function deleteStaleVectors(
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
