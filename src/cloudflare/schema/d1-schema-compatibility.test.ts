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
        "CREATE TABLE worlds_data_plane_schema (schema_version_id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
    });
    await substrate.connection.execute({
      sql:
        "INSERT INTO worlds_data_plane_schema (version, applied_at) VALUES (3, datetime('now'))",
    });
    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(report, {
      compatible: true,
      issues: [],
      schemaVersion: 3,
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
      sql: "CREATE TABLE quads (id TEXT PRIMARY KEY, quad_id TEXT)",
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
    assertEquals(
      partial.issues.some((issue) =>
        issue.detail === "expected primary key quad_id, found id"
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
        "CREATE TABLE worlds_data_plane_schema (schema_version_id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
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
        issue.detail === "expected schema version 3, found 99"
      ),
      true,
    );
    await assertRejects(
      () =>
        assertD1SchemaCompatible(substrate.connection, { worldId: "world-a" }),
      Error,
      "expected schema version 3, found 99",
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema compatibility treats an unstamped version as not yet verified", async () => {
  const substrate = await createTestD1();
  try {
    const builder = new D1SchemaBuilder(32, { worldId: "world-a" });
    for (const ddl of builder.buildTables()) {
      await substrate.connection.execute({ sql: ddl });
    }
    await substrate.connection.execute({
      sql:
        "CREATE TABLE worlds_data_plane_schema (schema_version_id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
    });

    // The version row is written only after verification passes, so an empty
    // version table with otherwise-correct columns is a database mid-bring-up,
    // not a version mismatch.
    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(report, { compatible: true, issues: [], schemaVersion: null });
  } finally {
    await substrate.dispose();
  }
});

Deno.test("ensureSchema does not stamp a version for a database it could not verify", async () => {
  const substrate = await createTestD1();
  try {
    // Build the schema without a world column, then open a world-scoped store
    // against it. CREATE TABLE IF NOT EXISTS cannot add the missing column, so
    // verification must fail.
    const builder = new D1SchemaBuilder(32);
    for (const ddl of builder.buildTables()) {
      await substrate.connection.execute({ sql: ddl });
    }

    const store = new D1RdfjsStore({
      connection: substrate.connection,
      worldId: "world-a",
    });
    await assertRejects(
      () => store.ensureSchema(),
      Error,
      "quads: missing column world_id",
    );

    // The regression this guards: a database that failed verification must not
    // be recorded as holding the canonical schema. If it were, the version
    // check would pass on every later boot and the missing column would only
    // ever be caught by the per-table column probe.
    const stamped = await substrate.connection.execute<{ count: number }>({
      sql:
        "SELECT COUNT(*) AS count FROM worlds_data_plane_schema WHERE version = ?",
      args: [3],
    });
    assertEquals(Number(stamped.rows[0]?.count), 0);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("ensureSchema stamps the canonical version once verification passes", async () => {
  const substrate = await createTestD1();
  try {
    const store = new D1RdfjsStore({
      connection: substrate.connection,
      worldId: "world-a",
    });
    await store.ensureSchema();
    await store.ensureSchema();

    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(report, { compatible: true, issues: [], schemaVersion: 3 });

    const stamped = await substrate.connection.execute<{ count: number }>({
      sql:
        "SELECT COUNT(*) AS count FROM worlds_data_plane_schema WHERE version = ?",
      args: [3],
    });
    assertEquals(Number(stamped.rows[0]?.count), 1);
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
