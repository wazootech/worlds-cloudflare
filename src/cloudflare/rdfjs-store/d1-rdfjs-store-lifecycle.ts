import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import {
  assertD1SchemaCompatible,
  D1_DATA_PLANE_SCHEMA_VERSION,
} from "@/cloudflare/schema/d1-schema-compatibility.ts";

/** D1SchemaLifecycleOptions scopes the schema verification. */
export interface D1SchemaLifecycleOptions {
  worldId?: string;
  requireDerivedColumn: boolean;
}

/**
 * applyD1Schema creates the quads/chunks tables, covering indexes, and the
 * FTS5 external-content table + triggers (idempotent), then stamps and
 * verifies the data-plane schema version.
 *
 * Statements run through the prepared-statement path (not exec()) because
 * D1's script executor splits on newlines, which would truncate the
 * shared sql-core emitters' multi-line DDL.
 */
export async function applyD1Schema(
  connection: D1ConnectionDriver,
  schemaBuilder: D1SchemaBuilder,
  options: D1SchemaLifecycleOptions,
): Promise<void> {
  const existingTables = await connection.execute<{ name: string }>({
    sql:
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('quads', 'chunks', 'chunks_fts', 'worlds_data_plane_schema')",
  });
  if (existingTables.rows.length > 0) {
    await assertD1SchemaCompatible(connection, {
      worldId: options.worldId,
      requireDerivedColumn: options.requireDerivedColumn,
    });
  }

  const statements = [
    ...schemaBuilder.buildTables(),
    ...schemaBuilder.buildIndexes(),
    schemaBuilder.buildD1ChunksQuadIdIndex(),
    schemaBuilder.buildD1ChunksFtsTable(),
    ...schemaBuilder.buildD1ChunksTriggers(),
  ];
  for (const ddl of statements) {
    await connection.execute({ sql: ddl });
  }
  await connection.execute({
    sql:
      `CREATE TABLE IF NOT EXISTS worlds_data_plane_schema (schema_version_id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  });
  // Verify before stamping. The version row is the record that this database
  // holds the canonical schema, so it must only be written once the columns
  // have actually been confirmed. Stamping first would let a database that
  // failed verification pass every later boot on the version check alone.
  await assertD1SchemaCompatible(connection, {
    worldId: options.worldId,
    requireDerivedColumn: options.requireDerivedColumn,
  });
  await connection.execute({
    sql: "INSERT OR IGNORE INTO worlds_data_plane_schema (version) VALUES (?)",
    args: [D1_DATA_PLANE_SCHEMA_VERSION],
  });
  await assertD1SchemaCompatible(connection, {
    worldId: options.worldId,
    requireDerivedColumn: options.requireDerivedColumn,
  });
}

/** countD1Quads returns the row count of the quads table, scoped to worldId. */
export async function countD1Quads(
  connection: D1ConnectionDriver,
  worldId?: string,
): Promise<number> {
  const result = await connection.execute<{ count: number }>({
    sql: worldId
      ? "SELECT COUNT(*) AS count FROM quads WHERE world_id = ?"
      : "SELECT COUNT(*) AS count FROM quads",
    args: worldId ? [worldId] : [],
  });
  return Number(result.rows[0]?.count ?? 0);
}
