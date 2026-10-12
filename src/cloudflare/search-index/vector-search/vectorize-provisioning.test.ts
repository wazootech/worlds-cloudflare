import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  checkVectorizeIndex,
  DEFAULT_VECTORIZE_DIMENSIONS,
  planVectorizeProvisioning,
  VECTORIZE_FILTERABLE_PROPERTY,
} from "./vectorize-provisioning.ts";

const NAME = "worlds-api-qa-v1-metadata";
const good = { name: NAME, config: { dimensions: 1536, metric: "cosine" } };
const worldIdIndex = [{ propertyName: "world_id", indexType: "string" }];

Deno.test("plan creates the index then registers world_id before any write", () => {
  assertEquals(planVectorizeProvisioning({ name: NAME }), [
    `wrangler vectorize create ${NAME} --dimensions ${DEFAULT_VECTORIZE_DIMENSIONS} --metric cosine`,
    `wrangler vectorize create-metadata-index ${NAME} --propertyName world_id --type string`,
  ]);
});

Deno.test("plan honors explicit dimensions and rejects bad input", () => {
  assert(
    planVectorizeProvisioning({ name: NAME, dimensions: 512 })[0].includes(
      "--dimensions 512",
    ),
  );
  assertThrows(() => planVectorizeProvisioning({ name: "Bad Name" }));
  assertThrows(() => planVectorizeProvisioning({ name: NAME, dimensions: 0 }));
});

Deno.test("a conforming index has no problems", () => {
  assertEquals(checkVectorizeIndex({ name: NAME }, good, worldIdIndex), []);
  // snake_case rows (REST API shape) are accepted too.
  assertEquals(
    checkVectorizeIndex({ name: NAME }, good, [
      { property_name: "world_id", index_type: "string" },
    ]),
    [],
  );
});

Deno.test("a missing index fails loudly with the provisioning commands", () => {
  const [problem, ...rest] = checkVectorizeIndex({ name: NAME }, undefined, []);
  assertEquals(rest, []);
  assert(problem.includes("does not exist"));
  assert(problem.includes(`wrangler vectorize create ${NAME}`));
});

Deno.test("missing world_id metadata index is reported", () => {
  const problems = checkVectorizeIndex({ name: NAME }, good, [
    { propertyName: "other", indexType: "string" },
  ]);
  assertEquals(problems.length, 1);
  assert(problems[0].includes(VECTORIZE_FILTERABLE_PROPERTY));
  assert(problems[0].includes("create-metadata-index"));
});

Deno.test("wrong dimensions, metric and property type are each reported", () => {
  const problems = checkVectorizeIndex(
    { name: NAME },
    { name: NAME, config: { dimensions: 512, metric: "euclidean" } },
    [{ propertyName: "world_id", indexType: "number" }],
  );
  assertEquals(problems.length, 3);
});
