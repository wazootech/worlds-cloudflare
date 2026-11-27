import assert from "node:assert/strict";
import test from "node:test";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import {
  BLOB_BYTE_WEIGHT,
  d1StatementWeight,
  DEFAULT_D1_MAX_BATCH_WEIGHT,
} from "@/cloudflare/d1/d1-statement-weight.ts";
import { buildInsertRow } from "@/cloudflare/d1/d1-quad-row.ts";
import { buildBulkInsertQuads } from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";

const { namedNode, literal, quad } = DataFactory;
const TEXT = "x".repeat(200);

/** chunkStatement is the chunk-row insert an import writes, at `dims` dimensions. */
function chunkStatement(dims: number) {
  return new D1SearchQueryBuilder(dims, { worldId: "w" }).buildInsertChunk({
    quad_id: "a".repeat(64),
    subject: "urn:s",
    predicate: "urn:p",
    graph: "",
    value: TEXT,
    fts_value: TEXT,
    vector: new Float32Array(dims),
    world_id: "w",
  });
}

/** quadStatement is the quad-row insert an import writes. */
function quadStatement() {
  const row = buildInsertRow(
    quad(namedNode("urn:s"), namedNode("urn:p"), literal("v")),
    "b".repeat(64),
  );
  return buildBulkInsertQuads([{ ...row, world_id: "w" }])[0]!;
}

test("the estimator charges BLOBs 4 bytes each, strings by length, scalars a few bytes", () => {
  const base = d1StatementWeight({ sql: "S", args: [] });
  const bytes = d1StatementWeight({ sql: "S", args: [new Uint8Array(100)] });
  assert.deepStrictEqual(bytes - base, 100 * BLOB_BYTE_WEIGHT);
  const buffer = d1StatementWeight({ sql: "S", args: [new ArrayBuffer(10)] });
  assert.deepStrictEqual(buffer - base, 10 * BLOB_BYTE_WEIGHT);
  assert.deepStrictEqual(
    d1StatementWeight({ sql: "S", args: ["abcd"] }) - base,
    6,
  );
  const scalars = d1StatementWeight({ sql: "S", args: [1, null, true] });
  assert.ok(scalars - base > 0 && scalars - base < 64);
  assert.deepStrictEqual(d1StatementWeight({ sql: "S" }), base);
});

test("a 1,536-dim chunk statement estimates 18-40 KB, a 384-dim one 4.5-10 KB", () => {
  const heavy = d1StatementWeight(chunkStatement(1536));
  const light = d1StatementWeight(chunkStatement(384));
  assert.ok(heavy >= 18_000 && heavy <= 40_000, `1536-dim: ${heavy}`);
  assert.ok(light >= 4_500 && light <= 10_000, `384-dim: ${light}`);
  // The estimate errs high: measured, a 1,536-dim chunk row serialized to about 22 KB.
  assert.ok(heavy > 22_100);
});

test("2,000 heavy chunk statements exceed the default budget; 2,000 mixed 384-dim ones do not", () => {
  const heavy = 2000 * d1StatementWeight(chunkStatement(1536));
  assert.ok(heavy > DEFAULT_D1_MAX_BATCH_WEIGHT, `heavy: ${heavy}`);
  const mixed384 =
    1000 * d1StatementWeight(chunkStatement(384)) +
    1000 * d1StatementWeight(quadStatement());
  assert.ok(mixed384 < DEFAULT_D1_MAX_BATCH_WEIGHT, `mixed 384: ${mixed384}`);
});

test("the estimate is never below the serialized sizes measured on real D1", () => {
  const chunk = d1StatementWeight(chunkStatement(1536));
  const row = d1StatementWeight(quadStatement());
  // README measurements (serialized MB, taken as 1e6 bytes), accepted and rejected.
  assert.ok(1500 * chunk >= 33_400_000, "1,500 chunk rows");
  assert.ok(1510 * chunk >= 33_600_000, "1,510 chunk rows");
  assert.ok(2000 * chunk >= 44_500_000, "2,000 chunk rows");
  assert.ok(1000 * chunk + 1000 * row >= 22_700_000, "2,000 mixed rows");
  assert.ok(2000 * chunk + 2000 * row >= 45_300_000, "4,000 mixed rows");
});

test("the 16 MiB default keeps 2x headroom under the 32 MiB RPC limit", () => {
  assert.deepStrictEqual(DEFAULT_D1_MAX_BATCH_WEIGHT * 2, 32 * 1024 * 1024);
});
