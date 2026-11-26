import assert from "node:assert/strict";
import test from "node:test";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { D1QuadStore } from "./mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import {
  type D1ConnectionDriver,
  D1ConnectionDriver as Connection,
  type D1Statement,
} from "@/cloudflare/d1/d1-connection-driver.ts";
import { DEFAULT_D1_MAX_WRITE_BATCH_SIZE } from "@/cloudflare/d1/d1-batch-executor.ts";
import {
  d1StatementWeight,
  DEFAULT_D1_MAX_BATCH_WEIGHT,
} from "@/cloudflare/d1/d1-statement-weight.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "@/cloudflare/search-index/d1-search-index-projector.ts";
import { FakeVectorSearchIndex } from "@/cloudflare/search-index/vector-search/fake-vector-search-index.ts";

const { namedNode, literal, quad } = DataFactory;

/** RecordingConnection keeps every batch the commit driver hands D1, and can fail one. */
class RecordingConnection extends Connection {
  batches: D1Statement[][] = [];
  failOnBatch = -1;
  override batch(statements: readonly D1Statement[]): Promise<void> {
    this.batches.push([...statements]);
    if (this.batches.length === this.failOnBatch) {
      return Promise.reject(new Error("injected D1 batch failure"));
    }
    return super.batch(statements);
  }
}

/** dimensional embeds every text as a zero vector of `dims` floats. */
function dimensional(dims: number): EmbeddingService {
  return {
    embed: (texts) => Promise.resolve(texts.map(() => new Float32Array(dims))),
  };
}

async function createImportStore(dims: number) {
  const substrate = await createTestD1();
  const connection = new RecordingConnection(substrate.database);
  const schemaBuilder = new D1SchemaBuilder(dims);
  const store = new D1RdfjsStore({ connection, schemaBuilder });
  await store.ensureSchema();
  const searchQueryBuilder = new D1SearchQueryBuilder(dims);
  const quadStore = new D1QuadStore({
    connection,
    store,
    searchQueryBuilder,
    searchIndexProjector: new D1SearchIndexProjector({
      connection,
      searchQueryBuilder,
      textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
      embeddingService: dimensional(dims),
      vectorSearch: new FakeVectorSearchIndex(),
      vectorDimensions: dims,
    }),
  });
  return { substrate, connection, store, quadStore };
}

function quadsOf(count: number) {
  return Array.from(
    { length: count },
    (_, i) =>
      quad(namedNode(`urn:s:${i}`), namedNode("urn:p"), literal(`v ${i}`)),
  );
}

const weightOf = (batch: readonly D1Statement[]) =>
  batch.reduce((sum, statement) => sum + d1StatementWeight(statement), 0);

async function chunkCount(connection: D1ConnectionDriver): Promise<number> {
  const { rows } = await connection.execute({
    sql: "SELECT COUNT(*) AS n FROM chunks",
  });
  return Number(rows[0]!.n);
}

/**
 * The default write batch size is a chosen count (2,000) plus a byte budget
 * (16 MiB estimated serialized); Cloudflare documents no statement cap but the
 * binding rejects a batch over 32 MiB serialized. A commit is atomic only if it
 * fits both. 400 quads write about 800 statements and 384-dim vectors weigh
 * about 3 MB: one atomic batch (the 750 default sent 375+ quads to the fallback).
 */
test("an import of 400 quads with 384-dim vectors is one atomic batch() under the defaults", async () => {
  const { substrate, connection, store, quadStore } = await createImportStore(
    384,
  );
  try {
    await quadStore.createTransaction().addQuads(quadsOf(400)).commit();
    assert.deepStrictEqual(connection.batches.length, 1);
    const size = connection.batches[0]!.length;
    assert.ok(size > 750 && size <= DEFAULT_D1_MAX_WRITE_BATCH_SIZE, `${size}`);
    assert.ok(weightOf(connection.batches[0]!) <= DEFAULT_D1_MAX_BATCH_WEIGHT);
    assert.deepStrictEqual((await store.getQuads()).length, 400);
    assert.deepStrictEqual(await chunkCount(connection), 400);
  } finally {
    await substrate.dispose();
  }
});

test("an import of 1,536-dim vectors above the byte budget takes the chunked fallback, every batch under budget", async () => {
  const { substrate, connection, store, quadStore } = await createImportStore(
    1536,
  );
  try {
    // About 800 chunk rows of ~25 KB estimated: over 16 MiB, under 2,000 statements.
    await quadStore.createTransaction().addQuads(quadsOf(800)).commit();
    assert.ok(connection.batches.length > 1, "the byte budget forces a split");
    for (const batch of connection.batches) {
      assert.ok(batch.length <= DEFAULT_D1_MAX_WRITE_BATCH_SIZE);
      assert.ok(weightOf(batch) <= DEFAULT_D1_MAX_BATCH_WEIGHT, "over budget");
    }
    assert.deepStrictEqual((await store.getQuads()).length, 800);
    assert.deepStrictEqual(await chunkCount(connection), 800);
  } finally {
    await substrate.dispose();
  }
});

test("a failed chunked import above the byte budget removes what the earlier batches wrote", async () => {
  const { substrate, connection, store, quadStore } = await createImportStore(
    1536,
  );
  try {
    connection.failOnBatch = 2;
    let failure: unknown;
    try {
      await quadStore.createTransaction().addQuads(quadsOf(800)).commit();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error, "the commit must reject");
    assert.deepStrictEqual((await store.getQuads()).length, 0);
    assert.deepStrictEqual(await chunkCount(connection), 0);
    for (const batch of connection.batches) {
      assert.ok(weightOf(batch) <= DEFAULT_D1_MAX_BATCH_WEIGHT, "over budget");
    }
  } finally {
    await substrate.dispose();
  }
});
