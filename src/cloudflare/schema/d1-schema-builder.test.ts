import { assertEquals, assertThrows } from "@std/assert";
import { D1SchemaBuilder } from "./d1-schema-builder.ts";

const testSchemaBuilder = new D1SchemaBuilder(768);

Deno.test("buildIndexes - returns 7 covering index DDL statements", () => {
  const indexes = testSchemaBuilder.buildIndexes();
  assertEquals(indexes.length, 7);

  const subjectFirstQuadPatternIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_spog")
  );
  assertEquals(
    subjectFirstQuadPatternIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_spog ON quads(s, p, o, g)",
  );

  const sopgIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_sopg")
  );
  assertEquals(
    sopgIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_sopg ON quads(s, o, p, g)",
  );

  const psoIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_pso")
  );
  assertEquals(
    psoIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_pso ON quads(p, s, o)",
  );

  const posIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_pos")
  );
  assertEquals(
    posIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_pos ON quads(p, o, s)",
  );

  const ospgIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_ospg")
  );
  assertEquals(
    ospgIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_ospg ON quads(o, s, p, g)",
  );

  const opsgIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_opsg")
  );
  assertEquals(
    opsgIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_opsg ON quads(o, p, s, g)",
  );

  const gpsoIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_gpso")
  );
  assertEquals(
    gpsoIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_gpso ON quads(g, p, s, o)",
  );
});

Deno.test("buildTables - returns quads and chunks DDL in dependency order", () => {
  const tables = testSchemaBuilder.buildTables();
  assertEquals(tables.length, 2);
  assertEquals(tables[0]!.includes("CREATE TABLE IF NOT EXISTS quads"), true);
  assertEquals(tables[1]!.includes("CREATE TABLE IF NOT EXISTS chunks"), true);
});

Deno.test("quads table - 10-column libsql reference shape", () => {
  const ddl = testSchemaBuilder.buildD1QuadsTable();
  for (
    const column of [
      "id TEXT PRIMARY KEY",
      "s TEXT NOT NULL",
      "s_type TEXT NOT NULL",
      "p TEXT NOT NULL",
      "o TEXT NOT NULL",
      "o_type TEXT NOT NULL",
      "o_datatype TEXT",
      "o_lang TEXT",
      "g TEXT NOT NULL",
      "g_type TEXT NOT NULL",
    ]
  ) {
    assertEquals(ddl.includes(column), true, `expected ${column} in:\n${ddl}`);
  }
});

Deno.test("chunks table - F32_BLOB vector column is dimension-aware", () => {
  const ddl = new D1SchemaBuilder(768).buildD1ChunksTable();
  assertEquals(ddl.includes("vector F32_BLOB(768)"), true);

  const smallDdl = new D1SchemaBuilder(384).buildD1ChunksTable();
  assertEquals(smallDdl.includes("vector F32_BLOB(384)"), true);
});

Deno.test("constructor - validates vectorDimensions bounds", () => {
  assertThrows(() => new D1SchemaBuilder(0));
  assertThrows(() => new D1SchemaBuilder(1537));
  assertThrows(() => new D1SchemaBuilder(NaN));
});

Deno.test("constructor - accepts boundary dimensions", () => {
  assertEquals(new D1SchemaBuilder(1).vectorDimensions, 1);
  assertEquals(new D1SchemaBuilder(1536).vectorDimensions, 1536);
});

Deno.test("FTS5 - external-content table and sync triggers are D1-safe", () => {
  const fts = testSchemaBuilder.buildD1ChunksFtsTable();
  assertEquals(
    fts.includes("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5"),
    true,
  );
  assertEquals(fts.includes("content='chunks'"), true);
  assertEquals(fts.includes("content_rowid='id'"), true);

  const triggers = testSchemaBuilder.buildD1ChunksTriggers();
  assertEquals(triggers.length, 2);
  assertEquals(triggers[0]!.includes("chunks_ai AFTER INSERT ON chunks"), true);
  assertEquals(triggers[1]!.includes("chunks_ad AFTER DELETE ON chunks"), true);
});
