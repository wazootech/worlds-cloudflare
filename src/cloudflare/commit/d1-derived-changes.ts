import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import {
  hashQuads,
  isReplaceImportCommit,
  preparePatch,
} from "@worlds/sdk/quad-store";
import type { InsertQuadRow } from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { buildInsertRow } from "@/cloudflare/d1/d1-quad-row.ts";
import type { D1CommitDriverOptions } from "./d1-commit-driver.ts";
import type { InferenceOptions } from "@/cloudflare/d1-client-base-options.ts";
import { planInference } from "@/cloudflare/inference/inference-planner.ts";
import {
  DEFAULT_MAX_ASSERTED_QUADS,
  InferenceSizeGuardError,
  loadAssertedQuads,
} from "@/cloudflare/inference/load-asserted-quads.ts";

/** D1DerivedChanges is the change to a world's inferred rows that one commit causes. */
export interface D1DerivedChanges {
  /** removeIds are the content hashes of inferred rows that are no longer entailed. */
  removeIds: string[];

  /** addRows are the inferred rows to write; an asserted row is never replaced by one. */
  addRows: InsertQuadRow[];
}

/**
 * planD1DerivedChanges reasons over the world's asserted quads before the
 * commit writes anything, so a size-guard failure leaves the world untouched.
 * A replace import wipes the world first, so nothing existing counts.
 */
export async function planD1DerivedChanges(
  patch: Patch,
  context: TransactionContext | undefined,
  inference: InferenceOptions,
  driverOptions: D1CommitDriverOptions,
): Promise<D1DerivedChanges> {
  const prepared = preparePatch(patch, driverOptions);
  const maxAssertedQuads = inference.maxAssertedQuads ??
    DEFAULT_MAX_ASSERTED_QUADS;
  const replacing = isReplaceImportCommit(context);
  if (replacing && prepared.insertions.length > maxAssertedQuads) {
    throw new InferenceSizeGuardError(
      prepared.insertions.length,
      maxAssertedQuads,
    );
  }
  const plan = planInference({
    assertedBefore: replacing ? [] : await loadAssertedQuads(
      driverOptions.connection,
      {
        worldId: driverOptions.worldId,
        maxAssertedQuads,
        pendingInsertions: prepared.insertions.length,
      },
    ),
    deletions: prepared.deletions,
    insertions: prepared.insertions,
    graphs: inference.graphs,
  });
  const addRows = new Map<string, InsertQuadRow>();
  const derived = [...plan.derivedToAdd, ...plan.entailedDeletions];
  const derivedIds = hashQuads(derived);
  derived.forEach((quad, index) => {
    const id = derivedIds[index]!;
    if (!addRows.has(id)) {
      addRows.set(id, {
        ...buildInsertRow(quad, id),
        world_id: driverOptions.worldId,
        derived: 1,
      });
    }
  });
  return {
    removeIds: hashQuads(plan.derivedToRemove),
    addRows: [...addRows.values()],
  };
}
