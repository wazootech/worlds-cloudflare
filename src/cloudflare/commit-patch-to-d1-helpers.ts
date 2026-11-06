import { D1BatchExecutor } from "@/cloudflare/d1/d1-batch-executor.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  buildBulkInsertQuads,
  buildDeleteQuadsByQuadIds,
  buildSelectExistingQuadIds,
  buildWipeAllGraphDataStatements,
  type InsertQuadRow,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { quadToInsertRow } from "@/cloudflare/d1/d1-quad-row.ts";
import type { InferencePlan } from "@/cloudflare/inference/inference-planner.ts";
import type * as rdfjs from "@rdfjs/types";

/**
 * executeReplaceImportWipe clears all quads and search chunks before a replace-mode import commit.
 */
export async function executeReplaceImportWipe(
  connection: D1ConnectionDriver,
  writeBatchSize: number,
  worldId?: string,
): Promise<void> {
  const executor = new D1BatchExecutor({ connection, writeBatchSize });
  await executor.stage(buildWipeAllGraphDataStatements(worldId));
  await executor.flush();
}

export async function stageChunked(
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

export async function queryCachePresence(
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

/** StageNovelInsertionsContext is the commit state stageNovelInsertions reads. */
export interface StageNovelInsertionsContext {
  batchExecutor: D1BatchExecutor;
  lookupChunkSize: number;
  worldId?: string;
  inferenceEnabled: boolean;
}

/** stageNovelInsertions stages delete-then-insert statements for the novel quads. */
export async function stageNovelInsertions(
  ctx: StageNovelInsertionsContext,
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
): Promise<void> {
  if (novelQuadIds.length > 0) {
    await stageChunked(
      ctx.batchExecutor,
      novelQuadIds,
      ctx.lookupChunkSize,
      (chunk) => [buildDeleteQuadsByQuadIds(chunk, ctx.worldId)],
    );

    const novelRows: InsertQuadRow[] = [];
    for (let index = 0; index < novelInsertions.length; index++) {
      novelRows.push(await quadToInsertRow(novelInsertions[index]!));
    }
    await ctx.batchExecutor.stage(
      buildBulkInsertQuads(
        novelRows.map((row) => ({
          ...row,
          world_id: ctx.worldId,
          ...(ctx.inferenceEnabled && { derived: 0 as const }),
        })),
      ),
    );
  }
}

/** stageDerivedRows stages the inferred rows (OR IGNORE) and returns how many were staged. */
export async function stageDerivedRows(
  batchExecutor: D1BatchExecutor,
  worldId: string | undefined,
  plan: InferencePlan,
): Promise<number> {
  // OR IGNORE: a quad that is asserted (now or already) stays asserted.
  const derivedRows: InsertQuadRow[] = [];
  const seen = new Set<string>();
  for (const quad of [...plan.derivedToAdd, ...plan.entailedDeletions]) {
    const row = await quadToInsertRow(quad);
    if (seen.has(row.quad_id)) continue;
    seen.add(row.quad_id);
    derivedRows.push({ ...row, world_id: worldId, derived: 1 });
  }
  await batchExecutor.stage(
    buildBulkInsertQuads(derivedRows, { orIgnore: true }),
  );
  return derivedRows.length;
}
