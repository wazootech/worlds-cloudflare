import { assert, assertEquals } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { D1QuadStore } from "./mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type { D1DatabaseLike } from "@/cloudflare/d1/d1-connection-driver.ts";
import { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import { DEFAULT_D1_MAX_WRITE_BATCH_SIZE } from "@/cloudflare/d1/d1-batch-executor.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "@/cloudflare/search-index/d1-search-index-projector.ts";
import { FakeVectorSearchIndex } from "@/cloudflare/search-index/vector-search/fake-vector-search-index.ts";

const { namedNode, literal, quad } = DataFactory;

/**
 * The default write batch size is a chosen size (Cloudflare documents no
 * per-batch statement cap), large enough that a modest import is one atomic
 * `batch()`. This pins that with the default options: 60 quads write about 120
 * statements, which the old 100-statement default split into a non-atomic
 * fallback.
 */
Deno.test("an import of 60 quads is one atomic batch() under the default write batch size", async () => {
  const substrate = await createTestD1();
  try {
    const sizes: number[] = [];
    const counting: D1DatabaseLike = {
      prepare: (sql) => substrate.database.prepare(sql),
      exec: (sql) => substrate.database.exec(sql),
      batch: (statements) => {
        sizes.push(statements.length);
        return substrate.database.batch(statements);
      },
    };
    const connection = new D1ConnectionDriver(counting);
    const store = new D1RdfjsStore({ connection });
    await store.ensureSchema();
    const searchQueryBuilder = new D1SearchQueryBuilder(32);
    const quadStore = new D1QuadStore({
      connection,
      store,
      searchQueryBuilder,
      searchIndexProjector: new D1SearchIndexProjector({
        connection,
        searchQueryBuilder,
        textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
        embeddingService: new FakeEmbeddingService(),
        vectorSearch: new FakeVectorSearchIndex(),
        vectorDimensions: 32,
      }),
    });
    const quads = Array.from(
      { length: 60 },
      (_, i) =>
        quad(namedNode(`urn:s:${i}`), namedNode("urn:p"), literal(`v ${i}`)),
    );
    await quadStore.createTransaction().addQuads(quads).commit();
    assertEquals(sizes.length, 1, `batch sizes: ${sizes}`);
    assert(sizes[0]! > 100, "the commit exceeds the old 100-statement default");
    assert(sizes[0]! <= DEFAULT_D1_MAX_WRITE_BATCH_SIZE);
    assertEquals((await store.getQuads()).length, 60);
  } finally {
    await substrate.dispose();
  }
});
