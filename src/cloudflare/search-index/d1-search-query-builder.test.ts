import { assertEquals } from "@std/assert";
import {
  D1SearchQueryBuilder,
  sanitizeFtsQuery,
} from "./d1-search-query-builder.ts";

const builder = new D1SearchQueryBuilder(32);

Deno.test("sanitizeFtsQuery - strips stopwords and punctuation, lowercases", () => {
  assertEquals(
    sanitizeFtsQuery("Ethan is the Explorer!"),
    '"ethan" "explorer"',
  );
  assertEquals(builder.sanitizeFtsQuery("!!!"), "");
  assertEquals(
    sanitizeFtsQuery('quote "phrase"'),
    '"quote" "phrase"',
  );
});

Deno.test("constructor - validates vectorDimensions bounds", () => {
  assertEquals(new D1SearchQueryBuilder(1).vectorDimensions, 1);
  assertEquals(new D1SearchQueryBuilder(1536).vectorDimensions, 1536);
  let threw = false;
  try {
    new D1SearchQueryBuilder(1537);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildSearchQuery - keyword plan with filters and stable arg order", () => {
  const plan = builder.buildSearchQuery(
    { query: "needle", include: { graphs: ["urn:g"] } },
    { limit: 5 },
  );
  assertEquals(plan.sql.includes("chunks_fts MATCH ?"), true);
  assertEquals(plan.sql.includes("chunks.graph IN (?)"), true);
  assertEquals(
    plan.sql.includes("JOIN chunks ON chunks.id = fts_matches.rowid"),
    true,
  );
  // Match expression, candidate limit, filter binds, then the final limit.
  assertEquals(plan.args, ['"needle"', 5, "urn:g", 5]);
});

Deno.test("buildSearchQuery - reciprocal rank fusion scoring present", () => {
  const plan = builder.buildSearchQuery({ query: "needle" }, { limit: 10 });
  assertEquals(
    plan.sql.includes("1.0 / (60 + fts_matches.rank_number)"),
    true,
  );
});

Deno.test("buildSearchQuery - empty or tokenless query falls back to no-match statement", () => {
  const empty = builder.buildSearchQuery({ query: "" }, { limit: 10 });
  assertEquals(empty.sql.includes("WHERE 0 = 1"), true);
  assertEquals(empty.args, []);

  const punct = builder.buildSearchQuery({ query: "???" }, { limit: 10 });
  assertEquals(punct.sql.includes("WHERE 0 = 1"), true);
});

Deno.test("buildInsertChunk - binds vector blob or null for future Vectorize sync", () => {
  const withVector = builder.buildInsertChunk({
    quad_id: "q1",
    subject: "s",
    predicate: "p",
    graph: "",
    value: "v",
    fts_value: "v",
    vector: new Float32Array([1, 2]),
  });
  assertEquals(withVector.args?.length, 7);
  assertEquals(withVector.args?.[6] instanceof Uint8Array, true);

  const withoutVector = builder.buildInsertChunk({
    quad_id: "q1",
    subject: "s",
    predicate: "p",
    graph: "",
    value: "v",
    fts_value: "v",
  });
  assertEquals(withoutVector.args?.[6], null);
});

Deno.test("buildDeleteByQuadIds - content-addressed deletion sweep", () => {
  const statement = builder.buildDeleteByQuadIds(["q1", "q2"]);
  assertEquals(statement.sql.includes("quad_id IN (?, ?)"), true);
  assertEquals(statement.args, ["q1", "q2"]);
});
