import type * as rdfjs from "@rdfjs/types";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { isReplaceImportCommit } from "@worlds/sdk/quad-store";
import { filterQuads, hashQuads } from "@worlds/sdk/quad-store";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  D1BatchExecutor,
  DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
} from "@/cloudflare/d1/d1-batch-executor.ts";
import {
  buildBulkInsertQuads,
  buildDeleteQuadsByQuadIds,
  buildSelectExistingQuadIds,
  buildWipeAllGraphDataStatements,
  type InsertQuadRow,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { quadToInsertRow } from "@/cloudflare/d1/d1-quad-row.ts";

export interface CommitPatchToD1Options extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** maxWriteBatchSize caps how many statements are sent per D1 batch. Defaults to 100 (D1's batch cap). */
  maxWriteBatchSize?: number;
}

export interface CommitPatchToD1Result {
  novelInsertions: rdfjs.Quad[];
  novelQuadIds: string[];
}

/**
 * executeReplaceImportWipe clears all quads and search chunks before a replace-mode import commit.
 */
async function executeReplaceImportWipe(
  connection: D1ConnectionDriver,
  writeBatchSize: number,
): Promise<void> {
  const executor = new D1BatchExecutor({ connection, writeBatchSize });
  await executor.stage(buildWipeAllGraphDataStatements());
  await executor.flush();
}

/**
 * commitPatchToD1 commits additions and removals exclusively for D1 quads.
 * It returns the novel insertions and touched subjects to be processed by independent search projection.
 */
export async function commitPatchToD1(
  patch: Patch,
  options: CommitPatchToD1Options,
  context?: TransactionContext,
): Promise<CommitPatchToD1Result> {
  const {
    connection,
    maxLookupChunkSize,
    maxWriteBatchSize,
    include,
    exclude,
  } = options;
  const lookupChunkSize = maxLookupChunkSize ?? 100;
  const writeBatchSize = maxWriteBatchSize ?? DEFAULT_D1_MAX_WRITE_BATCH_SIZE;

  const batchExecutor = new D1BatchExecutor({ connection, writeBatchSize });

  if (isReplaceImportCommit(context)) {
    await executeReplaceImportWipe(connection, writeBatchSize);
  }

  const matcher = filterQuads({ include, exclude });

  const targetedDeletions = patch.deletions?.filter(matcher) ?? [];
  const targetedInsertions = patch.insertions?.filter(matcher) ?? [];

  const deletionQuadIds = new Set<string>();
  if (targetedDeletions.length) {
    const computedDeletionQuadIds = await hashQuads(targetedDeletions);
    for (const quadId of computedDeletionQuadIds) {
      deletionQuadIds.add(quadId);
    }
    if (computedDeletionQuadIds.length > 0) {
      await stageChunked(
        batchExecutor,
        computedDeletionQuadIds,
        lookupChunkSize,
        (chunk) => [buildDeleteQuadsByQuadIds(chunk)],
      );
    }
  }

  const novelInsertions: rdfjs.Quad[] = [];
  const novelQuadIds: string[] = [];

  if (targetedInsertions.length) {
    const proposedQuadIds = await hashQuads(targetedInsertions);
    const existingIds = await queryCachePresence(
      connection,
      proposedQuadIds,
      lookupChunkSize,
    );

    for (let i = 0; i < targetedInsertions.length; i++) {
      const id = proposedQuadIds[i];
      if (!existingIds.has(id) || deletionQuadIds.has(id)) {
        novelInsertions.push(targetedInsertions[i]);
        novelQuadIds.push(id);
      }
    }

    if (novelQuadIds.length > 0) {
      await stageChunked(
        batchExecutor,
        novelQuadIds,
        lookupChunkSize,
        (chunk) => [buildDeleteQuadsByQuadIds(chunk)],
      );

      const novelRows: InsertQuadRow[] = [];
      for (let index = 0; index < novelInsertions.length; index++) {
        novelRows.push(await quadToInsertRow(novelInsertions[index]!));
      }
      await batchExecutor.stage(buildBulkInsertQuads(novelRows));
    }
  }

  try {
    await batchExecutor.flush();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`failed to execute D1 batch: ${detail}`, { cause });
  }

  return { novelInsertions, novelQuadIds };
}

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

async function queryCachePresence(
  connection: D1ConnectionDriver,
  quadIds: string[],
  lookupChunkSize: number,
): Promise<Set<string>> {
  const cachedIds = new Set<string>();
  for (let index = 0; index < quadIds.length; index += lookupChunkSize) {
    const chunk = quadIds.slice(index, index + lookupChunkSize);
    const result = await connection.execute(buildSelectExistingQuadIds(chunk));
    for (const row of result.rows) {
      if (row.id) {
        cachedIds.add(String(row.id));
      }
    }
  }
  return cachedIds;
}
