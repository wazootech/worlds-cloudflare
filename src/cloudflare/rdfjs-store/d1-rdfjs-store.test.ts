import { assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import type * as rdfjs from "@rdfjs/types";
import { collectQuadsFromStream } from "@worlds/sdk/quad-store";
import { D1RdfjsStore } from "./mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";

const { namedNode, literal, blankNode } = DataFactory;

async function createTestD1Store(): Promise<
  { store: D1RdfjsStore; dispose(): Promise<void> }
> {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({ connection: substrate.connection });
  await store.ensureSchema();
  return { store, dispose: substrate.dispose };
}

// ──────────────────────────────────────────────────
// match() read tests
// ──────────────────────────────────────────────────

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

Deno.test("D1RdfjsStore.addQuad - persists and refreshes size", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    assertEquals(store.size, 0);
    store.addQuad(namedNode("urn:a"), namedNode("urn:p"), literal("o"));
    await store.flush();
    assertEquals(store.size, 1);
    assertEquals(await store.countQuads(), 1);
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.addQuad - content-addressed insert is idempotent", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const quad = DataFactory.quad(
      namedNode("urn:a"),
      namedNode("urn:p"),
      literal("o"),
    );
    store.addQuad(quad);
    await store.flush();
    store.addQuad(quad);
    await store.flush();
    assertEquals(store.size, 1);
    assertEquals(await store.countQuads(), 1);
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.removeQuad - deletes the quad and refreshes size", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const quad = DataFactory.quad(
      namedNode("urn:a"),
      namedNode("urn:p"),
      literal("o"),
    );
    store.addQuad(quad);
    await store.flush();
    assertEquals(store.size, 1);

    store.removeQuad(quad);
    await store.flush();
    assertEquals(store.size, 0);
    assertEquals(await store.countQuads(), 0);
  } finally {
    await dispose();
  }
});

// ──────────────────────────────────────────────────
// createTransaction() — one batch per commit
// ──────────────────────────────────────────────────

Deno.test("D1RdfjsStore.createTransaction - commit persists the patch", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const transaction = store.createTransaction();
    transaction.add(DataFactory.quad(
      namedNode("urn:a"),
      namedNode("urn:p"),
      literal("o1"),
    ));
    transaction.add(DataFactory.quad(
      namedNode("urn:b"),
      namedNode("urn:p"),
      literal("o2"),
    ));
    await transaction.commit();
    await store.flush();

    assertEquals(await store.countQuads(), 2);
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.createTransaction - rollback discards buffered writes", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const transaction = store.createTransaction();
    transaction.add(DataFactory.quad(
      namedNode("urn:a"),
      namedNode("urn:p"),
      literal("o1"),
    ));
    transaction.rollback();
    await store.flush();

    assertEquals(await store.countQuads(), 0);
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.createTransaction - add then delete of same quad nets to nothing", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const quad = DataFactory.quad(
      namedNode("urn:a"),
      namedNode("urn:p"),
      literal("o"),
    );
    const transaction = store.createTransaction();
    transaction.add(quad);
    transaction.delete(quad);
    await transaction.commit();
    await store.flush();

    assertEquals(await store.countQuads(), 0);
  } finally {
    await dispose();
  }
});

// ──────────────────────────────────────────────────
// applyPatch() / deleteGraph() / removeMatches()
// ──────────────────────────────────────────────────

Deno.test("D1RdfjsStore.applyPatch - merge inserts and deletes in one batch", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    await store.applyPatch({
      insertions: [
        DataFactory.quad(namedNode("urn:a"), namedNode("urn:p"), literal("o1")),
        DataFactory.quad(namedNode("urn:b"), namedNode("urn:p"), literal("o2")),
      ],
      deletions: [],
    });
    assertEquals(await store.countQuads(), 2);

    await store.applyPatch({
      insertions: [],
      deletions: [
        DataFactory.quad(namedNode("urn:a"), namedNode("urn:p"), literal("o1")),
      ],
    });
    assertEquals(await store.countQuads(), 1);
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.applyPatch - replace mode clears before insert", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    await store.applyPatch({
      insertions: [
        DataFactory.quad(namedNode("urn:a"), namedNode("urn:p"), literal("o1")),
      ],
      deletions: [],
    });

    await store.applyPatch(
      {
        insertions: [
          DataFactory.quad(
            namedNode("urn:c"),
            namedNode("urn:p"),
            literal("o3"),
          ),
        ],
        deletions: [],
      },
      { importMode: "replace" },
    );

    assertEquals(await store.countQuads(), 1);
    const results = await collectQuadsFromStream(
      store.match(namedNode("urn:c"), null, null, null),
    );
    assertEquals(results.length, 1);
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.deleteGraph - removes every quad in the named graph", async () => {
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
      namedNode("urn:g1"),
    );
    store.addQuad(
      namedNode("urn:c"),
      namedNode("urn:p"),
      literal("o3"),
      namedNode("urn:g2"),
    );
    await store.flush();
    assertEquals(await store.countQuads(), 3);

    const removed = await collectQuadsFromStream(store.deleteGraph("urn:g1"));
    assertEquals(removed.length, 2);
    assertEquals(await store.countQuads(), 1);
    assertEquals(
      await store.countQuads(null, null, null, namedNode("urn:g2")),
      1,
    );
  } finally {
    await dispose();
  }
});

Deno.test("D1RdfjsStore.removeMatches - deletes and streams matching quads", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:p1"), literal("o1"));
    store.addQuad(namedNode("urn:a"), namedNode("urn:p2"), literal("o2"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:p3"), literal("o3"));
    await store.flush();

    const removed = await collectQuadsFromStream(
      store.removeMatches(namedNode("urn:a"), null, null, null),
    );
    assertEquals(removed.length, 2);
    assertEquals(await store.countQuads(), 1);
  } finally {
    await dispose();
  }
});

// ──────────────────────────────────────────────────
// Large patches cross the 10-quads-per-statement boundary
// ──────────────────────────────────────────────────

Deno.test("D1RdfjsStore.applyPatch - 25 inserts chunk across insert statements", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const insertions: rdfjs.Quad[] = [];
    for (let index = 0; index < 25; index++) {
      insertions.push(DataFactory.quad(
        namedNode(`urn:s${index}`),
        namedNode("urn:p"),
        literal(`o${index}`),
      ));
    }
    await store.applyPatch({ insertions, deletions: [] });
    assertEquals(await store.countQuads(), 25);
  } finally {
    await dispose();
  }
});
