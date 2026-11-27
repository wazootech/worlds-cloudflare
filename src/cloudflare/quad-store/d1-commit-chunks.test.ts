import assert from "node:assert/strict";
import test from "node:test";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { D1QuadStore } from "./mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "@/cloudflare/search-index/d1-search-index-projector.ts";

const { namedNode, literal, quad } = DataFactory;
const fact = quad(namedNode("urn:c:a"), namedNode("urn:c:p"), literal("text"));

async function setup() {
  const substrate = await createTestD1();
  const store = new D1RdfjsStore({ connection: substrate.connection });
  await store.ensureSchema();
  const searchQueryBuilder = new D1SearchQueryBuilder(32);
  const quadStore = new D1QuadStore({
    connection: substrate.connection,
    store,
    searchQueryBuilder,
    searchIndexProjector: new D1SearchIndexProjector({
      connection: substrate.connection,
      searchQueryBuilder,
      textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
    }),
    searchIndexOnImport: "incremental",
  });
  const chunkCount = async () =>
    Number(
      (
        await substrate.connection.execute({
          sql: "SELECT COUNT(*) AS n FROM chunks",
        })
      ).rows[0]!.n,
    );
  return { substrate, store, quadStore, chunkCount };
}

test("deleting and re-adding a quad in one patch replaces its chunk row instead of duplicating it", async () => {
  const t = await setup();
  try {
    await t.quadStore.createTransaction().addQuads([fact]).commit();
    assert.deepStrictEqual(await t.chunkCount(), 1);
    await t.quadStore
      .createTransaction()
      .removeQuads([fact])
      .addQuads([fact])
      .commit();
    assert.deepStrictEqual((await t.store.getQuads()).length, 1);
    assert.deepStrictEqual(await t.chunkCount(), 1);
  } finally {
    await t.substrate.dispose();
  }
});

test("deleting a quad leaves its chunk row for the vector-id orphan cleanup", async () => {
  const t = await setup();
  try {
    await t.quadStore.createTransaction().addQuads([fact]).commit();
    await t.quadStore.createTransaction().removeQuads([fact]).commit();
    assert.deepStrictEqual((await t.store.getQuads()).length, 0);
    assert.deepStrictEqual(await t.chunkCount(), 1);
  } finally {
    await t.substrate.dispose();
  }
});
