import assert from "node:assert/strict";
import test from "node:test";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import { D1SearchIndexProjector } from "./d1-search-index-projector.ts";
import { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1QuadStore } from "@/cloudflare/quad-store/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { FakeVectorSearchIndex } from "./vector-search/mod.ts";
import {
  createQuad,
  literal,
  namedNode,
} from "./cloudflare-search-index-hybrid-test-helpers.ts";

const WORLD = "w-vectors";

interface Context {
  quadStore: D1QuadStore;
  store: D1RdfjsStore;
  projector: D1SearchIndexProjector;
  vectorSearch: FakeVectorSearchIndex;
  dispose(): Promise<void>;
}

async function createContext(): Promise<Context> {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({
    connection: substrate.connection,
    worldId: WORLD,
  });
  await store.ensureSchema();

  const searchQueryBuilder = new D1SearchQueryBuilder(32, { worldId: WORLD });
  const vectorSearch = new FakeVectorSearchIndex(WORLD);
  const embeddingService = new FakeEmbeddingService();
  const projector = new D1SearchIndexProjector({
    connection: substrate.connection,
    searchQueryBuilder,
    textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
    embeddingService,
    vectorSearch,
    worldId: WORLD,
  });
  const quadStore = new D1QuadStore({
    connection: substrate.connection,
    store,
    searchQueryBuilder,
    searchIndexProjector: projector,
    searchIndexOnImport: "incremental",
    worldId: WORLD,
  });
  return {
    quadStore,
    store,
    projector,
    vectorSearch,
    dispose: substrate.dispose,
  };
}

function quadText(subject: string, text: string) {
  return createQuad(namedNode(subject), namedNode("urn:knows"), literal(text));
}

function vectorIdFor(subject: string, text: string) {
  return buildSearchResultId({
    subject,
    predicate: "urn:knows",
    graph: "",
    text,
  });
}

test("replace import with incremental projection purges stale vectors (#71 item 3)", async () => {
  const { quadStore, vectorSearch, dispose } = await createContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [quadText("urn:a", "old content")],
      },
    });
    const idA = await vectorIdFor("urn:a", "old content");
    assert.deepStrictEqual(vectorSearch.has(idA), true);

    await quadStore.import({
      mode: "replace",
      source: {
        kind: "quads",
        quads: [quadText("urn:b", "new content")],
      },
    });

    const idB = await vectorIdFor("urn:b", "new content");
    assert.deepStrictEqual(vectorSearch.has(idA), false);
    assert.deepStrictEqual(vectorSearch.has(idB), true);
    assert.deepStrictEqual(vectorSearch.size, 1);
  } finally {
    await dispose();
  }
});

test("reindex reconciles vectors for quads removed without projection (#71 item 3)", async () => {
  const { quadStore, store, projector, vectorSearch, dispose } =
    await createContext();
  try {
    await quadStore.import({
      source: {
        kind: "quads",
        quads: [
          quadText("urn:a", "stale after delete"),
          quadText("urn:b", "survivor"),
        ],
      },
    });
    const idA = await vectorIdFor("urn:a", "stale after delete");
    const idB = await vectorIdFor("urn:b", "survivor");
    assert.deepStrictEqual(vectorSearch.size, 2);

    // Delete quad A through the quad store: chunk rows go with it, but the
    // deletion path never touched vectors (the bug). The reindex that
    // follows is the repair pass.
    const transaction = quadStore.createTransaction();
    transaction.delete(quadText("urn:a", "stale after delete"));
    await transaction.commit({ importMode: "merge" });
    assert.deepStrictEqual(vectorSearch.has(idA), true);

    await projector.reindexAll();

    assert.deepStrictEqual(vectorSearch.has(idA), false);
    assert.deepStrictEqual(vectorSearch.has(idB), true);
    assert.deepStrictEqual(vectorSearch.size, 1);
    assert.deepStrictEqual((await store.getQuads()).length, 1);
  } finally {
    await dispose();
  }
});
