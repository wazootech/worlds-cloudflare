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
import {
  applyD1Commit,
  planD1Commit,
} from "@/cloudflare/commit-patch-to-d1.ts";
import { isReplaceImportCommit } from "@worlds/sdk/quad-store";
import { planSearchIndexing } from "@worlds/sdk/search-index";
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
  effectiveLookupChunkSize,
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

  /** worldId scopes all quad and search-index operations. */
  worldId?: string;
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
        // D1 defaults to "deferred": an import skips chunk projection and
        // rebuilds the index once afterwards.
        const indexing = planSearchIndexing(
          this.options.searchIndexOnImport,
          context,
          { defaultMode: "deferred" },
        );
        const projector = this.options.searchIndexProjector;
        const options = { ...this.options, worldId: this.options.worldId };

        // Read-only work first: filter, hash, select the novel quads, then
        // chunk and embed them. A failure in any of it leaves D1 untouched.
        const plan = await planD1Commit(patch, options, context);
        const projection = indexing.projectDuringCommit && projector
          ? await projector.prepareProjection(
            plan.novelInsertions,
            plan.novelQuadIds,
          )
          : undefined;

        await applyD1Commit(plan, options, context);

        // A replace-import wipe deletes quads and chunk rows, but the vector
        // ids of the removed content are unrecoverable afterwards, so its
        // vectors would stay searchable (worlds-cloudflare#71 item 3). Purge
        // them here unless a reindex follows: the deferred reindex purges and
        // re-upserts itself. Purge failures are logged drift, never thrown.
        if (
          isReplaceImportCommit(context) && indexing.projectDuringCommit &&
          projector
        ) {
          try {
            const purge = await projector.purgeVectors();
            if (purge.staleDeleteFailures > 0) {
              console.error(
                "[vector-sync] replace-import vector purge failed; run reindex to repair",
                JSON.stringify({ errors: purge.errors }),
              );
            }
          } catch (error) {
            console.error(
              "[vector-sync] replace-import vector purge threw unexpectedly",
              error,
            );
          }
        }

        if (projection && projector) {
          try {
            await projector.writeProjection(projection);
          } catch (error) {
            // The quads are committed (D1 cannot roll back across batches);
            // remove the chunk rows so none refers to a half-projected quad.
            await stageChunkedDeletions(plan.novelQuadIds, this.options);
            throw error;
          }
        }

        if (indexing.reindexAfterCommit && projector) {
          await projector.reindexAll();
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
  const lookupChunkSize = effectiveLookupChunkSize(
    options.maxLookupChunkSize,
    Boolean(options.worldId),
  );
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
