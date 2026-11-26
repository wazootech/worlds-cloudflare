import assert from "node:assert/strict";
import test from "node:test";
import { rejected, thrown } from "../../../../test/thrown.ts";
import { VectorizeVectorSearchIndex } from "./vectorize-vector-search-index.ts";
import type { VectorizeIndexLike } from "./vector-search-index.ts";
import { createCloudflareWorldsSdk } from "../../create-cloudflare-sdk.ts";

/**
 * InMemoryVectorize mimics one shared Vectorize index: ids are global, and a
 * query filter matches only vectors whose metadata equals every filter key.
 */
class InMemoryVectorize implements VectorizeIndexLike {
  public readonly vectors = new Map<
    string,
    { values: number[]; metadata: Record<string, string> }
  >();

  public query(
    _vector: number[],
    options?: { topK?: number; filter?: Record<string, string> },
  ) {
    const matches = [...this.vectors.entries()]
      .filter(([, vector]) =>
        Object.entries(options?.filter ?? {}).every(([key, value]) =>
          vector.metadata[key] === value
        )
      )
      .slice(0, options?.topK ?? 10)
      .map(([id, vector]) => ({ id, score: 0.9, metadata: vector.metadata }));
    return Promise.resolve({ matches, count: matches.length });
  }

  public upsert(
    vectors: Array<
      { id: string; values: number[]; metadata?: Record<string, string> }
    >,
  ) {
    for (const vector of vectors) {
      this.vectors.set(vector.id, {
        values: vector.values,
        metadata: vector.metadata ?? {},
      });
    }
    return Promise.resolve();
  }

  public deleteByIds(ids: string[]) {
    for (const id of ids) this.vectors.delete(id);
    return Promise.resolve();
  }
}

const WORLD_A = "w_00000000-0000-4000-8000-00000000000a";
const WORLD_B = "w_00000000-0000-4000-8000-00000000000b";
const RESULT_ID = "q2.same-triple-text-in-both-worlds";
const entry = (metadata: Record<string, string> = {}) => ({
  id: RESULT_ID,
  vector: new Float32Array([0.1, 0.2]),
  metadata: { subject: "urn:s", predicate: "urn:p", value: "v", ...metadata },
});

test("vectorize index refuses to exist without a worldId (#41)", () => {
  const index = new InMemoryVectorize();
  for (const worldId of [undefined, ""]) {
    thrown(
      () =>
        new VectorizeVectorSearchIndex({
          index,
          worldId: worldId as unknown as string,
        }),
      Error,
      "requires a worldId",
    );
  }
});

test("every upsert is stamped with world_id and the contract result id", async () => {
  const index = new InMemoryVectorize();
  await new VectorizeVectorSearchIndex({ index, worldId: WORLD_A }).upsert([
    entry(),
  ]);
  const [[physicalId, stored]] = [...index.vectors.entries()];
  assert.deepStrictEqual(stored.metadata.world_id, WORLD_A);
  assert.deepStrictEqual(stored.metadata.result_id, RESULT_ID);
  assert.ok(physicalId !== RESULT_ID, "physical id is namespaced by world");
  assert.ok(physicalId.length <= 64, "fits Vectorize's 64-byte id limit");
});

test("identical triple text in two worlds does not collide", async () => {
  const index = new InMemoryVectorize();
  const a = new VectorizeVectorSearchIndex({ index, worldId: WORLD_A });
  const b = new VectorizeVectorSearchIndex({ index, worldId: WORLD_B });
  await a.upsert([entry()]);
  await b.upsert([entry()]);
  assert.deepStrictEqual(
    index.vectors.size,
    2,
    "both worlds keep their vector",
  );

  await b.deleteByIds([RESULT_ID]);
  assert.deepStrictEqual(
    index.vectors.size,
    1,
    "B's delete leaves A's vector alone",
  );
  const hits = await a.query([0.1, 0.2], { topK: 5 });
  assert.deepStrictEqual(hits.map((hit) => hit.id), [RESULT_ID]);
});

test("queries are always world-scoped and return contract ids", async () => {
  const index = new InMemoryVectorize();
  const a = new VectorizeVectorSearchIndex({ index, worldId: WORLD_A });
  const b = new VectorizeVectorSearchIndex({ index, worldId: WORLD_B });
  await a.upsert([entry({ predicate: "urn:only-a" })]);

  assert.deepStrictEqual(await b.query([0.1, 0.2], { topK: 5 }), []);
  // A caller filter narrows within the world; it never replaces the scope.
  assert.deepStrictEqual(
    await b.query([0.1, 0.2], { topK: 5, filter: { subject: "urn:s" } }),
    [],
  );
  const hits = await a.query([0.1, 0.2], {
    topK: 5,
    filter: { subject: "urn:s" },
  });
  assert.deepStrictEqual(hits.length, 1);
  assert.deepStrictEqual(hits[0].id, RESULT_ID);
});

test("a filter or entry naming another world is refused", async () => {
  const index = new InMemoryVectorize();
  const a = new VectorizeVectorSearchIndex({ index, worldId: WORLD_A });
  await rejected(
    () => a.query([0.1], { topK: 1, filter: { world_id: WORLD_B } }),
    Error,
    "scoped to",
  );
  await rejected(
    () => a.upsert([entry({ world_id: WORLD_B })]),
    Error,
    "scoped to",
  );
  assert.deepStrictEqual(index.vectors.size, 0);
});

test("createCloudflareWorldsSdk rejects vectorize without worldId", async () => {
  await rejected(
    () =>
      createCloudflareWorldsSdk({
        database: {} as never,
        vectorize: new InMemoryVectorize(),
      }),
    Error,
    "worldId is required when vectorize is set",
  );
});
