import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { CloudflareSearchIndex } from "./mod.ts";
import { D1SearchIndexProjector } from "./d1-search-index-projector.ts";
import { D1SearchQueryBuilder } from "./d1-search-query-builder.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1QuadStore } from "@/cloudflare/quad-store/mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { FakeVectorSearchIndex } from "./vector-search/mod.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";

export const { namedNode, literal, quad: createQuad } = DataFactory;

export interface HybridTestContext {
  searchIndex: CloudflareSearchIndex;
  quadStore: D1QuadStore;
  vectorSearch: FakeVectorSearchIndex;
  store: D1RdfjsStore;
  connection: D1ConnectionDriver;
  dispose(): Promise<void>;
}

export async function createHybridContext(): Promise<HybridTestContext> {
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

export const quadText = (
  subject: string,
  text: string,
) =>
  createQuad(
    namedNode(subject),
    namedNode("urn:knows"),
    literal(text),
  );
