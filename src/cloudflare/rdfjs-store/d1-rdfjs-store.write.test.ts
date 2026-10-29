import { assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import {
  createTestD1Store,
  literal,
  namedNode,
} from "./d1-rdfjs-store-test-helpers.ts";

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
