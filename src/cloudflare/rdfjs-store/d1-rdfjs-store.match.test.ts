import assert from "node:assert/strict";
import test from "node:test";
import type * as rdfjs from "@rdfjs/types";
import { collectQuadsFromStream } from "@worlds/sdk/quad-store";
import {
  blankNode,
  createTestD1Store,
  literal,
  namedNode,
} from "./d1-rdfjs-store-test-helpers.ts";

test("D1RdfjsStore.match - empty store returns empty stream", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const results = await collectQuadsFromStream(
      store.match(null, null, null, null),
    );
    assert.deepStrictEqual(results.length, 0);
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.match - all four terms bound returns exact quad", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(
      namedNode("urn:alice"),
      namedNode("urn:knows"),
      namedNode("urn:bob"),
      namedNode("urn:graph1"),
    );
    await store.flush();

    const results = await collectQuadsFromStream(store.match(
      namedNode("urn:alice"),
      namedNode("urn:knows"),
      namedNode("urn:bob"),
      namedNode("urn:graph1"),
    ));

    assert.deepStrictEqual(results.length, 1);
    assert.deepStrictEqual(results[0].subject.value, "urn:alice");
    assert.deepStrictEqual(results[0].subject.termType, "NamedNode");
    assert.deepStrictEqual(results[0].predicate.value, "urn:knows");
    assert.deepStrictEqual(results[0].object.value, "urn:bob");
    assert.deepStrictEqual(results[0].graph.value, "urn:graph1");
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.match - by subject only returns matching quads", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:p1"), literal("o1"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:p2"), literal("o2"));
    store.addQuad(namedNode("urn:a"), namedNode("urn:p3"), literal("o3"));
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(namedNode("urn:a"), null, null, null),
    );

    assert.deepStrictEqual(results.length, 2);
    for (const quad of results) {
      assert.deepStrictEqual(quad.subject.value, "urn:a");
    }
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.match - by predicate only", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:target"), literal("o1"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:other"), literal("o2"));
    store.addQuad(namedNode("urn:c"), namedNode("urn:target"), literal("o3"));
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(null, namedNode("urn:target"), null, null),
    );

    assert.deepStrictEqual(results.length, 2);
    for (const quad of results) {
      assert.deepStrictEqual(quad.predicate.value, "urn:target");
    }
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.match - by graph only uses GPSO index", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(
      namedNode("urn:a"),
      namedNode("urn:p"),
      literal("o1"),
      namedNode("urn:g1"),
    );
    store.addQuad(
      namedNode("urn:b"),
      namedNode("urn:p"),
      literal("o2"),
      namedNode("urn:g2"),
    );
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(null, null, null, namedNode("urn:g1")),
    );

    assert.deepStrictEqual(results.length, 1);
    assert.deepStrictEqual(results[0].graph.value, "urn:g1");
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.match - by object only", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:p"), literal("target"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:p"), literal("other"));
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(null, null, literal("target"), null),
    );

    assert.deepStrictEqual(results.length, 1);
    assert.deepStrictEqual(results[0].object.value, "target");
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.match - disambiguates NamedNode vs BlankNode with same value", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("b1"), namedNode("urn:p"), literal("o1"));
    store.addQuad(blankNode("b1"), namedNode("urn:p"), literal("o2"));
    await store.flush();

    const namedResults = await collectQuadsFromStream(
      store.match(namedNode("b1"), null, null, null),
    );
    assert.deepStrictEqual(namedResults.length, 1);
    assert.deepStrictEqual(namedResults[0].subject.termType, "NamedNode");

    const blankResults = await collectQuadsFromStream(
      store.match(blankNode("b1"), null, null, null),
    );
    assert.deepStrictEqual(blankResults.length, 1);
    assert.deepStrictEqual(blankResults[0].subject.termType, "BlankNode");
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.match - literal with language tag", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(
      namedNode("urn:s"),
      namedNode("urn:p"),
      literal("hola", "es"),
    );
    store.addQuad(
      namedNode("urn:s"),
      namedNode("urn:p"),
      literal("hello", "en"),
    );
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(null, null, literal("hola", "es"), null),
    );

    assert.deepStrictEqual(results.length, 1);
    assert.deepStrictEqual(results[0].object.value, "hola");
    assert.deepStrictEqual(
      (results[0].object as rdfjs.Literal).language,
      "es",
    );
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.match - pages across matchPageSize boundary without skips", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    for (let index = 0; index < 25; index++) {
      store.addQuad(
        namedNode(`urn:s${index}`),
        namedNode("urn:p"),
        literal(`o${index}`),
      );
    }
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(null, null, null, null),
    );
    assert.deepStrictEqual(results.length, 25);
    const subjects = new Set(results.map((quad) => quad.subject.value));
    assert.deepStrictEqual(subjects.size, 25);
  } finally {
    await dispose();
  }
});

// ──────────────────────────────────────────────────
// countQuads()
// ──────────────────────────────────────────────────

test("D1RdfjsStore.countQuads - counts matching quads", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:p1"), literal("o1"));
    store.addQuad(namedNode("urn:a"), namedNode("urn:p2"), literal("o2"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:p1"), literal("o3"));
    await store.flush();

    assert.deepStrictEqual(await store.countQuads(), 3);
    assert.deepStrictEqual(await store.countQuads(namedNode("urn:a")), 2);
    assert.deepStrictEqual(
      await store.countQuads(namedNode("urn:a"), namedNode("urn:p1")),
      1,
    );
    assert.deepStrictEqual(
      await store.countQuads(null, namedNode("urn:p1")),
      2,
    );
  } finally {
    await dispose();
  }
});

// ──────────────────────────────────────────────────
// Mutations: addQuad / removeQuad / size
// ──────────────────────────────────────────────────
