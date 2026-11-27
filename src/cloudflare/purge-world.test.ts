import assert from "node:assert/strict";
import test from "node:test";
import { rejected } from "../../test/thrown.ts";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { buildSearchResultId } from "@worlds/sqlite/sql-core";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1QuadStore } from "@/cloudflare/quad-store/mod.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "@/cloudflare/search-index/d1-search-index-projector.ts";
import { FakeVectorSearchIndex } from "@/cloudflare/search-index/vector-search/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import {
  createQuad,
  literal,
  namedNode,
} from "@/cloudflare/search-index/cloudflare-search-index-hybrid-test-helpers.ts";
import { purgeWorld } from "./purge-world.ts";

const WORLD_A = "w-purge-a";
const WORLD_B = "w-purge-b";

interface World {
  quadStore: D1QuadStore;
  vectorSearch: FakeVectorSearchIndex;
}

interface Context {
  worldA: World;
  worldB: World;
  connection: Awaited<ReturnType<typeof createTestD1>>["connection"];
  dispose(): Promise<void>;
}

async function createContext(): Promise<Context> {
  const substrate = await createTestD1();
  const storeA = new D1RdfjsStore({
    connection: substrate.connection,
    worldId: WORLD_A,
  });
  const storeB = new D1RdfjsStore({
    connection: substrate.connection,
    worldId: WORLD_B,
  });
  await storeA.ensureSchema();

  const buildWorld = (worldId: string, store: D1RdfjsStore): World => {
    const searchQueryBuilder = new D1SearchQueryBuilder(32, { worldId });
    const vectorSearch = new FakeVectorSearchIndex(worldId);
    const projector = new D1SearchIndexProjector({
      connection: substrate.connection,
      searchQueryBuilder,
      textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
      embeddingService: new FakeEmbeddingService(),
      vectorSearch,
      worldId,
    });
    const quadStore = new D1QuadStore({
      connection: substrate.connection,
      store,
      searchQueryBuilder,
      searchIndexProjector: projector,
      searchIndexOnImport: "incremental",
      worldId,
    });
    return { quadStore, vectorSearch };
  };

  return {
    worldA: buildWorld(WORLD_A, storeA),
    worldB: buildWorld(WORLD_B, storeB),
    connection: substrate.connection,
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

async function count(
  connection: Context["connection"],
  table: string,
  worldId?: string,
): Promise<number> {
  const result = await connection.execute(
    worldId
      ? {
        sql: `SELECT COUNT(*) AS n FROM ${table} WHERE world_id = ?`,
        args: [worldId],
      }
      : { sql: `SELECT COUNT(*) AS n FROM ${table}` },
  );
  return result.rows[0] ? Number((result.rows[0] as { n: number }).n) : 0;
}

test(
  "purgeWorld removes quads, chunks and vectors for the world only (#71 item 6)",
  async () => {
    const { worldA, worldB, connection, dispose } = await createContext();
    try {
      await worldA.quadStore.import({
        source: {
          kind: "quads",
          quads: [quadText("urn:a", "world a content")],
        },
      });
      await worldB.quadStore.import({
        source: {
          kind: "quads",
          quads: [quadText("urn:b", "world b content")],
        },
      });
      const idA = await vectorIdFor("urn:a", "world a content");
      const idB = await vectorIdFor("urn:b", "world b content");
      assert.deepStrictEqual(worldA.vectorSearch.has(idA), true);
      assert.deepStrictEqual(worldB.vectorSearch.has(idB), true);
      assert.deepStrictEqual(await count(connection, "quads", WORLD_A), 1);
      assert.deepStrictEqual(await count(connection, "chunks", WORLD_A), 1);

      const result = await purgeWorld({
        connection,
        worldId: WORLD_A,
        vectorSearch: worldA.vectorSearch,
      });

      assert.deepStrictEqual(result, {
        vectorsPurged: true,
        vectorsSkipped: false,
      });
      assert.deepStrictEqual(await count(connection, "quads", WORLD_A), 0);
      assert.deepStrictEqual(await count(connection, "chunks", WORLD_A), 0);
      assert.deepStrictEqual(worldA.vectorSearch.has(idA), false);
      // The other world is untouched.
      assert.deepStrictEqual(await count(connection, "quads", WORLD_B), 1);
      assert.deepStrictEqual(await count(connection, "chunks", WORLD_B), 1);
      assert.deepStrictEqual(worldB.vectorSearch.has(idB), true);
    } finally {
      await dispose();
    }
  },
);

test(
  "purgeWorld without a vector index reports the skip and still purges rows (#71 item 6)",
  async () => {
    const { worldA, connection, dispose } = await createContext();
    try {
      await worldA.quadStore.import({
        source: {
          kind: "quads",
          quads: [quadText("urn:a", "world a content")],
        },
      });
      const result = await purgeWorld({ connection, worldId: WORLD_A });
      assert.deepStrictEqual(result, {
        vectorsPurged: false,
        vectorsSkipped: true,
      });
      assert.deepStrictEqual(await count(connection, "quads", WORLD_A), 0);
      assert.deepStrictEqual(await count(connection, "chunks", WORLD_A), 0);
    } finally {
      await dispose();
    }
  },
);

test("purgeWorld refuses an empty worldId (#71 item 6)", async () => {
  const { connection, dispose } = await createContext();
  try {
    await rejected(
      () => purgeWorld({ connection, worldId: "" }),
      Error,
      "unscoped purge",
    );
  } finally {
    await dispose();
  }
});
