import { assert, assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { CloudflareSearchIndex } from "./mod.ts";
import { D1SearchIndexProjector } from "./d1-search-index-projector.ts";
import { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1QuadStore } from "@/cloudflare/quad-store/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import {
  FakeVectorSearchIndex,
  type VectorSearchEntry,
} from "./vector-search/mod.ts";

const { namedNode, literal, quad: createQuad } = DataFactory;

/** FlakyVectorSearchIndex fails upserts or deletes on demand. */
class FlakyVectorSearchIndex extends FakeVectorSearchIndex {
  public failUpsert = false;
  public failDelete = false;
  public override upsert(entries: VectorSearchEntry[]): Promise<void> {
    if (this.failUpsert) return Promise.reject(new Error("vectorize 503"));
    return super.upsert(entries);
  }
  public override deleteByIds(ids: string[]): Promise<void> {
    if (this.failDelete) return Promise.reject(new Error("vectorize 503"));
    return super.deleteByIds(ids);
  }
}

/** FlakyEmbeddingService fails embedding on demand. */
class FlakyEmbeddingService extends FakeEmbeddingService {
  public fail = false;
  public override embed(texts: string[]): Promise<Float32Array[]> {
    if (this.fail) return Promise.reject(new Error("embeddings down"));
    return super.embed(texts);
  }
}

async function createContext(wireVectors = true) {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({ connection: substrate.connection });
  await store.ensureSchema();
  const searchQueryBuilder = new D1SearchQueryBuilder(32);
  const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000 });
  const vectorSearch = new FlakyVectorSearchIndex();
  const embeddingService = new FlakyEmbeddingService();
  const vectorOptions = wireVectors ? { vectorSearch, embeddingService } : {};
  const projector = new D1SearchIndexProjector({
    connection: substrate.connection,
    searchQueryBuilder,
    textSplitter,
    ...vectorOptions,
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
    ...vectorOptions,
  });
  const importText = (subject: string, text: string) =>
    quadStore.import({
      source: {
        kind: "quads",
        quads: [
          createQuad(namedNode(subject), namedNode("urn:p"), literal(text)),
        ],
      },
    });
  const chunkCount = async () =>
    Number(
      (await substrate.connection.execute({
        sql: "SELECT COUNT(*) AS n FROM chunks",
        args: [],
      })).rows[0]["n"],
    );
  return {
    searchIndex,
    vectorSearch,
    embeddingService,
    importText,
    chunkCount,
    dispose: substrate.dispose,
  };
}

/** captureErrors records console.error output for the duration of fn. */
async function captureErrors(fn: () => Promise<void>): Promise<string> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) =>
    lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

Deno.test("#40 - a failed vector upsert keeps the import, logs drift, and reindex reports then repairs it", async () => {
  const ctx = await createContext();
  try {
    ctx.vectorSearch.failUpsert = true;
    const logged = await captureErrors(() => ctx.importText("urn:a", "alpha"));
    assertEquals(await ctx.chunkCount(), 1, "D1 write still committed");
    assertEquals(ctx.vectorSearch.size, 0, "vector never reached the index");
    assert(logged.includes("vector index drifted from D1"), logged);
    assert(logged.includes('"failedUpserts":1'), logged);

    let response;
    const reindexLog = await captureErrors(async () => {
      response = await ctx.searchIndex.reindex();
    });
    assertEquals(response!.vectorSync.failedUpserts, 1);
    assertEquals(response!.vectorSync.upserted, 0);
    assert(response!.vectorSync.errors[0].includes("vectorize 503"));
    assert(reindexLog.includes('"operation":"reindex"'), reindexLog);

    ctx.vectorSearch.failUpsert = false;
    const repaired = await ctx.searchIndex.reindex();
    assertEquals(repaired.vectorSync.failedUpserts, 0);
    assertEquals(repaired.vectorSync.upserted, 1);
    assertEquals(ctx.vectorSearch.size, 1, "reindex repaired the drift");
  } finally {
    await ctx.dispose();
  }
});

Deno.test("#40 - an embedding outage is counted, not hidden, and reindex re-embeds", async () => {
  const ctx = await createContext();
  try {
    ctx.embeddingService.fail = true;
    const logged = await captureErrors(() => ctx.importText("urn:b", "beta"));
    assertEquals(await ctx.chunkCount(), 1);
    assert(logged.includes('"embeddingFailures":1'), logged);

    let response;
    await captureErrors(async () => {
      response = await ctx.searchIndex.reindex();
    });
    assertEquals(response!.vectorSync.embeddingFailures, 1);
    assert(response!.vectorSync.errors[0].startsWith("embed:"));

    ctx.embeddingService.fail = false;
    const repaired = await ctx.searchIndex.reindex();
    assertEquals(repaired.vectorSync.embeddingFailures, 0);
    assertEquals(ctx.vectorSearch.size, 1);
  } finally {
    await ctx.dispose();
  }
});

Deno.test("#40 - a failed stale-vector delete is reported by reindex", async () => {
  const ctx = await createContext();
  try {
    await ctx.importText("urn:c", "gamma");
    ctx.vectorSearch.failDelete = true;
    let response;
    await captureErrors(async () => {
      response = await ctx.searchIndex.reindex();
    });
    assert(response!.vectorSync.staleDeleteFailures > 0);
    assert(response!.vectorSync.errors[0].startsWith("delete-stale:"));
  } finally {
    await ctx.dispose();
  }
});

Deno.test("#40 - a healthy reindex reports a clean, complete vector sync", async () => {
  const ctx = await createContext();
  try {
    await ctx.importText("urn:d", "delta");
    const logged = await captureErrors(async () => {
      const response = await ctx.searchIndex.reindex();
      assertEquals(response.vectorSync, {
        enabled: true,
        attempted: 1,
        upserted: 1,
        failedUpserts: 0,
        embeddingFailures: 0,
        staleDeleteFailures: 0,
        errors: [],
      });
    });
    assertEquals(logged, "", "no drift logged when nothing failed");
  } finally {
    await ctx.dispose();
  }
});

Deno.test("#40 - without a vector index, vector sync is reported as disabled", async () => {
  const ctx = await createContext(false);
  try {
    await ctx.importText("urn:e", "epsilon");
    const response = await ctx.searchIndex.reindex();
    assertEquals(response.vectorSync.enabled, false);
    assertEquals(response.vectorSync.attempted, 0);
    assertEquals(response.chunkRowCount, 1);
  } finally {
    await ctx.dispose();
  }
});
