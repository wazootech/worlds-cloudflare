import assert from "node:assert/strict";
import test from "node:test";
import { thrown } from "../../../test/thrown.ts";
import { D1SchemaBuilder } from "./d1-schema-builder.ts";

const testSchemaBuilder = new D1SchemaBuilder(768);

test("buildIndexes - returns 7 covering index DDL statements", () => {
  const indexes = testSchemaBuilder.buildIndexes();
  assert.deepStrictEqual(indexes.length, 7);

  const subjectFirstQuadPatternIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_spog")
  );
  assert.deepStrictEqual(
    subjectFirstQuadPatternIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_spog ON quads(s, p, o, g)",
  );

  const sopgIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_sopg")
  );
  assert.deepStrictEqual(
    sopgIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_sopg ON quads(s, o, p, g)",
  );

  const psoIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_pso")
  );
  assert.deepStrictEqual(
    psoIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_pso ON quads(p, s, o)",
  );

  const posIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_pos")
  );
  assert.deepStrictEqual(
    posIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_pos ON quads(p, o, s)",
  );

  const ospgIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_ospg")
  );
  assert.deepStrictEqual(
    ospgIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_ospg ON quads(o, s, p, g)",
  );

  const opsgIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_opsg")
  );
  assert.deepStrictEqual(
    opsgIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_opsg ON quads(o, p, s, g)",
  );

  const gpsoIndex = indexes.find((statement: string) =>
    statement.includes("idx_quads_gpso")
  );
  assert.deepStrictEqual(
    gpsoIndex,
    "CREATE INDEX IF NOT EXISTS idx_quads_gpso ON quads(g, p, s, o)",
  );
});

test("buildTables - returns quads and chunks DDL in dependency order", () => {
  const tables = testSchemaBuilder.buildTables();
  assert.deepStrictEqual(tables.length, 2);
  assert.deepStrictEqual(
    tables[0]!.includes("CREATE TABLE IF NOT EXISTS quads"),
    true,
  );
  assert.deepStrictEqual(
    tables[1]!.includes("CREATE TABLE IF NOT EXISTS chunks"),
    true,
  );
});

test("quads table - 10-column libsql reference shape", () => {
  const ddl = testSchemaBuilder.buildD1QuadsTable();
  for (
    const column of [
      "quad_id TEXT PRIMARY KEY",
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
    assert.deepStrictEqual(
      ddl.includes(column),
      true,
      `expected ${column} in:\n${ddl}`,
    );
  }
});

test("chunks table - entity-specific primary key and dimension-aware vector column", () => {
  const ddl = new D1SchemaBuilder(768).buildD1ChunksTable();
  assert.deepStrictEqual(
    ddl.includes("chunk_id INTEGER PRIMARY KEY AUTOINCREMENT"),
    true,
  );
  assert.deepStrictEqual(ddl.includes("vector F32_BLOB(768)"), true);

  const smallDdl = new D1SchemaBuilder(384).buildD1ChunksTable();
  assert.deepStrictEqual(smallDdl.includes("vector F32_BLOB(384)"), true);
});

test("constructor - validates vectorDimensions bounds", () => {
  thrown(() => new D1SchemaBuilder(0));
  thrown(() => new D1SchemaBuilder(1537));
  thrown(() => new D1SchemaBuilder(NaN));
});

test("constructor - accepts boundary dimensions", () => {
  assert.deepStrictEqual(new D1SchemaBuilder(1).vectorDimensions, 1);
  assert.deepStrictEqual(new D1SchemaBuilder(1536).vectorDimensions, 1536);
});

test("FTS5 - external-content table and sync triggers are D1-safe", () => {
  const fts = testSchemaBuilder.buildD1ChunksFtsTable();
  assert.deepStrictEqual(
    fts.includes("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5"),
    true,
  );
  assert.deepStrictEqual(fts.includes("content='chunks'"), true);
  assert.deepStrictEqual(fts.includes("content_rowid='chunk_id'"), true);

  const triggers = testSchemaBuilder.buildD1ChunksTriggers();
  assert.deepStrictEqual(triggers.length, 2);
  assert.deepStrictEqual(
    triggers[0]!.includes("chunks_ai AFTER INSERT ON chunks"),
    true,
  );
  assert.deepStrictEqual(
    triggers[1]!.includes("chunks_ad AFTER DELETE ON chunks"),
    true,
  );
});
