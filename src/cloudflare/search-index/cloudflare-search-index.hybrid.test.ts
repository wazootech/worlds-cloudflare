import { assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
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
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";

const { namedNode, literal, quad: createQuad } = DataFactory;

interface HybridTestContext {
  searchIndex: CloudflareSearchIndex;
  quadStore: D1QuadStore;
  vectorSearch: FakeVectorSearchIndex;
  store: D1RdfjsStore;
  connection: D1ConnectionDriver;
  dispose(): Promise<void>;
}

async function createHybridContext(): Promise<HybridTestContext> {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({ connection: substrate.connection });
  await store.ensureSchema();

  const searchQueryBuilder = new D1SearchQueryBuilder(32);
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
    embeddingService,
    vectorSearch,
  });

  return {
    searchIndex,
    quadStore,
    vectorSearch,
    store,
    connection: substrate.connection,
    dispose: substrate.dispose,
  };
}

const quadText = (
  subject: string,
  text: string,
) =>
  createQuad(
    namedNode(subject),
    namedNode("urn:knows"),
    literal(text),
  );

Deno.test("PhaseC - projection embeds vectors, persists them in D1, and syncs the vector index", async () => {
  const { quadStore, vectorSearch, connection, dispose } =
    await createHybridContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [quadText("urn:a", "alpha beta topic")],
      },
    });

    // Vector index got exactly one entry with the contract metadata.
    assertEquals(vectorSearch.size, 1);
    const [queryVector] = await new FakeEmbeddingService().embed([
      "alpha beta topic",
    ]);
    const hits = await vectorSearch.query(Array.from(queryVector), {
      topK: 1,
    });
    assertEquals(hits[0].metadata?.["subject"], "urn:a");
    assertEquals(hits[0].metadata?.["value"], "alpha beta topic");

    // The D1 chunks row persisted the vector blob (F32_BLOB column).
    const rows = await connection.execute({
      sql: "SELECT COUNT(*) AS n FROM chunks WHERE vector IS NOT NULL",
      args: [],
    });
    assertEquals(Number(rows.rows[0]["n"]), 1);
  } finally {
    await dispose();
  }
});

Deno.test("PhaseC - hybrid search fuses keyword + vector lists and reports mode + scoreType", async () => {
  const { searchIndex, quadStore, dispose } = await createHybridContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quadText("urn:one", "alpha beta topic"),
          quadText("urn:two", "beta topic gamma"),
        ],
      },
    });

    const response = await searchIndex.search({ query: "beta" });
    assertEquals(response.mode, "hybrid");
    const results = response.results ?? [];

    // Both quads match keyword AND vector, so both fuse as rrf; the rank-0
    // hit (present at rank 0 in BOTH lists) scores exactly 1.0.
    assertEquals(results.length, 2);
    assertEquals(results[0].score, 1.0);
    assertEquals(results[0].scoreType, "rrf");
    assertEquals(results[1].score < 1.0, true);
    assertEquals(results[1].scoreType, "rrf");
  } finally {
    await dispose();
  }
});

Deno.test("PhaseC - hybrid mode keeps vector-only hits as cosine", async () => {
  const { searchIndex, quadStore, dispose } = await createHybridContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quadText("urn:kw", "alpha beta topic"),
          // No FTS match for "beta" — vector-only in the fused result.
          quadText("urn:vec-only", "unrelated wording"),
        ],
      },
    });

    const response = await searchIndex.search({ query: "beta" });
    assertEquals(response.mode, "hybrid");
    const results = response.results ?? [];
    assertEquals(results.length, 2);

    const vectorOnly = results.find((r) => r.subject === "urn:vec-only");
    assertEquals(vectorOnly !== undefined, true, "vector-only hit present");
    assertEquals(vectorOnly?.scoreType, "cosine");
    assertEquals(vectorOnly?.score, 1.0); // clamped cosine (identical vectors)
    assertEquals(vectorOnly?.text, "unrelated wording");
  } finally {
    await dispose();
  }
});

Deno.test("PhaseC - semantic mode runs vector-only when keyword has no matches", async () => {
  const { searchIndex, quadStore, dispose } = await createHybridContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [quadText("urn:a", "alpha beta topic")],
      },
    });

    // Pure punctuation sanitizes to an empty FTS query (no keyword rows) but
    // the vector index still matches — semantic mode with cosine scores.
    const response = await searchIndex.search({ query: "!!!" });
    assertEquals(response.mode, "semantic");
    const results = response.results ?? [];
    assertEquals(results.length, 1);
    assertEquals(results[0].scoreType, "cosine");
    assertEquals(results[0].score, 1.0);
    assertEquals(results[0].subject, "urn:a");
    assertEquals(results[0].text, "alpha beta topic");
  } finally {
    await dispose();
  }
});

Deno.test("PhaseC - keyword mode when no vector path is wired", async () => {
  const substrate = await createTestD1();
  try {
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

    await quadStore.import({
      source: {
        kind: "quads",
        quads: [quadText("urn:a", "alpha beta topic")],
      },
    });

    const response = await searchIndex.search({ query: "beta" });
    assertEquals(response.mode, "keyword");
    assertEquals(response.results?.length, 1);
    assertEquals(response.results?.[0].scoreType, "rrf");
    assertEquals(response.results?.[0].score, 1.0);
  } finally {
    await substrate.dispose();
  }
});

Deno.test("PhaseC - vector search is scoped per world via the metadata filter", async () => {
  const substrate = await createTestD1();
  try {
    const store = new D1RdfjsStore({
      connection: substrate.connection,
      worldUid: "w-one",
    });
    await store.ensureSchema();
    // The builder must be world-scoped like createCloudflareWorldsSdk wires it
    // (its worldUid gates the world_uid column on chunk writes and queries).
    const searchQueryBuilder = new D1SearchQueryBuilder(32, {
      worldUid: "w-one",
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
      worldUid: "w-one",
    });
    const quadStore = new D1QuadStore({
      connection: substrate.connection,
      store,
      searchQueryBuilder,
      searchIndexProjector: projector,
      searchIndexOnImport: "incremental",
      worldUid: "w-one",
    });
    const searchIndex = new CloudflareSearchIndex({
      connection: substrate.connection,
      searchQueryBuilder,
      textSplitter,
      embeddingService,
      vectorSearch,
      worldUid: "w-one",
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
      metadata: { world_uid: "w-two", subject: "urn:other-world" },
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
