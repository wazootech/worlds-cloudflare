import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type * as rdfjs from "@rdfjs/types";
import { Sdk } from "@worlds/sdk";
import type { SdkInterface } from "@worlds/sdk";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import {
  CloudflareSearchIndex,
  D1SearchIndexProjector,
} from "@/cloudflare/search-index/mod.ts";
import { D1QuadStore } from "@/cloudflare/quad-store/mod.ts";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1DatabaseLike } from "@/cloudflare/d1/d1-connection-driver.ts";
import { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";

/**
 * CloudflareSdkOptions configures Cloudflare D1 execution through D1RdfjsStore and quad indexes.
 */
export interface CloudflareSdkOptions extends D1ClientBaseOptions {
  /** database is the raw D1 binding (miniflare or a real Worker binding). */
  database: D1DatabaseLike;
}

/**
 * createCloudflareSdk synthesizes a Sdk for D1-backed quad indexes.
 *
 * The factory assembles the three strategy objects internally: a
 * D1ConnectionDriver over the raw D1 binding, a D1SchemaBuilder, and a
 * D1SearchQueryBuilder. Callers pass the plain D1 database binding.
 */
export async function createCloudflareSdk(
  options: CloudflareSdkOptions,
): Promise<SdkInterface> {
  const vectorDimensions = options.vectorDimensions ?? 32;
  const connection = new D1ConnectionDriver(options.database);
  const schema = new D1SchemaBuilder(vectorDimensions);
  const searchQuery = new D1SearchQueryBuilder(vectorDimensions);

  const d1RdfjsStore = new D1RdfjsStore({
    connection,
    matchPageSize: options.matchPageSize,
    maxLookupChunkSize: options.maxLookupChunkSize,
    maxWriteBatchSize: options.maxWriteBatchSize,
    schemaBuilder: schema,
  });

  await d1RdfjsStore.ensureSchema();

  const textSplitter = options.textSplitter ??
    new RecursiveCharacterTextSplitter({ chunkSize: 1000 });

  const searchIndexProjector = new D1SearchIndexProjector({
    ...options,
    connection,
    searchQueryBuilder: searchQuery,
    textSplitter,
  });

  const searchIndex = new CloudflareSearchIndex({
    ...options,
    connection,
    searchQueryBuilder: searchQuery,
    textSplitter,
  });

  const quadStore = new D1QuadStore({
    ...options,
    connection,
    store: d1RdfjsStore,
    searchQueryBuilder: searchQuery,
    searchIndexProjector,
  });

  const sparqlEngine = new WazooSparqlEngine({
    store: d1RdfjsStore as unknown as rdfjs.Store,
    createTransaction: () => quadStore.createTransaction(),
  });

  return new Sdk({
    quadStore,
    searchIndex,
    sparqlEngine,
  });
}
