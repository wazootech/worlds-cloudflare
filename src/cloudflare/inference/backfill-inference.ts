import type { Inconsistency } from "@wazoo/reasoner";
import type { D1DatabaseLike } from "@/cloudflare/d1/d1-connection-driver.ts";
import { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  D1BatchExecutor,
  DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
} from "@/cloudflare/d1/d1-batch-executor.ts";
import { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import {
  buildBulkInsertQuads,
  buildDeleteAllDerivedQuads,
  type InsertQuadRow,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { quadToInsertRow } from "@/cloudflare/d1/d1-quad-row.ts";
import {
  DEFAULT_MAX_ASSERTED_QUADS,
  loadAssertedQuads,
} from "@/cloudflare/inference/load-asserted-quads.ts";
import { planInference } from "@/cloudflare/inference/inference-planner.ts";
import type { InferenceOptions } from "@/cloudflare/d1-client-base-options.ts";

/** BackfillInferenceOptions selects the world and the reasoning settings. */
export interface BackfillInferenceOptions {
  /** database is the D1 binding. */
  database: D1DatabaseLike;

  /** worldId scopes the backfill to one world of a shared database. */
  worldId?: string;

  /** inference carries `graphs` and `maxAssertedQuads`, as for commits. */
  inference?: Pick<InferenceOptions, "graphs" | "maxAssertedQuads">;

  /** vectorDimensions matches the chunks table (default 1536). */
  vectorDimensions?: number;
}

/** BackfillInferenceReport says what a backfill did. */
export interface BackfillInferenceReport {
  /** assertedQuads is how many asserted quads the reasoner read. */
  assertedQuads: number;

  /** derivedWritten is how many inferred rows exist after the backfill. */
  derivedWritten: number;

  /** derivedRemoved is how many inferred rows were cleared first. */
  derivedRemoved: number;

  /** inconsistencies are the OWL 2 RL `false` rules the data violates. */
  inconsistencies: Inconsistency[];
}

/**
 * backfillInference materializes inference for a world that already holds
 * data, which enabling `inference` alone does not do (it only reacts to later
 * writes). It reads every asserted quad, runs the reasoner once, clears the
 * world's inferred rows, and writes the closure. Asserted rows are never
 * touched, and the size guard (`maxAssertedQuads`) applies before any write.
 *
 * It is idempotent. The clear and the writes are separate D1 batches, so a
 * failure part way leaves a subset of the inferred rows: run it again.
 */
export async function backfillInference(
  options: BackfillInferenceOptions,
): Promise<BackfillInferenceReport> {
  const { worldId } = options;
  const connection = new D1ConnectionDriver(options.database, { worldId });
  // Fails closed when the database has no quads.derived column.
  await new D1RdfjsStore({
    connection,
    schemaBuilder: new D1SchemaBuilder(options.vectorDimensions ?? 1536, {
      worldId,
    }),
    worldId,
    requireDerivedColumn: true,
  }).ensureSchema();

  const asserted = await loadAssertedQuads(connection, {
    worldId,
    maxAssertedQuads: options.inference?.maxAssertedQuads ??
      DEFAULT_MAX_ASSERTED_QUADS,
    pendingInsertions: 0,
  });
  const plan = planInference({
    assertedBefore: [],
    deletions: [],
    insertions: asserted,
    graphs: options.inference?.graphs,
  });

  const before = await connection.execute<{ count: number }>({
    sql: `SELECT COUNT(*) AS count FROM quads WHERE derived = 1${
      worldId ? " AND world_id = ?" : ""
    }`,
    args: worldId ? [worldId] : [],
  });

  const executor = new D1BatchExecutor({
    connection,
    writeBatchSize: DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
  });
  await executor.stage([buildDeleteAllDerivedQuads(worldId)]);
  await executor.flush();

  // OR IGNORE keeps an asserted row asserted when the closure re-derives it.
  const rows: InsertQuadRow[] = [];
  const seen = new Set<string>();
  for (const quad of plan.derivedToAdd) {
    const row = await quadToInsertRow(quad);
    if (seen.has(row.quad_id)) continue;
    seen.add(row.quad_id);
    rows.push({ ...row, world_id: worldId, derived: 1 });
  }
  await executor.stage(buildBulkInsertQuads(rows, { orIgnore: true }));
  await executor.flush();

  const after = await connection.execute<{ count: number }>({
    sql: `SELECT COUNT(*) AS count FROM quads WHERE derived = 1${
      worldId ? " AND world_id = ?" : ""
    }`,
    args: worldId ? [worldId] : [],
  });
  return {
    assertedQuads: asserted.length,
    derivedWritten: Number(after.rows[0]?.count ?? 0),
    derivedRemoved: Number(before.rows[0]?.count ?? 0),
    inconsistencies: plan.inconsistencies,
  };
}
