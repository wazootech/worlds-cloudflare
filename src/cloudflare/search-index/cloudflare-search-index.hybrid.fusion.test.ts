import assert from "node:assert/strict";
import test from "node:test";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { CloudflareSearchIndex } from "./mod.ts";
import { D1SearchIndexProjector } from "./d1-search-index-projector.ts";
import { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1QuadStore } from "@/cloudflare/quad-store/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import {
  createHybridContext,
  quadText,
} from "./cloudflare-search-index-hybrid-test-helpers.ts";

test("PhaseC - projection embeds vectors, persists them in D1, and syncs the vector index", async () => {
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
    assert.deepStrictEqual(vectorSearch.size, 1);
    const [queryVector] = await new FakeEmbeddingService().embed([
      "alpha beta topic",
    ]);
    const hits = await vectorSearch.query(Array.from(queryVector), {
      topK: 1,
    });
    assert.deepStrictEqual(hits[0].metadata?.["subject"], "urn:a");
    assert.deepStrictEqual(hits[0].metadata?.["value"], "alpha beta topic");

    // The D1 chunks row persisted the vector blob (F32_BLOB column).
    const rows = await connection.execute({
      sql: "SELECT COUNT(*) AS n FROM chunks WHERE vector IS NOT NULL",
      args: [],
    });
    assert.deepStrictEqual(Number(rows.rows[0]["n"]), 1);
  } finally {
    await dispose();
  }
});

test("PhaseC - hybrid search fuses keyword + vector lists and reports mode + scoreType", async () => {
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
    assert.deepStrictEqual(response.mode, "hybrid");
    const results = response.results ?? [];

    // Both quads match keyword AND vector, so both fuse as rrf; the rank-0
    // hit (present at rank 0 in BOTH lists) scores exactly 1.0.
    assert.deepStrictEqual(results.length, 2);
    assert.deepStrictEqual(results[0].score, 1.0);
    assert.deepStrictEqual(results[0].scoreType, "rrf");
    assert.deepStrictEqual(results[1].score < 1.0, true);
    assert.deepStrictEqual(results[1].scoreType, "rrf");
  } finally {
    await dispose();
  }
});

test("PhaseC - hybrid mode keeps vector-only hits as cosine", async () => {
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
    assert.deepStrictEqual(response.mode, "hybrid");
    const results = response.results ?? [];
    assert.deepStrictEqual(results.length, 2);

    const vectorOnly = results.find((r) => r.subject === "urn:vec-only");
    assert.deepStrictEqual(
      vectorOnly !== undefined,
      true,
      "vector-only hit present",
    );
    assert.deepStrictEqual(vectorOnly?.scoreType, "cosine");
    assert.deepStrictEqual(vectorOnly?.score, 1.0); // clamped cosine (identical vectors)
    assert.deepStrictEqual(vectorOnly?.text, "unrelated wording");
  } finally {
    await dispose();
  }
});

test("PhaseC - semantic mode runs vector-only when keyword has no matches", async () => {
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
    assert.deepStrictEqual(response.mode, "semantic");
    const results = response.results ?? [];
    assert.deepStrictEqual(results.length, 1);
    assert.deepStrictEqual(results[0].scoreType, "cosine");
    assert.deepStrictEqual(results[0].score, 1.0);
    assert.deepStrictEqual(results[0].subject, "urn:a");
    assert.deepStrictEqual(results[0].text, "alpha beta topic");
  } finally {
    await dispose();
  }
});

test("PhaseC - keyword mode when no vector path is wired", async () => {
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
    assert.deepStrictEqual(response.mode, "keyword");
    assert.deepStrictEqual(response.results?.length, 1);
    assert.deepStrictEqual(response.results?.[0].scoreType, "rrf");
    assert.deepStrictEqual(response.results?.[0].score, 1.0);
  } finally {
    await substrate.dispose();
  }
});
