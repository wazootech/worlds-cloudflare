import assert from "node:assert/strict";
import test from "node:test";
import type { ReindexRequest } from "@worlds/sdk/search-index";
import {
  createHybridContext,
  createQuad,
  literal,
  namedNode,
} from "./cloudflare-search-index-hybrid-test-helpers.ts";

const gA = namedNode("urn:scope:gA");
const gB = namedNode("urn:scope:gB");
const pX = namedNode("urn:scope:pX");
const pY = namedNode("urn:scope:pY");
const s = (name: string) => namedNode(`urn:scope:${name}`);

type Column = "graph" | "predicate";

/** fixture seeds two graphs and two predicates, fully indexed (FTS and vectors). */
async function fixture() {
  const ctx = await createHybridContext();
  await ctx.quadStore.import({
    source: {
      kind: "quads",
      quads: [
        createQuad(s("a1"), pX, literal("alpha one"), gA),
        createQuad(s("a2"), pY, literal("alpha two"), gA),
        createQuad(s("b1"), pX, literal("beta one"), gB),
        createQuad(s("b2"), pY, literal("beta two"), gB),
      ],
    },
  });
  assert.deepStrictEqual(ctx.vectorSearch.size, 4);
  return ctx;
}

type Ctx = Awaited<ReturnType<typeof fixture>>;

async function count(ctx: Ctx, where = "1 = 1", ...args: string[]) {
  const { rows } = await ctx.connection.execute({
    sql: `SELECT COUNT(*) AS n FROM chunks WHERE ${where}`,
    args,
  });
  return Number(rows[0]!.n);
}

/** tamper marks the chunk rows of one graph/predicate so refresh or survival is observable. */
function tamper(ctx: Ctx, column: Column, value: string) {
  return ctx.connection.execute({
    sql: `UPDATE chunks SET value = 'stale' WHERE ${column} = ?`,
    args: [value],
  });
}

async function scopedCase(
  request: ReindexRequest,
  inScope: [Column, string],
  outScope: [Column, string],
) {
  const ctx = await fixture();
  try {
    await tamper(ctx, ...inScope);
    await tamper(ctx, ...outScope);
    const report = await ctx.searchIndex.reindex(request);
    assert.deepStrictEqual(
      report.processedQuadCount,
      4,
      "every scanned quad counts",
    );
    assert.deepStrictEqual(report.chunkRowCount, 2);
    assert.deepStrictEqual(
      await count(ctx, `${outScope[0]} = ? AND value = 'stale'`, outScope[1]),
      2,
      "out-of-scope chunk rows survive untouched",
    );
    assert.deepStrictEqual(
      await count(ctx, `${inScope[0]} = ? AND value = 'stale'`, inScope[1]),
      0,
      "in-scope chunk rows are refreshed",
    );
    assert.deepStrictEqual(
      await count(ctx),
      4,
      "no chunk row lost or duplicated",
    );
    assert.deepStrictEqual(
      ctx.vectorSearch.size,
      4,
      "out-of-scope vectors survive, in-scope ones are replaced",
    );
  } finally {
    await ctx.dispose();
  }
}

test("d1 reindex - include keeps out-of-scope chunk rows and refreshes in-scope", async () => {
  await scopedCase(
    { include: { graphs: [gA.value] } },
    ["graph", gA.value],
    ["graph", gB.value],
  );
});

test("d1 reindex - exclude keeps excluded chunk rows and refreshes the rest", async () => {
  await scopedCase(
    { exclude: { predicates: [pY.value] } },
    ["predicate", pX.value],
    ["predicate", pY.value],
  );
});

test("d1 reindex - a request with no criteria is unscoped and rebuilds everything", async () => {
  const ctx = await fixture();
  try {
    await tamper(ctx, "graph", gA.value);
    await tamper(ctx, "graph", gB.value);
    const report = await ctx.searchIndex.reindex({
      include: {},
      exclude: { graphs: [] },
    });
    assert.deepStrictEqual(report.processedQuadCount, 4);
    assert.deepStrictEqual(report.chunkRowCount, 4);
    assert.deepStrictEqual(await count(ctx, "value = 'stale'"), 0);
    assert.deepStrictEqual(await count(ctx), 4);
  } finally {
    await ctx.dispose();
  }
});

test("d1 reindex - unscoped reindex drops the stale chunk row of a deleted quad", async () => {
  const ctx = await fixture();
  try {
    await ctx.connection.execute({
      sql: "INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value) VALUES ('gone', 's', 'p', 'g', 'ghost', 'ghost')",
      args: [],
    });
    assert.deepStrictEqual(await count(ctx), 5);
    const report = await ctx.searchIndex.reindex();
    assert.deepStrictEqual(report.processedQuadCount, 4);
    assert.deepStrictEqual(report.chunkRowCount, 4);
    assert.deepStrictEqual(await count(ctx), 4);
    assert.deepStrictEqual(await count(ctx, "quad_id = 'gone'"), 0);
  } finally {
    await ctx.dispose();
  }
});
