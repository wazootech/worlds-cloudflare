import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { hashQuads, isReplaceImportCommit } from "@worlds/sdk/quad-store";
import {
  D1BatchExecutor,
  DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
  effectiveLookupChunkSize,
} from "@/cloudflare/d1/d1-batch-executor.ts";
import {
  buildDeleteDerivedQuadsByQuadIds,
  buildDeleteQuadsByQuadIds,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import {
  DEFAULT_MAX_ASSERTED_QUADS,
  loadAssertedQuads,
} from "@/cloudflare/inference/load-asserted-quads.ts";
import {
  type InferencePlan,
  planInference,
} from "@/cloudflare/inference/inference-planner.ts";
import type {
  CommitPatchToD1Options,
  CommitPatchToD1Result,
} from "./commit-patch-to-d1-types.ts";
import {
  executeReplaceImportWipe,
  stageChunked,
  stageDerivedRows,
  stageNovelInsertions,
} from "./commit-patch-to-d1-helpers.ts";
import { type D1CommitPlan, planD1Commit } from "./commit-patch-to-d1-plan.ts";

export type {
  CommitPatchToD1Options,
  CommitPatchToD1Result,
} from "./commit-patch-to-d1-types.ts";
export { type D1CommitPlan, planD1Commit } from "./commit-patch-to-d1-plan.ts";

/**
 * commitPatchToD1 plans and applies a patch exclusively for D1 quads.
 * It returns the novel insertions to be processed by independent search projection.
 */
export async function commitPatchToD1(
  patch: Patch,
  options: CommitPatchToD1Options,
  context?: TransactionContext,
): Promise<CommitPatchToD1Result> {
  const plan = await planD1Commit(patch, options, context);
  return await applyD1Commit(plan, options, context);
}

/**
 * applyD1Commit writes a plan from planD1Commit: the replace-import wipe, the
 * inference plan, deletions, novel insertions, and derived rows. The plan's
 * filtering, hashing, and presence lookup already ran, so the first write here
 * is the first change to the world.
 */
export async function applyD1Commit(
  plan: D1CommitPlan,
  options: CommitPatchToD1Options,
  context?: TransactionContext,
): Promise<CommitPatchToD1Result> {
  const { connection, maxLookupChunkSize, maxWriteBatchSize, worldId } =
    options;
  const { prepared, novelInsertions, novelQuadIds } = plan;
  // The documented cap is host parameters per statement; world-scoped
  // statements also bind world_id, so reserve one slot for it.
  const lookupChunkSize = effectiveLookupChunkSize(
    maxLookupChunkSize,
    Boolean(worldId),
  );
  const writeBatchSize = maxWriteBatchSize ?? DEFAULT_D1_MAX_WRITE_BATCH_SIZE;
  const batchExecutor = new D1BatchExecutor({ connection, writeBatchSize });
  const deletionQuadIds = new Set(prepared.deletionIds);

  if (isReplaceImportCommit(context)) {
    await executeReplaceImportWipe(connection, writeBatchSize, worldId);
  }

  // Inference runs before any staged write so a size-guard failure leaves the
  // world untouched. It reads the asserted quads as they are after any replace wipe.
  const inference = options.inference?.enabled ? options.inference : undefined;
  let inferencePlan: InferencePlan | undefined;
  if (inference) {
    const assertedBefore = await loadAssertedQuads(connection, {
      worldId,
      maxAssertedQuads: inference.maxAssertedQuads ??
        DEFAULT_MAX_ASSERTED_QUADS,
      pendingInsertions: prepared.insertions.length,
    });
    inferencePlan = planInference({
      assertedBefore,
      deletions: prepared.deletions,
      insertions: prepared.insertions,
      graphs: inference.graphs,
    });
  }

  if (deletionQuadIds.size > 0) {
    await stageChunked(
      batchExecutor,
      [...deletionQuadIds],
      lookupChunkSize,
      (chunk) => [buildDeleteQuadsByQuadIds(chunk, worldId)],
    );
  }

  if (inferencePlan && inferencePlan.derivedToRemove.length > 0) {
    await stageChunked(
      batchExecutor,
      hashQuads(inferencePlan.derivedToRemove),
      lookupChunkSize,
      (chunk) => [buildDeleteDerivedQuadsByQuadIds(chunk, worldId)],
    );
  }

  await stageNovelInsertions(
    {
      batchExecutor,
      lookupChunkSize,
      worldId,
      inferenceEnabled: inference !== undefined,
    },
    novelInsertions,
    novelQuadIds,
  );

  let derivedInserted = 0;
  if (inferencePlan) {
    derivedInserted = await stageDerivedRows(
      batchExecutor,
      worldId,
      inferencePlan,
    );
  }

  await batchExecutor.flush();

  return {
    novelInsertions,
    novelQuadIds,
    ...(inferencePlan && {
      inference: {
        derivedInserted,
        derivedRemoved: inferencePlan.derivedToRemove.length,
        inconsistencies: inferencePlan.inconsistencies,
      },
    }),
  };
}
