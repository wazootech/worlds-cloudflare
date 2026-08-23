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
}

/**
 * projectSearchChunks processes novel quads to create and store FTS chunks.
 * Vector embedding is skipped (Vectorize lives outside D1; Phase C wires it).
 */
export async function projectSearchChunks(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectSearchChunksOptions,
): Promise<void> {
  const chunkStatements = await buildChunkStatements(
    novelInsertions,
    novelQuadIds,
    options,
  );

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
  const chunkInsertStatements = await buildChunkStatements(
    quads,
    quadIds,
    options,
  );

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
): Promise<D1Statement[]> {
  const statements: D1Statement[] = [];

  let chunks: ChunkRowPayload[];
  try {
    chunks = await chunkQuads(quads, options.textSplitter, quadIds);
  } catch (cause) {
    throw new Error("failed to chunk novel textual facts", { cause });
  }

  if (chunks.length === 0) {
    return [];
  }

  const chunksWithFtsValue = chunks.map((chunk) => ({
    chunk,
    fts_value: buildChunkFtsValue(chunk),
  }));

  for (const { chunk, fts_value } of chunksWithFtsValue) {
    statements.push(
      options.searchQueryBuilder.buildInsertChunk({
        quad_id: chunk.quad_id,
        subject: chunk.subject,
        predicate: chunk.predicate,
        graph: chunk.graph,
        value: chunk.value,
        fts_value,
      }),
    );
  }

  return statements;
}
