import { assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import type * as rdfjs from "@rdfjs/types";
import { collectQuadsFromStream } from "@worlds/sdk/quad-store";
import {
  createTestD1Store,
  literal,
  namedNode,
} from "./d1-rdfjs-store-test-helpers.ts";

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
