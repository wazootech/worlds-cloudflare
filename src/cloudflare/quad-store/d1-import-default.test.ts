import assert from "node:assert/strict";
import test from "node:test";
import { rejected } from "../../../test/thrown.ts";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { D1QuadStore } from "./mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "@/cloudflare/search-index/d1-search-index-projector.ts";
import { FakeVectorSearchIndex } from "@/cloudflare/search-index/vector-search/fake-vector-search-index.ts";

const { namedNode, literal, quad } = DataFactory;

/** CountingEmbedder records every text it embeds and can be made to fail. */
class CountingEmbedder implements EmbeddingService {
  texts: string[] = [];
  failing = false;
  embed(texts: string[]): Promise<Float32Array[]> {
    if (this.failing) return Promise.reject(new Error("embedder down"));
    this.texts.push(...texts);
    return Promise.resolve(texts.map(() => new Float32Array(32).fill(1)));
  }
}

const facts = (prefix: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      quad(
        namedNode(`urn:imp:${prefix}:${i}`),
        namedNode("urn:imp:p"),
        literal(`${prefix} fact ${i}`),
      ),
  );

/** setup builds a D1 store that leaves `searchIndexOnImport` unset, so the default applies. */
async function setup() {
  const substrate = await createTestD1();
  const { connection } = substrate;
  const store = new D1RdfjsStore({ connection });
  await store.ensureSchema();
  const embedder = new CountingEmbedder();
  const searchQueryBuilder = new D1SearchQueryBuilder(32);
  const quadStore = new D1QuadStore({
    connection,
    store,
    searchQueryBuilder,
    searchIndexProjector: new D1SearchIndexProjector({
      connection,
      searchQueryBuilder,
      textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
      embeddingService: embedder,
      vectorSearch: new FakeVectorSearchIndex(),
      vectorDimensions: 32,
    }),
  });
  const count = async (table: string) =>
    Number(
      (await connection.execute({ sql: `SELECT COUNT(*) AS n FROM ${table}` }))
        .rows[0]!.n,
    );
  return { substrate, store, embedder, quadStore, count };
}

const merge = (
  t: Awaited<ReturnType<typeof setup>>,
  quads: ReturnType<typeof facts>,
) =>
  t.quadStore.createTransaction().addQuads(quads).commit({
    importMode: "merge",
  });

test("a merge import embeds only the quads it writes by default", async () => {
  const t = await setup();
  try {
    await merge(t, facts("old", 3));
    t.embedder.texts.length = 0;
    await merge(t, [...facts("old", 3), ...facts("new", 2)]);
    assert.deepStrictEqual(t.embedder.texts.length, 2);
    assert.deepStrictEqual(await t.count("chunks"), 5);
  } finally {
    await t.substrate.dispose();
  }
});

test("an embedding failure on a default import leaves nothing written", async () => {
  const t = await setup();
  try {
    await merge(t, facts("old", 3));
    t.embedder.failing = true;
    await rejected(() => merge(t, facts("new", 4)));
    assert.deepStrictEqual((await t.store.getQuads()).length, 3);
    assert.deepStrictEqual(await t.count("chunks"), 3);
  } finally {
    await t.substrate.dispose();
  }
});
