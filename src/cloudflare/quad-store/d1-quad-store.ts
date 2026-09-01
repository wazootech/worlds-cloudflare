import type * as rdfjs from "@rdfjs/types";
import type {
  ExportRequest,
  ExportResponse,
  ImportRequest,
  QuadStoreInterface,
} from "@worlds/sdk/quad-store";
import {
  exportFromRdfjsStore,
  importViaTransaction,
  Transaction,
} from "@worlds/sdk/quad-store";
import { commitPatchToD1 } from "@/cloudflare/commit-patch-to-d1.ts";
import type { D1ClientBaseOptions } from "@/cloudflare/d1-client-base-options.ts";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import type {
  D1SearchIndexProjector,
  D1SearchQueryBuilder,
} from "@/cloudflare/search-index/mod.ts";
import {
  D1BatchExecutor,
  DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
} from "@/cloudflare/d1/d1-batch-executor.ts";

/**
 * D1QuadStoreOptions defines the configurations for the D1QuadStore.
 */
export interface D1QuadStoreOptions extends D1ClientBaseOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** store is the underlying D1 RDF/JS ReadSource store. */
  store: D1RdfjsStore;

  /** searchQueryBuilder supplies dimension-aware SQL used for deletions and chunk replication. */
  searchQueryBuilder: D1SearchQueryBuilder;

  /** searchIndexProjector manages text chunk synchronisation. */
  searchIndexProjector?: D1SearchIndexProjector;

  /** maxWriteBatchSize caps how many statements are sent per D1 write batch. Defaults to 500. */
  maxWriteBatchSize?: number;

  /** worldUid scopes all quad and search-index operations. */
  worldUid?: string;
}

/**
 * D1QuadStore implements the QuadStoreInterface for D1 backed durable persistence.
 * It encapsulates transaction routing, commits, and indexing synchronization.
 */
export class D1QuadStore implements QuadStoreInterface {
  public constructor(
    private readonly options: D1QuadStoreOptions,
  ) {}

  /**
   * import merges or replaces the underlying store with provided RDF source data.
   *
   * @param request The payload defining the ingestion source and overwrite mode.
   */
  public async import(request: ImportRequest): Promise<void> {
    await importViaTransaction(request, {
      createTransaction: () => this.createTransaction(),
    });
  }

  /**
   * export extracts the graph contents in raw quads or serialized formats.
   *
   * @param request The desired format specifications.
   */
  public async export(request: ExportRequest): Promise<ExportResponse> {
    return await exportFromRdfjsStore(
      this.options.store as unknown as rdfjs.Store,
      request,
    );
  }

  /**
   * createTransaction returns a pre-configured Transaction bound to internal commit hooks.
   */
  public createTransaction(): Transaction {
    return new Transaction({
      commit: async (patch, context) => {
        const isImport = context?.importMode !== undefined;
        const searchIndexOnImport = this.options.searchIndexOnImport ??
          "deferred";
        const skipSearchIndexProjection =
          this.options.searchIndexOnImport === "disabled" ||
          (isImport && searchIndexOnImport === "deferred");

        const { novelInsertions, novelQuadIds } = await commitPatchToD1(
          patch,
          { ...this.options, worldUid: this.options.worldUid },
          context,
        );

        if (!skipSearchIndexProjection && this.options.searchIndexProjector) {
          try {
            await this.options.searchIndexProjector.projectNovelQuads(
              novelInsertions,
              novelQuadIds,
            );
          } catch (error) {
            // Clean up chunk rows if search projection fails
            await stageChunkedDeletions(novelQuadIds, this.options);
            throw error;
          }
        }

        if (
          isImport && searchIndexOnImport === "deferred" &&
          this.options.searchIndexProjector
        ) {
          await this.options.searchIndexProjector.reindexAll();
        }
      },
    });
  }
}

/** stageChunkedDeletions removes chunk rows for the given quad ids after projection failure. */
async function stageChunkedDeletions(
  quadIds: string[],
  options: D1QuadStoreOptions,
): Promise<void> {
  const lookupChunkSize = options.maxLookupChunkSize ?? 100;
  const batchExecutor = new D1BatchExecutor({
    connection: options.connection,
    writeBatchSize: options.maxWriteBatchSize ??
      DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
  });
  for (let index = 0; index < quadIds.length; index += lookupChunkSize) {
    const chunk = quadIds.slice(index, index + lookupChunkSize);
    await batchExecutor.stage([
      options.searchQueryBuilder.buildDeleteByQuadIds(chunk),
    ]);
  }
  await batchExecutor.flush();
}
