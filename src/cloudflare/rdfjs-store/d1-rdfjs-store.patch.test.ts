import assert from "node:assert/strict";
import test from "node:test";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import type * as rdfjs from "@rdfjs/types";
import { collectQuadsFromStream } from "@worlds/sdk/quad-store";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import {
  createTestD1Store,
  literal,
  namedNode,
} from "./d1-rdfjs-store-test-helpers.ts";
import { D1RdfjsStore } from "./mod.ts";

test("D1RdfjsStore.applyPatch - merge inserts and deletes in one batch", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    await store.applyPatch({
      insertions: [
        DataFactory.quad(namedNode("urn:a"), namedNode("urn:p"), literal("o1")),
        DataFactory.quad(namedNode("urn:b"), namedNode("urn:p"), literal("o2")),
      ],
      deletions: [],
    });
    assert.deepStrictEqual(await store.countQuads(), 2);

    await store.applyPatch({
      insertions: [],
      deletions: [
        DataFactory.quad(namedNode("urn:a"), namedNode("urn:p"), literal("o1")),
      ],
    });
    assert.deepStrictEqual(await store.countQuads(), 1);
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.applyPatch - world-scoped deletion of 100+ quads stays under the D1 param cap", async () => {
  // Regression for the world_id slot reservation: a world-scoped deletion
  // IN-list chunked at the default 100 plus the bound world_id exceeded D1's
  // 100 host parameters per statement.
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({
    connection: substrate.connection,
    worldId: "w1",
  });
  try {
    await store.ensureSchema();
    const quads = Array.from({ length: 120 }, (_, index) =>
      DataFactory.quad(
        namedNode(`urn:s${index}`),
        namedNode("urn:p"),
        literal(`o${index}`),
      ),
    );
    await store.applyPatch({ insertions: quads, deletions: [] });
    assert.deepStrictEqual(await store.countQuads(), 120);

    await store.applyPatch({ insertions: [], deletions: quads });
    assert.deepStrictEqual(await store.countQuads(), 0);
  } finally {
    await substrate.dispose();
  }
});

test("D1RdfjsStore.applyPatch - replace mode clears before insert", async () => {
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

    assert.deepStrictEqual(await store.countQuads(), 1);
    const results = await collectQuadsFromStream(
      store.match(namedNode("urn:c"), null, null, null),
    );
    assert.deepStrictEqual(results.length, 1);
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.deleteGraph - removes every quad in the named graph", async () => {
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
    assert.deepStrictEqual(await store.countQuads(), 3);

    const removed = await collectQuadsFromStream(store.deleteGraph("urn:g1"));
    assert.deepStrictEqual(removed.length, 2);
    assert.deepStrictEqual(await store.countQuads(), 1);
    assert.deepStrictEqual(
      await store.countQuads(null, null, null, namedNode("urn:g2")),
      1,
    );
  } finally {
    await dispose();
  }
});

test("D1RdfjsStore.removeMatches - deletes and streams matching quads", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    store.addQuad(namedNode("urn:a"), namedNode("urn:p1"), literal("o1"));
    store.addQuad(namedNode("urn:a"), namedNode("urn:p2"), literal("o2"));
    store.addQuad(namedNode("urn:b"), namedNode("urn:p3"), literal("o3"));
    await store.flush();

    const removed = await collectQuadsFromStream(
      store.removeMatches(namedNode("urn:a"), null, null, null),
    );
    assert.deepStrictEqual(removed.length, 2);
    assert.deepStrictEqual(await store.countQuads(), 1);
  } finally {
    await dispose();
  }
});

// ──────────────────────────────────────────────────
// Large patches cross the 10-quads-per-statement boundary
// ──────────────────────────────────────────────────

test("D1RdfjsStore.applyPatch - 25 inserts chunk across insert statements", async () => {
  const { store, dispose } = await createTestD1Store();
  try {
    const insertions: rdfjs.Quad[] = [];
    for (let index = 0; index < 25; index++) {
      insertions.push(
        DataFactory.quad(
          namedNode(`urn:s${index}`),
          namedNode("urn:p"),
          literal(`o${index}`),
        ),
      );
    }
    await store.applyPatch({ insertions, deletions: [] });
    assert.deepStrictEqual(await store.countQuads(), 25);
  } finally {
    await dispose();
  }
});
