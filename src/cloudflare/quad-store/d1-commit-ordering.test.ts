import assert from "node:assert/strict";
import test from "node:test";
import { rejected } from "../../../test/thrown.ts";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import { D1QuadStore } from "./mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "@/cloudflare/search-index/d1-search-index-projector.ts";
import { FakeVectorSearchIndex } from "@/cloudflare/search-index/vector-search/fake-vector-search-index.ts";

const { namedNode, literal, quad } = DataFactory;
const p = namedNode("urn:order:p");
const a = quad(namedNode("urn:order:a"), p, literal("same text"));
const b = quad(namedNode("urn:order:b"), p, literal("same text"));

/** embedder returns `length`-dimension vectors and records every call's texts. */
function embedder(length: number, calls: string[][]): EmbeddingService {
  return {
    embed: (texts) => {
      calls.push([...texts]);
      return Promise.resolve(texts.map(() => Array.from({ length }, () => 0.5)));
    },
  };
}

async function setup(options: {
  embeddingService: EmbeddingService;
  textSplitter?: TextSplitterInterface;
}) {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({ connection: substrate.connection });
  await store.ensureSchema();
  const searchQueryBuilder = new D1SearchQueryBuilder(32);
  const vectorSearch = new FakeVectorSearchIndex();
  const projector = new D1SearchIndexProjector({
    connection: substrate.connection,
    searchQueryBuilder,
    textSplitter: options.textSplitter ??
      new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
    embeddingService: options.embeddingService,
    vectorSearch,
    vectorDimensions: 32,
  });
  const quadStore = new D1QuadStore({
    connection: substrate.connection,
    store,
    searchQueryBuilder,
    searchIndexProjector: projector,
    searchIndexOnImport: "incremental",
  });
  const chunkCount = async () =>
    Number(
      (await substrate.connection.execute({
        sql: "SELECT COUNT(*) AS n FROM chunks",
      })).rows[0]!.n,
    );
  return { substrate, store, quadStore, vectorSearch, chunkCount };
}

test("chunking fails before any write: a splitter error stores nothing", async () => {
  const t = await setup({
    embeddingService: embedder(32, []),
    textSplitter: {
      createDocuments: () => Promise.reject(new Error("splitter down")),
    },
  });
  try {
    await rejected(
      () =>
        t.quadStore.createTransaction().addQuads([a]).commit({
          importMode: "merge",
        }),
      Error,
      "failed to chunk novel textual facts",
    );
    assert.deepStrictEqual((await t.store.getQuads()).length, 0);
    assert.deepStrictEqual(await t.chunkCount(), 0);
  } finally {
    await t.substrate.dispose();
  }
});

test("identical chunk texts are embedded once per commit, and every quad keeps its vector", async () => {
  const calls: string[][] = [];
  const t = await setup({ embeddingService: embedder(32, calls) });
  try {
    await t.quadStore.createTransaction().addQuads([a, b]).commit({
      importMode: "merge",
    });
    assert.deepStrictEqual(calls, [["same text"]]);
    assert.deepStrictEqual(await t.chunkCount(), 2);
    assert.deepStrictEqual(
      t.vectorSearch.size,
      2,
      "each quad keeps its own vector id",
    );
  } finally {
    await t.substrate.dispose();
  }
});

test("a vector of the wrong length rejects the commit before any write", async () => {
  const t = await setup({ embeddingService: embedder(8, []) });
  try {
    await rejected(
      () =>
        t.quadStore.createTransaction().addQuads([a]).commit({
          importMode: "merge",
        }),
      Error,
      "failed to vectorize literal chunk blocks",
    );
    assert.deepStrictEqual((await t.store.getQuads()).length, 0);
    assert.deepStrictEqual(await t.chunkCount(), 0);
    assert.deepStrictEqual(t.vectorSearch.size, 0, "no vector is synced");
  } finally {
    await t.substrate.dispose();
  }
});
