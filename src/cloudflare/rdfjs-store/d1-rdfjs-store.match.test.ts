import { assertEquals } from "@std/assert";
import type * as rdfjs from "@rdfjs/types";
import { collectQuadsFromStream } from "@worlds/sdk/quad-store";
import {
  blankNode,
  createTestD1Store,
  literal,
  namedNode,
} from "./d1-rdfjs-store-test-helpers.ts";

Deno.test("D1RdfjsStore.match - empty store returns empty stream", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const results = await collectQuadsFromStream(
      store.match(null, null, null, null),
    );
    assertEquals(results.length, 0);
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.match - all four terms bound returns exact quad", async () => {
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

    assertEquals(results.length, 1);
    assertEquals(results[0].subject.value, "urn:alice");
    assertEquals(results[0].subject.termType, "NamedNode");
    assertEquals(results[0].predicate.value, "urn:knows");
    assertEquals(results[0].object.value, "urn:bob");
    assertEquals(results[0].graph.value, "urn:graph1");
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.match - by subject only returns matching quads", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:p1"), literal("o1"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:p2"), literal("o2"));
    store.addQuad(namedNode("urn:a"), namedNode("urn:p3"), literal("o3"));
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(namedNode("urn:a"), null, null, null),
    );

    assertEquals(results.length, 2);
    for (const quad of results) {
      assertEquals(quad.subject.value, "urn:a");
    }
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.match - by predicate only", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:target"), literal("o1"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:other"), literal("o2"));
    store.addQuad(namedNode("urn:c"), namedNode("urn:target"), literal("o3"));
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(null, namedNode("urn:target"), null, null),
    );

    assertEquals(results.length, 2);
    for (const quad of results) {
      assertEquals(quad.predicate.value, "urn:target");
    }
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.match - by graph only uses GPSO index", async () => {
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

    assertEquals(results.length, 1);
    assertEquals(results[0].graph.value, "urn:g1");
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.match - by object only", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:p"), literal("target"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:p"), literal("other"));
    await store.flush();

    const results = await collectQuadsFromStream(
      store.match(null, null, literal("target"), null),
    );

    assertEquals(results.length, 1);
    assertEquals(results[0].object.value, "target");
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.match - disambiguates NamedNode vs BlankNode with same value", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("b1"), namedNode("urn:p"), literal("o1"));
    store.addQuad(blankNode("b1"), namedNode("urn:p"), literal("o2"));
    await store.flush();

    const namedResults = await collectQuadsFromStream(
      store.match(namedNode("b1"), null, null, null),
    );
    assertEquals(namedResults.length, 1);
    assertEquals(namedResults[0].subject.termType, "NamedNode");

    const blankResults = await collectQuadsFromStream(
      store.match(blankNode("b1"), null, null, null),
    );
    assertEquals(blankResults.length, 1);
    assertEquals(blankResults[0].subject.termType, "BlankNode");
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.match - literal with language tag", async () => {
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

    assertEquals(results.length, 1);
    assertEquals(results[0].object.value, "hola");
    assertEquals(
      (results[0].object as rdfjs.Literal).language,
      "es",
    );
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.match - pages across matchPageSize boundary without skips", async () => {
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
    assertEquals(results.length, 25);
    const subjects = new Set(results.map((quad) => quad.subject.value));
    assertEquals(subjects.size, 25);
  } finally {
    await dispose();
  }
});

// ──────────────────────────────────────────────────
// countQuads()
// ──────────────────────────────────────────────────

Deno.test("D1RdfjsStore.countQuads - counts matching quads", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:p1"), literal("o1"));
    store.addQuad(namedNode("urn:a"), namedNode("urn:p2"), literal("o2"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:p1"), literal("o3"));
    await store.flush();

    assertEquals(await store.countQuads(), 3);
    assertEquals(await store.countQuads(namedNode("urn:a")), 2);
    assertEquals(
      await store.countQuads(namedNode("urn:a"), namedNode("urn:p1")),
      1,
    );
    assertEquals(await store.countQuads(null, namedNode("urn:p1")), 2);
  } finally {
    await dispose();
  }
});

// ──────────────────────────────────────────────────
// Mutations: addQuad / removeQuad / size
// ──────────────────────────────────────────────────
