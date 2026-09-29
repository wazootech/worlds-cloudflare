import { assertEquals, assertRejects } from "@std/assert";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  assertD1SchemaCompatible,
  checkD1SchemaCompatibility,
} from "./d1-schema-compatibility.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";

Deno.test("runtime D1 DDL uses canonical primary and reference columns", async () => {
  const substrate = await createTestD1();
  try {
    const store = new D1RdfjsStore({
      connection: substrate.connection,
      worldId: "world-a",
    });
    await store.ensureSchema();

    for (
      const [table, expectedKey] of [
        ["quads", "quad_id"],
        ["chunks", "chunk_id"],
        ["worlds_data_plane_schema", "schema_version_id"],
      ]
    ) {
      const columns = await substrate.connection.execute<{
        name: string;
        pk: number;
      }>({ sql: `PRAGMA table_info(${table})` });
      assertEquals(
        columns.rows.filter((column) => column.pk > 0).map((column) =>
          column.name
        ),
        [expectedKey],
        `${table} primary key`,
      );
      assertEquals(columns.rows.some((column) => column.name === "id"), false);
    }

    const quadsColumns = await substrate.connection.execute<{ name: string }>({
      sql: "PRAGMA table_info(quads)",
    });
    const chunksColumns = await substrate.connection.execute<{ name: string }>({
      sql: "PRAGMA table_info(chunks)",
    });
    assertEquals(
      quadsColumns.rows.map((column) => column.name).includes("world_id"),
      true,
    );
    assertEquals(
      chunksColumns.rows.map((column) => column.name).includes("world_id"),
      true,
    );
    assertEquals(
      chunksColumns.rows.map((column) => column.name).includes("quad_id"),
      true,
    );

    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(report, {
      compatible: true,
      issues: [],
      schemaVersion: 4,
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
      sql: "CREATE TABLE quads (quad_id TEXT PRIMARY KEY)",
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

Deno.test("D1 schema compatibility rejects an incomplete version table before stamping", async () => {
  const substrate = await createTestD1();
  try {
    await substrate.connection.execute({
      sql:
        "CREATE TABLE worlds_data_plane_schema (schema_version_id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE)",
    });
    await substrate.connection.execute({
      sql: "INSERT INTO worlds_data_plane_schema (version) VALUES (4)",
    });

    const report = await checkD1SchemaCompatibility(substrate.connection);
    assertEquals(report.compatible, false);
    assertEquals(
      report.issues.some((issue) =>
        issue.table === "worlds_data_plane_schema" &&
        issue.detail === "missing column applied_at"
      ),
      true,
    );
    await assertRejects(
      () =>
        new D1RdfjsStore({ connection: substrate.connection }).ensureSchema(),
      Error,
      "worlds_data_plane_schema: missing column applied_at",
    );

    const versions = await substrate.connection.execute<{ count: number }>({
      sql: "SELECT COUNT(*) AS count FROM worlds_data_plane_schema",
    });
    assertEquals(Number(versions.rows[0]?.count), 1);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema compatibility rejects an unexpected schema version", async () => {
  const substrate = await createTestD1();
  try {
    const store = new D1RdfjsStore({
      connection: substrate.connection,
      worldId: "world-a",
    });
    await store.ensureSchema();
    await substrate.connection.execute({
      sql: "UPDATE worlds_data_plane_schema SET version = 99",
    });

    const report = await checkD1SchemaCompatibility(substrate.connection, {
      worldId: "world-a",
    });
    assertEquals(report.compatible, false);
    assertEquals(
      report.issues.some((issue) =>
        issue.detail === "expected schema version 4, found 99"
      ),
      true,
    );
    await assertRejects(
      () =>
        assertD1SchemaCompatible(substrate.connection, { worldId: "world-a" }),
      Error,
      "expected schema version 4, found 99",
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1 schema initialization fails closed on legacy table layouts", async () => {
  const substrate = await createTestD1();
  try {
    await substrate.connection.execute({
      sql: "CREATE TABLE quads (id TEXT PRIMARY KEY, world_uid TEXT)",
    });

    const store = new D1RdfjsStore({
      connection: substrate.connection,
      worldId: "world-a",
    });
    await assertRejects(
      () => store.ensureSchema(),
      Error,
      "D1 schema is incompatible",
    );

    const tables = await substrate.connection.execute<{ name: string }>({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    });
    assertEquals(
      tables.rows
        .map((row) => row.name)
        .filter((name) => !name.startsWith("_cf_")),
      ["quads"],
    );
    const columns = await substrate.connection.execute<{ name: string }>({
      sql: "PRAGMA table_info(quads)",
    });
    assertEquals(columns.rows.map((row) => row.name), ["id", "world_uid"]);
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
