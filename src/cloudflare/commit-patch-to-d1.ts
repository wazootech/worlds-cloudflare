import type * as rdfjs from "@rdfjs/types";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import {
  filterQuads,
  hashQuads,
  isReplaceImportCommit,
} from "@worlds/sdk/quad-store";
import {
  D1BatchExecutor,
  DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
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
  queryCachePresence,
  stageChunked,
  stageDerivedRows,
  stageNovelInsertions,
} from "./commit-patch-to-d1-helpers.ts";

export type {
  CommitPatchToD1Options,
  CommitPatchToD1Result,
} from "./commit-patch-to-d1-types.ts";

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
  // The documented cap is host parameters per statement; world-scoped
  // statements also bind world_id, so reserve one slot for it.
  const lookupChunkSize = Math.max(
    1,
    (maxLookupChunkSize ?? 100) - (worldId ? 1 : 0),
  );
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
  }

  let derivedInserted = 0;
  if (plan) {
    derivedInserted = await stageDerivedRows(batchExecutor, worldId, plan);
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
