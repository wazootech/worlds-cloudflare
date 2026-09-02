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

  worldUid?: string;
}

/**
 * projectSearchChunks processes novel quads to create and store FTS chunks
 * plus embedded vectors (when an embeddingService + vectorSearch are wired).
 * Vector sync failures degrade to keyword-only — they never fail an import.
 */
export async function projectSearchChunks(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectSearchChunksOptions,
): Promise<void> {
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

  await syncVectors(options, vectorEntries);
}

/**
 * refreshSearchChunksForQuads deletes existing chunk rows for the given quads and rebuilds FTS projections.
 * Durable `quads` rows are not modified. Returns the number of chunk rows written.
 */
export async function refreshSearchChunksForQuads(
  quads: rdfjs.Quad[],
  options: ProjectSearchChunksOptions,
): Promise<number> {
  if (quads.length === 0) {
    return 0;
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

  await deleteStaleVectors(options, quadIds, lookupChunkSize);
  await syncVectors(options, built.vectorEntries);

  return chunkInsertStatements.length;
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
): Promise<{ statements: D1Statement[]; vectorEntries: VectorSearchEntry[] }> {
  const statements: D1Statement[] = [];
  const vectorEntries: VectorSearchEntry[] = [];

  let chunks: ChunkRowPayload[];
  try {
    chunks = await chunkQuads(quads, options.textSplitter, quadIds);
  } catch (cause) {
    throw new Error("failed to chunk novel textual facts", { cause });
  }

  if (chunks.length === 0) {
    return { statements, vectorEntries };
  }

  const chunksWithFtsValue = chunks.map((chunk) => ({
    chunk,
    fts_value: buildChunkFtsValue(chunk),
  }));

  // Phase C: embed chunk text only when both an embedding service and a
  // vector index are wired. Embedding failure degrades to keyword-only for
  // this pass (the import path never fails because embeddings are down).
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
      console.warn(
        "[Search Warning] chunk embedding failed; continuing keyword-only",
        error,
      );
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
        world_uid: options.worldUid,
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
          ...(options.worldUid ? { world_uid: options.worldUid } : {}),
          subject: chunk.subject,
          predicate: chunk.predicate,
          graph: chunk.graph,
          value: chunk.value,
        },
      });
    }
  }

  return { statements, vectorEntries };
}

/**
 * syncVectors upserts embedded vectors into the outside-D1 vector index.
 * Best-effort: failures log and are skipped (keyword-only still serves).
 */
async function syncVectors(
  options: ProjectSearchChunksOptions,
  entries: VectorSearchEntry[],
): Promise<void> {
  if (entries.length === 0 || !options.vectorSearch) return;
  try {
    await options.vectorSearch.upsert(entries);
  } catch (error) {
    console.warn(
      `[Search Warning] vector index upsert failed for ${entries.length} entries; continuing keyword-only`,
      error,
    );
  }
}

/**
 * deleteStaleVectors removes vectors for chunk rows being refreshed, computed
 * deterministically from the chunk quad ids before the D1 rows are replaced.
 */
async function deleteStaleVectors(
  options: ProjectSearchChunksOptions,
  quadIds: string[],
  chunkSize: number,
): Promise<void> {
  if (!options.vectorSearch || !options.embeddingService) return;

  try {
    for (let index = 0; index < quadIds.length; index += chunkSize) {
      const quadIdBatch = quadIds.slice(index, index + chunkSize);
      const resultSet = await options.connection.execute(
        options.searchQueryBuilder.buildChunkVectorLookupByQuadIds(
          quadIdBatch,
        ),
      );
      const ids: string[] = [];
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
    }
  } catch (error) {
    console.warn(
      "[Search Warning] stale vector deletion failed; continuing",
      error,
    );
  }
}
