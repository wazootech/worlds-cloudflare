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
  buildDeleteDerivedQuadsByQuadIds,
  buildDeleteQuadsByQuadIds,
  buildSelectExistingQuadIds,
  buildWipeAllGraphDataStatements,
  type InsertQuadRow,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { quadToInsertRow } from "@/cloudflare/d1/d1-quad-row.ts";
import {
  DEFAULT_MAX_ASSERTED_QUADS,
  loadAssertedQuads,
} from "@/cloudflare/inference/load-asserted-quads.ts";
import {
  type InferencePlan,
  planInference,
} from "@/cloudflare/inference/inference-planner.ts";

export interface CommitPatchToD1Options extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** maxWriteBatchSize caps how many statements are sent per D1 batch. Defaults to 100 (D1's batch cap). */
  maxWriteBatchSize?: number;

  /** worldId scopes this commit to one logical world. */
  worldId?: string;
}

export interface CommitPatchToD1Result {
  novelInsertions: rdfjs.Quad[];
  novelQuadIds: string[];

  /**
   * inference summarizes the inferred rows this commit wrote. Absent when the
   * world has not opted in.
   */
  inference?: {
    derivedInserted: number;
    derivedRemoved: number;
    inconsistencies: InferencePlan["inconsistencies"];
  };
}

/**
 * executeReplaceImportWipe clears all quads and search chunks before a replace-mode import commit.
 */
async function executeReplaceImportWipe(
  connection: D1ConnectionDriver,
  writeBatchSize: number,
  worldId?: string,
): Promise<void> {
  const executor = new D1BatchExecutor({ connection, writeBatchSize });
  await executor.stage(buildWipeAllGraphDataStatements(worldId));
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
    worldId,
  } = options;
  const lookupChunkSize = maxLookupChunkSize ?? 100;
  const writeBatchSize = maxWriteBatchSize ?? DEFAULT_D1_MAX_WRITE_BATCH_SIZE;

  const batchExecutor = new D1BatchExecutor({ connection, writeBatchSize });

  if (isReplaceImportCommit(context)) {
    await executeReplaceImportWipe(connection, writeBatchSize, worldId);
  }

  const matcher = filterQuads({ include, exclude });

  const targetedDeletions = patch.deletions?.filter(matcher) ?? [];
  const targetedInsertions = patch.insertions?.filter(matcher) ?? [];

  // Inference runs before any write so a size-guard failure leaves the world
  // untouched. It reads the asserted quads as they are after any replace wipe.
  const inference = options.inference?.enabled ? options.inference : undefined;
  let plan: InferencePlan | undefined;
  if (inference) {
    const assertedBefore = await loadAssertedQuads(connection, {
      worldId,
      maxAssertedQuads: inference.maxAssertedQuads ??
        DEFAULT_MAX_ASSERTED_QUADS,
      pendingInsertions: targetedInsertions.length,
    });
    plan = planInference({
      assertedBefore,
      deletions: targetedDeletions,
      insertions: targetedInsertions,
      graphs: inference.graphs,
    });
  }

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
        (chunk) => [buildDeleteQuadsByQuadIds(chunk, worldId)],
      );
    }
  }

  if (plan && plan.derivedToRemove.length > 0) {
    await stageChunked(
      batchExecutor,
      await hashQuads(plan.derivedToRemove),
      lookupChunkSize,
      (chunk) => [buildDeleteDerivedQuadsByQuadIds(chunk, worldId)],
    );
  }

  const novelInsertions: rdfjs.Quad[] = [];
  const novelQuadIds: string[] = [];

  if (targetedInsertions.length) {
    const proposedQuadIds = await hashQuads(targetedInsertions);
    const existingIds = await queryCachePresence(
      connection,
      proposedQuadIds,
      lookupChunkSize,
      worldId,
      inference !== undefined,
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
        (chunk) => [buildDeleteQuadsByQuadIds(chunk, worldId)],
      );

      const novelRows: InsertQuadRow[] = [];
      for (let index = 0; index < novelInsertions.length; index++) {
        novelRows.push(await quadToInsertRow(novelInsertions[index]!));
      }
      await batchExecutor.stage(
        buildBulkInsertQuads(
          novelRows.map((row) => ({
            ...row,
            world_id: worldId,
            ...(inference && { derived: 0 as const }),
          })),
        ),
      );
    }
  }

  let derivedInserted = 0;
  if (plan) {
    // OR IGNORE: a quad that is asserted (now or already) stays asserted.
    const derivedRows: InsertQuadRow[] = [];
    const seen = new Set<string>();
    for (const quad of [...plan.derivedToAdd, ...plan.entailedDeletions]) {
      const row = await quadToInsertRow(quad);
      if (seen.has(row.quad_id)) continue;
      seen.add(row.quad_id);
      derivedRows.push({ ...row, world_id: worldId, derived: 1 });
    }
    derivedInserted = derivedRows.length;
    await batchExecutor.stage(
      buildBulkInsertQuads(derivedRows, { orIgnore: true }),
    );
  }

  try {
    await batchExecutor.flush();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`failed to execute D1 batch: ${detail}`, { cause });
  }

  return {
    novelInsertions,
    novelQuadIds,
    ...(plan && {
      inference: {
        derivedInserted,
        derivedRemoved: plan.derivedToRemove.length,
        inconsistencies: plan.inconsistencies,
      },
    }),
  };
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
  worldId?: string,
  assertedOnly = false,
): Promise<Set<string>> {
  const cachedIds = new Set<string>();
  for (let index = 0; index < quadIds.length; index += lookupChunkSize) {
    const chunk = quadIds.slice(index, index + lookupChunkSize);
    const result = await connection.execute(
      buildSelectExistingQuadIds(chunk, worldId, { assertedOnly }),
    );
    for (const row of result.rows) {
      if (row.id) {
        cachedIds.add(String(row.id));
      }
    }
  }
  return cachedIds;
}
