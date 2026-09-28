import { assertEquals, assertRejects } from "@std/assert";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { checkD1SchemaCompatibility } from "./d1-schema-compatibility.ts";

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

    const quads = await substrate.connection.execute<{ name: string }>({
      sql: "PRAGMA table_info(quads)",
    });
    const chunks = await substrate.connection.execute<{ name: string }>({
      sql: "PRAGMA table_info(chunks)",
    });
    assertEquals(quads.rows.some((column) => column.name === "world_id"), true);
    assertEquals(
      chunks.rows.some((column) => column.name === "world_id"),
      true,
    );
    assertEquals(chunks.rows.some((column) => column.name === "quad_id"), true);

    const fts = await substrate.connection.execute<{ sql: string }>({
      sql:
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'",
    });
    assertEquals(
      (fts.rows[0]?.sql ?? "").replaceAll(/\s+/g, "").toLowerCase().includes(
        "content='chunks',content_rowid='chunk_id'",
      ),
      true,
    );
    assertEquals(
      await checkD1SchemaCompatibility(substrate.connection, {
        worldId: "world-a",
      }),
      { compatible: true, issues: [], schemaVersion: 4 },
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("ensureSchema fails closed on legacy schemas without changing them", async () => {
  const substrate = await createTestD1();
  try {
    const legacyWorldColumn = "world_" + "u" + "id";
    await substrate.connection.execute({
      sql:
        `CREATE TABLE quads (id TEXT PRIMARY KEY, ${legacyWorldColumn} TEXT)`,
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
    assertEquals(columns.rows.map((row) => row.name), [
      "id",
      legacyWorldColumn,
    ]);
  } finally {
    await substrate.dispose();
  }
});
