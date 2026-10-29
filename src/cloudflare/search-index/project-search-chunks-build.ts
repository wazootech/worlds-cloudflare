import type * as rdfjs from "@rdfjs/types";
import type { ChunkRowPayload } from "@worlds/sdk/search-index/quad-chunker";
import { chunkQuads } from "@worlds/sdk/search-index/quad-chunker";
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
