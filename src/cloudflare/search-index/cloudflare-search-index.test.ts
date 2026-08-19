import { assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { CloudflareSearchIndex } from "./mod.ts";
import { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "./d1-search-index-projector.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1QuadStore } from "@/cloudflare/quad-store/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";

const { namedNode, literal, quad: createQuad } = DataFactory;

interface TestSearchIndexContext {
  searchIndex: CloudflareSearchIndex;
  quadStore: D1QuadStore;
  connection: D1ConnectionDriver;
  store: D1RdfjsStore;
  searchQueryBuilder: D1SearchQueryBuilder;
  dispose(): Promise<void>;
}

async function createTestContext(): Promise<TestSearchIndexContext> {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({ connection: substrate.connection });
  await store.ensureSchema();

  const searchQueryBuilder = new D1SearchQueryBuilder(32);
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
  });
  const projector = new D1SearchIndexProjector({
    connection: substrate.connection,
    searchQueryBuilder,
    textSplitter,
  });
  const quadStore = new D1QuadStore({
    connection: substrate.connection,
    store,
    searchQueryBuilder,
    searchIndexProjector: projector,
    searchIndexOnImport: "incremental",
  });
  const searchIndex = new CloudflareSearchIndex({
    connection: substrate.connection,
    searchQueryBuilder,
    textSplitter,
  });

  return {
    searchIndex,
    quadStore,
    connection: substrate.connection,
    store,
    searchQueryBuilder,
    dispose: substrate.dispose,
  };
}

Deno.test("CloudflareSearchIndex - keyword search matches indexed literal text", async () => {
  const { searchIndex, quadStore, dispose } = await createTestContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(
            namedNode("urn:alice"),
            namedNode("urn:knows"),
            literal("Ethan runs the workspace"),
          ),
        ],
      },
    });

    const response = await searchIndex.search({ query: "Ethan" });
    assertEquals(response.results?.length, 1);
    assertEquals(response.results?.[0].subject, "urn:alice");
  } finally {
    await dispose();
  }
});

Deno.test("CloudflareSearchIndex - graph-scoped search excludes other graphs", async () => {
  const { searchIndex, quadStore, dispose } = await createTestContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(
            namedNode("urn:alice"),
            namedNode("urn:knows"),
            literal("Gregory works here"),
            namedNode("urn:graphA"),
          ),
          createQuad(
            namedNode("urn:bob"),
            namedNode("urn:knows"),
            literal("Gregory works there"),
            namedNode("urn:graphB"),
          ),
        ],
      },
    });

    const scoped = await searchIndex.search({
      query: "Gregory",
      include: { graphs: ["urn:graphA"] },
    });
    assertEquals(scoped.results?.length, 1);
    assertEquals(scoped.results?.[0].subject, "urn:alice");

    const excluded = await searchIndex.search({
      query: "Gregory",
      exclude: { graphs: ["urn:graphB"] },
    });
    assertEquals(excluded.results?.length, 1);
    assertEquals(excluded.results?.[0].subject, "urn:alice");
  } finally {
    await dispose();
  }
});

Deno.test("CloudflareSearchIndex - pure punctuation query returns no results", async () => {
  const { searchIndex, dispose } = await createTestContext();
  try {
    const response = await searchIndex.search({ query: "!!!" });
    assertEquals(response.results?.length, 0);
  } finally {
    await dispose();
  }
});

Deno.test("CloudflareSearchIndex - reindex rebuilds chunks from durable quads", async () => {
  const { searchIndex, connection, store, searchQueryBuilder, dispose } =
    await createTestContext();
  try {
    const disabledQuadStore = new D1QuadStore({
      connection,
      store,
      searchQueryBuilder,
      searchIndexOnImport: "disabled",
    });
    await disabledQuadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(
            namedNode("urn:sandra"),
            namedNode("urn:knows"),
            literal("Sandra reviews the corpus"),
          ),
        ],
      },
    });

    const before = await searchIndex.search({ query: "Sandra" });
    assertEquals(before.results?.length, 0);

    const report = await searchIndex.reindex();
    assertEquals(report.processedQuadCount, 1);
    assertEquals(report.chunkRowCount, 1);

    const after = await searchIndex.search({ query: "Sandra" });
    assertEquals(after.results?.length, 1);
    assertEquals(after.results?.[0].subject, "urn:sandra");
  } finally {
    await dispose();
  }
});

Deno.test("CloudflareSearchIndex - sanitizeFtsQuery strips stopwords and wraps tokens", () => {
  const builder = new D1SearchQueryBuilder(32);
  assertEquals(
    builder.sanitizeFtsQuery("the quick brown fox"),
    '"quick" "brown" "fox"',
  );
  assertEquals(builder.sanitizeFtsQuery("!!!"), "");
  assertEquals(builder.sanitizeFtsQuery("Memory SDK"), '"memory" "sdk"');
});
