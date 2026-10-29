import type * as rdfjs from "@rdfjs/types";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { hashQuads, isReplaceImportCommit } from "@worlds/sdk/quad-store";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  buildBulkInsertQuads,
  buildDeleteQuadsByQuadIds,
  buildSelectExistingQuadIds,
  buildWipeAllGraphDataStatements,
  type InsertQuadRow,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { D1BatchExecutor } from "@/cloudflare/d1/d1-batch-executor.ts";
import { quadToInsertRow } from "@/cloudflare/d1/d1-quad-row.ts";

/** D1PatchDeps is the store state applyD1Patch reads. */
export interface D1PatchDeps {
  connection: D1ConnectionDriver;
  writeBatchSize: number;
  lookupChunkSize: number;
  worldId?: string;
}

/**
 * applyD1Patch persists a patch atomically in one D1 batch (chunked only when
 * staged statements exceed the write batch size). Callers serialize it.
 */
export async function applyD1Patch(
  deps: D1PatchDeps,
  patch: Patch,
  context?: TransactionContext,
): Promise<void> {
  const executor = new D1BatchExecutor({
    connection: deps.connection,
    writeBatchSize: deps.writeBatchSize,
  });

  if (isReplaceImportCommit(context)) {
    await executor.stage(buildWipeAllGraphDataStatements(deps.worldId));
  }

  const targetedDeletions = patch.deletions ?? [];
  const targetedInsertions = patch.insertions ?? [];

  if (targetedDeletions.length > 0) {
    const deletionIds = await hashQuads(targetedDeletions);
    await stageChunked(
      executor,
      deletionIds,
      deps.lookupChunkSize,
      (chunk) => [buildDeleteQuadsByQuadIds(chunk, deps.worldId)],
    );
  }

  if (targetedInsertions.length > 0) {
    const proposedIds = await hashQuads(targetedInsertions);
    const existingIds = await queryCachePresence(
      deps.connection,
      proposedIds,
      deps.lookupChunkSize,
      deps.worldId,
    );

    const novelRows: InsertQuadRow[] = [];
    for (let index = 0; index < targetedInsertions.length; index++) {
      if (existingIds.has(proposedIds[index]!)) {
        continue;
      }
      novelRows.push(await quadToInsertRow(targetedInsertions[index]!));
    }

    if (novelRows.length > 0) {
      await executor.stage(
        buildBulkInsertQuads(
          novelRows.map((row) => ({ ...row, world_id: deps.worldId })),
        ),
      );
    }
  }

  try {
    await executor.flush();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`failed to execute D1 batch: ${detail}`, { cause });
  }
}

/** stageChunked slices ids into chunks and stages the generated statements per chunk. */
async function stageChunked(
  executor: D1BatchExecutor,
  ids: string[],
  chunkSize: number,
  build: (chunk: string[]) => Array<{ sql: string; args: unknown[] }>,
): Promise<void> {
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    await executor.stage(build(chunk));
  }
}

/** queryCachePresence polls D1 for which quad ids are already persisted. */
async function queryCachePresence(
  connection: D1ConnectionDriver,
  quadIds: string[],
  lookupChunkSize: number,
  worldId?: string,
): Promise<Set<string>> {
  const cachedIds = new Set<string>();
  for (let index = 0; index < quadIds.length; index += lookupChunkSize) {
    const chunk = quadIds.slice(index, index + lookupChunkSize);
    const result = await connection.execute(
      buildSelectExistingQuadIds(chunk, worldId),
    );
    for (const row of result.rows) {
      if (row.id) {
        cachedIds.add(String(row.id));
      }
    }
  }
  return cachedIds;
}

/** insertD1Quad writes one quad row in its own batch. */
export async function insertD1Quad(
  connection: D1ConnectionDriver,
  worldId: string | undefined,
  quad: rdfjs.Quad,
): Promise<void> {
  await connection.batch(
    buildBulkInsertQuads([{
      ...(await quadToInsertRow(quad)),
      world_id: worldId,
    }]),
  );
}

/** deleteD1Quad deletes one quad row by its content-addressed id. */
export async function deleteD1Quad(
  connection: D1ConnectionDriver,
  worldId: string | undefined,
  quad: rdfjs.Quad,
): Promise<void> {
  const [id] = await hashQuads([quad]);
  await connection.batch([
    buildDeleteQuadsByQuadIds([id], worldId),
  ]);
}
