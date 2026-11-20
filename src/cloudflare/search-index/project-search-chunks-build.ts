import type * as rdfjs from "@rdfjs/types";
import { chunkAndEmbedQuads } from "@worlds/sdk/search-index/quad-chunker";
import { buildChunkFtsValue } from "@worlds/sqlite/sql-core";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import type { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import type { VectorSearchEntry } from "./vector-search/mod.ts";
import type { D1Statement } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  emptyVectorSyncReport,
  recordVectorSyncError,
  type VectorSyncReport,
} from "./vector-sync-report.ts";
import {
  type ProjectSearchChunksOptions,
  vectorSyncEnabled,
} from "./project-search-chunks-options.ts";

export function buildChunkDeletionStatementsChunked(
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

/**
 * buildChunkStatements chunks and embeds `quads` with the shared helper before
 * any write, and returns the chunk insert statements plus the vectors to sync
 * to the outside-D1 index. An embedding failure degrades: the chunks are kept
 * keyword-only and the failure is counted in the report (reindex repairs it).
 * Embedding runs only when both an embedding service and a vector index are
 * wired; the vector length is checked against the chunk table's width.
 */
export async function buildChunkStatements(
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

  const { rows, embeddingError } = await chunkAndEmbedQuads(quads, quadIds, {
    textSplitter: options.textSplitter,
    embeddingService: vectorSyncEnabled(options)
      ? options.embeddingService
      : undefined,
    ftsValueOf: buildChunkFtsValue,
    vectorDimensions: options.vectorDimensions ??
      options.searchQueryBuilder.vectorDimensions,
    onEmbeddingFailure: "degrade",
  });
  if (embeddingError !== undefined) {
    report.embeddingFailures += rows.length;
    recordVectorSyncError(report, "embed", embeddingError);
  }

  for (const { chunk, ftsValue, vector: embedded } of rows) {
    const vector = embedded ? new Float32Array(embedded) : undefined;
    statements.push(
      options.searchQueryBuilder.buildInsertChunk({
        quad_id: chunk.quad_id,
        subject: chunk.subject,
        predicate: chunk.predicate,
        graph: chunk.graph,
        value: chunk.value,
        fts_value: ftsValue,
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
