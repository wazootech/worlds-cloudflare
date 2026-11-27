import assert from "node:assert/strict";
import test from "node:test";
import { thrown } from "../../../../test/thrown.ts";
import {
  checkVectorizeIndex,
  DEFAULT_VECTORIZE_DIMENSIONS,
  planVectorizeProvisioning,
  VECTORIZE_FILTERABLE_PROPERTY,
} from "./vectorize-provisioning.ts";

const NAME = "worlds-api-qa-v1-metadata";
const good = { name: NAME, config: { dimensions: 1536, metric: "cosine" } };
const worldIdIndex = [{ propertyName: "world_id", indexType: "string" }];

test("plan creates the index then registers world_id before any write", () => {
  assert.deepStrictEqual(planVectorizeProvisioning({ name: NAME }), [
    `wrangler vectorize create ${NAME} --dimensions ${DEFAULT_VECTORIZE_DIMENSIONS} --metric cosine`,
    `wrangler vectorize create-metadata-index ${NAME} --propertyName world_id --type string`,
  ]);
});

test("plan honors explicit dimensions and rejects bad input", () => {
  assert.ok(
    planVectorizeProvisioning({ name: NAME, dimensions: 512 })[0].includes(
      "--dimensions 512",
    ),
  );
  thrown(() => planVectorizeProvisioning({ name: "Bad Name" }));
  thrown(() => planVectorizeProvisioning({ name: NAME, dimensions: 0 }));
});

test("a conforming index has no problems", () => {
  assert.deepStrictEqual(
    checkVectorizeIndex({ name: NAME }, good, worldIdIndex),
    [],
  );
  // snake_case rows (REST API shape) are accepted too.
  assert.deepStrictEqual(
    checkVectorizeIndex({ name: NAME }, good, [
      { property_name: "world_id", index_type: "string" },
    ]),
    [],
  );
});

test("wrangler's capitalized property type is accepted", () => {
  assert.deepStrictEqual(
    checkVectorizeIndex({ name: NAME }, good, [
      { propertyName: "world_id", indexType: "String" },
    ]),
    [],
  );
});

test("a missing index fails loudly with the provisioning commands", () => {
  const [problem, ...rest] = checkVectorizeIndex({ name: NAME }, undefined, []);
  assert.deepStrictEqual(rest, []);
  assert.ok(problem.includes("does not exist"));
  assert.ok(problem.includes(`wrangler vectorize create ${NAME}`));
});

test("missing world_id metadata index is reported", () => {
  const problems = checkVectorizeIndex({ name: NAME }, good, [
    { propertyName: "other", indexType: "string" },
  ]);
  assert.deepStrictEqual(problems.length, 1);
  assert.ok(problems[0].includes(VECTORIZE_FILTERABLE_PROPERTY));
  assert.ok(problems[0].includes("create-metadata-index"));
});

test("wrong dimensions, metric and property type are each reported", () => {
  const problems = checkVectorizeIndex(
    { name: NAME },
    { name: NAME, config: { dimensions: 512, metric: "euclidean" } },
    [{ propertyName: "world_id", indexType: "number" }],
  );
  assert.deepStrictEqual(problems.length, 3);
});
