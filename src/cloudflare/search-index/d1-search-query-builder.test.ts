import assert from "node:assert/strict";
import test from "node:test";
import {
  D1SearchQueryBuilder,
  sanitizeFtsQuery,
} from "./d1-search-query-builder.ts";

const builder = new D1SearchQueryBuilder(32);

test("sanitizeFtsQuery - strips stopwords and punctuation, lowercases", () => {
  assert.deepStrictEqual(
    sanitizeFtsQuery("Ethan is the Explorer!"),
    '"ethan" "explorer"',
  );
  assert.deepStrictEqual(builder.sanitizeFtsQuery("!!!"), "");
  assert.deepStrictEqual(
    sanitizeFtsQuery('quote "phrase"'),
    '"quote" "phrase"',
  );
});

test("constructor - validates vectorDimensions bounds", () => {
  assert.deepStrictEqual(new D1SearchQueryBuilder(1).vectorDimensions, 1);
  assert.deepStrictEqual(new D1SearchQueryBuilder(1536).vectorDimensions, 1536);
  let threw = false;
  try {
    new D1SearchQueryBuilder(1537);
  } catch {
    threw = true;
  }
  assert.deepStrictEqual(threw, true);
});

test("buildSearchQuery - keyword plan with filters and stable arg order", () => {
  const plan = builder.buildSearchQuery(
    { query: "needle", include: { graphs: ["urn:g"] } },
    { limit: 5 },
  );
  assert.deepStrictEqual(plan.sql.includes("chunks_fts MATCH ?"), true);
  assert.deepStrictEqual(plan.sql.includes("chunks.graph IN (?)"), true);
  assert.deepStrictEqual(
    plan.sql.includes("JOIN chunks ON chunks.chunk_id = fts_matches.rowid"),
    true,
  );
  assert.deepStrictEqual(plan.sql.includes("chunks.id"), false);
  // Match expression, candidate limit, filter binds, then the final limit.
  assert.deepStrictEqual(plan.args, ['"needle"', 5, "urn:g", 5]);
});

test("buildSearchQuery - reciprocal rank fusion scoring present", () => {
  const plan = builder.buildSearchQuery({ query: "needle" }, { limit: 10 });
  assert.deepStrictEqual(
    plan.sql.includes("1.0 / (60 + fts_matches.rank_number)"),
    true,
  );
});

test("buildSearchQuery - empty or tokenless query falls back to no-match statement", () => {
  const empty = builder.buildSearchQuery({ query: "" }, { limit: 10 });
  assert.deepStrictEqual(empty.sql.includes("WHERE 0 = 1"), true);
  assert.deepStrictEqual(empty.args, []);

  const punct = builder.buildSearchQuery({ query: "???" }, { limit: 10 });
  assert.deepStrictEqual(punct.sql.includes("WHERE 0 = 1"), true);
});

test("buildInsertChunk - binds vector blob or null for future Vectorize sync", () => {
  const withVector = builder.buildInsertChunk({
    quad_id: "q1",
    subject: "s",
    predicate: "p",
    graph: "",
    value: "v",
    fts_value: "v",
    vector: new Float32Array([1, 2]),
  });
  assert.deepStrictEqual(withVector.args?.length, 7);
  assert.deepStrictEqual(withVector.args?.[6] instanceof Uint8Array, true);

  const withoutVector = builder.buildInsertChunk({
    quad_id: "q1",
    subject: "s",
    predicate: "p",
    graph: "",
    value: "v",
    fts_value: "v",
  });
  assert.deepStrictEqual(withoutVector.args?.[6], null);
});

test("buildDeleteByQuadIds - content-addressed deletion sweep", () => {
  const statement = builder.buildDeleteByQuadIds(["q1", "q2"]);
  assert.deepStrictEqual(statement.sql.includes("quad_id IN (?, ?)"), true);
  assert.deepStrictEqual(statement.args, ["q1", "q2"]);
});
