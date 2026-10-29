import { assertEquals } from "@std/assert";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import { CloudflareSearchIndex } from "./mod.ts";
import { D1SearchIndexProjector } from "./d1-search-index-projector.ts";
import { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1QuadStore } from "@/cloudflare/quad-store/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { FakeVectorSearchIndex } from "./vector-search/mod.ts";
import {
  createHybridContext,
  quadText,
} from "./cloudflare-search-index-hybrid-test-helpers.ts";

Deno.test("PhaseC - vector search is scoped per world via the metadata filter", async () => {
  const substrate = await createTestD1();
  try {
    const store = new D1RdfjsStore({
      connection: substrate.connection,
      worldId: "w-one",
    });
    await store.ensureSchema();
    // The builder must be world-scoped like createCloudflareWorldsSdk wires it
    // (its worldId gates the world_id column on chunk writes and queries).
    const searchQueryBuilder = new D1SearchQueryBuilder(32, {
      worldId: "w-one",
    });
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
    });
    const vectorSearch = new FakeVectorSearchIndex();
    const embeddingService = new FakeEmbeddingService();
    const projector = new D1SearchIndexProjector({
      connection: substrate.connection,
      searchQueryBuilder,
      textSplitter,
      embeddingService,
      vectorSearch,
      worldId: "w-one",
    });
    const quadStore = new D1QuadStore({
      connection: substrate.connection,
      store,
      searchQueryBuilder,
      searchIndexProjector: projector,
      searchIndexOnImport: "incremental",
      worldId: "w-one",
    });
    const searchIndex = new CloudflareSearchIndex({
      connection: substrate.connection,
      searchQueryBuilder,
      textSplitter,
      embeddingService,
      vectorSearch,
      worldId: "w-one",
    });

    await quadStore.import({
      source: {
        kind: "quads",
        quads: [quadText("urn:a", "alpha beta topic")],
      },
    });

    // A second world's entry in the same shared index must not leak through.
    await vectorSearch.upsert([{
      id: await buildSearchResultId({
        subject: "urn:other-world",
        predicate: "urn:knows",
        graph: "",
        text: "alpha beta topic",
      }),
      vector: new Float32Array([
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ]),
      metadata: { world_id: "w-two", subject: "urn:other-world" },
    }]);

    const response = await searchIndex.search({ query: "alpha" });
    assertEquals(response.mode, "hybrid");
    const results = response.results ?? [];
    assertEquals(results.some((r) => r.subject === "urn:other-world"), false);
    assertEquals(results.some((r) => r.subject === "urn:a"), true);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("PhaseC - reindex refreshes chunks and keeps the vector index in sync", async () => {
  const { searchIndex, quadStore, vectorSearch, dispose } =
    await createHybridContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [quadText("urn:a", "alpha beta topic")],
      },
    });
    assertEquals(vectorSearch.size, 1);

    // Rebuilding from durable quads must delete + re-upsert the same vectors.
    const report = await searchIndex.reindex();
    assertEquals(report.chunkRowCount, 1);
    assertEquals(vectorSearch.size, 1);

    const response = await searchIndex.search({ query: "beta" });
    assertEquals(response.mode, "hybrid");
    assertEquals(response.results?.length, 1);
  } finally {
    await dispose();
  }
});
