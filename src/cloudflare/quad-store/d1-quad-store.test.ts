import { assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { D1QuadStore } from "./mod.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "@/cloudflare/search-index/d1-search-index-projector.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";

const { namedNode, literal, quad: createQuad, defaultGraph } = DataFactory;

async function createTestQuadStore(options?: {
  searchIndexOnImport?: "incremental" | "deferred" | "disabled";
}): Promise<{
  quadStore: D1QuadStore;
  store: D1RdfjsStore;
  searchQueryBuilder: D1SearchQueryBuilder;
  dispose(): Promise<void>;
}> {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({ connection: substrate.connection });
  await store.ensureSchema();

  const searchQueryBuilder = new D1SearchQueryBuilder(32);
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
  });
  const searchIndexProjector = new D1SearchIndexProjector({
    connection: substrate.connection,
    searchQueryBuilder,
    textSplitter,
  });
  const quadStore = new D1QuadStore({
    connection: substrate.connection,
    store,
    searchQueryBuilder,
    searchIndexProjector,
    searchIndexOnImport: options?.searchIndexOnImport,
  });

  return {
    quadStore,
    store,
    searchQueryBuilder,
    dispose: substrate.dispose,
  };
}

Deno.test("D1QuadStore - merge import adds quads without deleting existing", async () => {
  const { quadStore, store, dispose } = await createTestQuadStore();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(namedNode("urn:a"), namedNode("urn:p"), literal("one")),
        ],
      },
    });
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(namedNode("urn:a"), namedNode("urn:p"), literal("two")),
        ],
      },
    });

    const quads = await store.getQuads();
    assertEquals(quads.length, 2);
  } finally {
    await dispose();
  }
});

Deno.test("D1QuadStore - replace import wipes existing quads", async () => {
  const { quadStore, store, dispose } = await createTestQuadStore();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(namedNode("urn:a"), namedNode("urn:p"), literal("one")),
        ],
      },
    });
    await quadStore.import({
      mode: "replace",
      source: {
        kind: "quads",
        quads: [
          createQuad(namedNode("urn:b"), namedNode("urn:p"), literal("two")),
        ],
      },
    });

    const quads = await store.getQuads();
    assertEquals(quads.length, 1);
    assertEquals(quads[0].subject.value, "urn:b");
  } finally {
    await dispose();
  }
});

Deno.test("D1QuadStore - export returns the stored quads", async () => {
  const { quadStore, dispose } = await createTestQuadStore();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(namedNode("urn:a"), namedNode("urn:p"), literal("one")),
        ],
      },
    });

    const exported = await quadStore.export({ format: { kind: "quads" } });
    if (exported.kind !== "quads") {
      throw new Error("expected quad export");
    }
    assertEquals(exported.quads.length, 1);
    assertEquals(exported.quads[0].subject.value, "urn:a");
  } finally {
    await dispose();
  }
});

Deno.test("D1QuadStore - deferred import persists quads and reindexes search chunks", async () => {
  const { quadStore, store, dispose } = await createTestQuadStore({
    searchIndexOnImport: "deferred",
  });
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(
            namedNode("urn:sandra"),
            namedNode("urn:knows"),
            literal("Sandra leads the D1 migration"),
          ),
        ],
      },
    });

    const quads = await store.getQuads();
    assertEquals(quads.length, 1);
  } finally {
    await dispose();
  }
});

Deno.test("D1QuadStore - createTransaction commits an atomic patch", async () => {
  const { quadStore, store, dispose } = await createTestQuadStore({
    searchIndexOnImport: "disabled",
  });
  try {
    const transaction = quadStore.createTransaction();
    transaction.add(
      createQuad(
        namedNode("urn:alice"),
        namedNode("urn:knows"),
        namedNode("urn:bob"),
        defaultGraph(),
      ),
    );
    transaction.delete(
      createQuad(
        namedNode("urn:gone"),
        namedNode("urn:p"),
        literal("bye"),
        defaultGraph(),
      ),
    );
    await transaction.commit({ importMode: "merge" });

    const quads = await store.getQuads();
    assertEquals(quads.length, 1);
    assertEquals(quads[0].subject.value, "urn:alice");
  } finally {
    await dispose();
  }
});
