import { assertEquals, assertRejects } from "@std/assert";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  assertD1SchemaCompatible,
  checkD1SchemaCompatibility,
} from "./d1-schema-compatibility.ts";
import { D1SchemaBuilder } from "./d1-schema-builder.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";

Deno.test("D1 schema compatibility accepts the generated schema", async () => {
  const substrate = await createTestD1();
  try {
    const builder = new D1SchemaBuilder(32, { worldId: "world-a" });
    for (const ddl of builder.buildTables()) {
      await substrate.connection.execute({ sql: ddl });
    }
    await substrate.connection.execute({
      sql:
        "CREATE TABLE worlds_data_plane_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    });
    await substrate.connection.execute({
      sql:
        "INSERT INTO worlds_data_plane_schema (version, applied_at) VALUES (2, datetime('now'))",
    });
    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(report, {
      compatible: true,
      issues: [],
      schemaVersion: 2,
    });
    await assertD1SchemaCompatible(substrate.connection, {
      worldId: "world-a",
    });
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema compatibility reports missing tables and columns", async () => {
  const substrate = await createTestD1();
  try {
    const report = await checkD1SchemaCompatibility(substrate.connection);
    assertEquals(report.compatible, false);
    assertEquals(
      report.issues.some((issue) => issue.detail === "missing table"),
      true,
    );

    await substrate.connection.execute({
      sql: "CREATE TABLE quads (id TEXT PRIMARY KEY)",
    });
    const partial = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(
      partial.issues.some((issue) => issue.detail === "missing column s"),
      true,
    );
    assertEquals(
      partial.issues.some((issue) =>
        issue.detail === "missing column world_id"
      ),
      true,
    );
    await assertRejects(
      () =>
        assertD1SchemaCompatible(substrate.connection, { worldId: "world-a" }),
      Error,
      "quads: missing column",
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema compatibility rejects an unexpected schema version", async () => {
  const substrate = await createTestD1();
  try {
    const builder = new D1SchemaBuilder(32, { worldId: "world-a" });
    for (const ddl of builder.buildTables()) {
      await substrate.connection.execute({ sql: ddl });
    }
    await substrate.connection.execute({
      sql:
        "CREATE TABLE worlds_data_plane_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    });
    await substrate.connection.execute({
      sql:
        "INSERT INTO worlds_data_plane_schema (version, applied_at) VALUES (99, datetime('now'))",
    });

    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(report.compatible, false);
    assertEquals(
      report.issues.some((issue) =>
        issue.detail === "expected schema version 2, found 99"
      ),
      true,
    );
    await assertRejects(
      () =>
        assertD1SchemaCompatible(substrate.connection, { worldId: "world-a" }),
      Error,
      "expected schema version 2, found 99",
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema compatibility migrates a legacy v1 world_uid schema to world_id", async () => {
  const substrate = await createTestD1();
  try {
    const store = new D1RdfjsStore({ connection: substrate.connection });
    await store.ensureSchema();

    await substrate.connection.execute({
      sql: "ALTER TABLE quads ADD COLUMN world_uid TEXT",
    });
    await substrate.connection.execute({
      sql: "ALTER TABLE chunks ADD COLUMN world_uid TEXT",
    });

    const migrated = new D1RdfjsStore({
      connection: substrate.connection,
      worldId: "world-a",
    });
    await migrated.ensureSchema();

    const quadsColumns = await substrate.connection.execute<{ name: string }>({
      sql: "PRAGMA table_info(quads)",
    });
    const quadsNames = new Set(quadsColumns.rows.map((row) => row.name));
    assertEquals(quadsNames.has("world_id"), true, "quads has world_id");
    assertEquals(quadsNames.has("world_uid"), false, "quads lacks world_uid");

    const chunksColumns = await substrate.connection.execute<{ name: string }>({
      sql: "PRAGMA table_info(chunks)",
    });
    const chunksNames = new Set(chunksColumns.rows.map((row) => row.name));
    assertEquals(chunksNames.has("world_id"), true, "chunks has world_id");
    assertEquals(chunksNames.has("world_uid"), false, "chunks lacks world_uid");

    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(report.compatible, true);
    assertEquals(report.schemaVersion, 2);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema compatibility works through a fresh driver", async () => {
  const substrate = await createTestD1();
  try {
    const driver = new D1ConnectionDriver(substrate.database);
    const result = await driver.execute<{ name: string }>({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table'",
    });
    assertEquals(result.rows.length, 0);
  } finally {
    await substrate.dispose();
  }
});
