import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { isReplaceImportCommit } from "@worlds/sdk/quad-store";
import { planSearchIndexing } from "@worlds/sdk/search-index";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import { commitSqlPatch } from "@worlds/sqlite/sql-core";
import { effectiveLookupChunkSize } from "@/cloudflare/d1/d1-batch-executor.ts";
import { DEFAULT_D1_MATCH_PAGE_SIZE } from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import type { D1QuadStoreOptions } from "@/cloudflare/quad-store/d1-quad-store.ts";
import { isFullRebuild } from "@/cloudflare/search-index/project-search-chunks-options.ts";
import { createD1CommitDialect } from "./d1-commit-dialect.ts";
import { createD1CommitDriver } from "./d1-commit-driver.ts";
import { planD1DerivedChanges } from "./d1-derived-changes.ts";

/**
 * D1_DEFAULT_SEARCH_INDEX_ON_IMPORT is D1's default import mode, set
 * explicitly here instead of taking the shared default ("incremental"): hosted
 * D1 consumers depend on an import persisting quads first and rebuilding the
 * index once afterwards. Moving to the shared default is a separate change.
 */
export const D1_DEFAULT_SEARCH_INDEX_ON_IMPORT: SearchIndexOnImport =
  "deferred";

/**
 * commitD1Patch runs one D1 commit through the shared SQL commit core
 * (`commitSqlPatch`). D1 batches are not atomic with the outside-D1 Vectorize
 * index, which the platform forces: vectors sync after the D1 write lands, and
 * a failure there is logged drift that a reindex repairs. An embedding failure
 * throws before anything is written, so the caller can retry.
 */
export async function commitD1Patch(
  patch: Patch,
  context: TransactionContext | undefined,
  options: D1QuadStoreOptions,
): Promise<void> {
  const { connection, worldId, searchIndexProjector: projector } = options;
  const sync = projector?.createVectorSync();
  const driverOptions = {
    ...options,
    connection,
    inferenceEnabled: options.inference?.enabled === true,
    beforePage: sync?.beforePage,
  };
  const derived = options.inference?.enabled
    ? await planD1DerivedChanges(
      patch,
      context,
      options.inference,
      driverOptions,
    )
    : undefined;
  const indexing = planSearchIndexing(options.searchIndexOnImport, context, {
    defaultMode: D1_DEFAULT_SEARCH_INDEX_ON_IMPORT,
  });
  await commitSqlPatch(
    patch,
    context,
    createD1CommitDriver(driverOptions),
    createD1CommitDialect({
      searchQueryBuilder: options.searchQueryBuilder,
      worldId,
      lookupChunkSize: effectiveLookupChunkSize(
        options.maxLookupChunkSize,
        Boolean(worldId),
      ),
      derived,
      onChunkRows: sync?.collect,
    }),
    {
      filter: options,
      searchIndexOnImport: options.searchIndexOnImport,
      defaultSearchIndexOnImport: D1_DEFAULT_SEARCH_INDEX_ON_IMPORT,
      projection: projector?.projection,
      rebuildPageSize: DEFAULT_D1_MATCH_PAGE_SIZE,
      afterWrite: async () => {
        // A wipe deletes the chunk rows whose vector ids were the only record
        // of what to remove from the vector index (worlds-cloudflare#71 item 3),
        // so purge. A deferred rebuild purges too: it re-upserts every vector.
        const purge = indexing.reindexAfterCommit
          ? isFullRebuild(options)
          : isReplaceImportCommit(context) && indexing.projectDuringCommit;
        if (purge) await sync?.purgeWorld();
        await sync?.flush();
      },
    },
  );
  await sync?.flush();
  sync?.logDrift(indexing.reindexAfterCommit ? "reindex" : "import");
}
