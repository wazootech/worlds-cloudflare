import { rebuildSqlSearchIndex } from "@worlds/sqlite/sql-core";
import { effectiveLookupChunkSize } from "@/cloudflare/d1/d1-batch-executor.ts";
import { createD1CommitDialect } from "@/cloudflare/commit/d1-commit-dialect.ts";
import { createD1CommitDriver } from "@/cloudflare/commit/d1-commit-driver.ts";
import { DEFAULT_D1_MATCH_PAGE_SIZE } from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { D1VectorSync } from "./d1-vector-sync.ts";
import {
  isFullRebuild,
  type ProjectSearchChunksOptions,
  toProjectionOptions,
} from "./project-search-chunks-options.ts";
import type { VectorSyncReport } from "./vector-sync-report.ts";

/**
 * RebuildD1SearchIndexFromQuadsResult reports how many quads and chunk rows were processed.
 */
export interface RebuildD1SearchIndexFromQuadsResult {
  /** processedQuadCount is the number of quads read from durable storage. */
  processedQuadCount: number;
  /** chunkRowCount is the number of chunk rows written to FTS tables. */
  chunkRowCount: number;
  /** vectorSync reports what reached the outside-D1 vector index (#40). */
  vectorSync: VectorSyncReport;
}

export interface ReadProjectSearchChunksOptions
  extends ProjectSearchChunksOptions {
  readPageSize?: number;
}

/**
 * rebuildD1SearchIndexFromQuads rebuilds FTS chunk rows from the `quads` table
 * without re-importing graph data, through the shared `rebuildSqlSearchIndex`.
 *
 * Use after schema upgrades, label predicate changes, or discovery-index tuning so existing corpora pick up refreshed `fts_value`.
 *
 * An unscoped rebuild clears the world's chunk rows first, so rows of quads
 * that no longer exist go too. With an include/exclude filter the rebuild is
 * scoped: it replaces only the chunk rows of the matching quads and leaves the
 * rest alone. `processedQuadCount` counts every stored quad scanned.
 *
 * When vector sync is on and no include/exclude filter narrows the rebuild,
 * the world's vectors are purged first (worlds-cloudflare#71 item 3): quads
 * removed since the last projection have no surviving D1 row to derive a
 * vector id from, so a rebuild that only upserts would leave their vectors
 * searchable forever. Deleting first and re-upserting makes reindex a true
 * reconcile; a purge failure is counted as drift, not thrown. An embedding
 * failure throws.
 */
export async function rebuildD1SearchIndexFromQuads(
  options: ReadProjectSearchChunksOptions,
): Promise<RebuildD1SearchIndexFromQuadsResult> {
  const { worldId } = options.searchQueryBuilder;
  const sync = new D1VectorSync(options);
  if (isFullRebuild(options)) await sync.purgeWorld();
  const driver = createD1CommitDriver({
    ...options,
    worldId,
    inferenceEnabled: options.inference?.enabled === true,
    beforePage: sync.beforePage,
  });
  const dialect = createD1CommitDialect({
    searchQueryBuilder: options.searchQueryBuilder,
    worldId,
    lookupChunkSize: effectiveLookupChunkSize(
      options.maxLookupChunkSize,
      Boolean(worldId),
    ),
    onChunkRows: sync.collect,
  });
  const chunkRowCount = await rebuildSqlSearchIndex(
    driver,
    dialect,
    toProjectionOptions(options),
    {
      scope: { include: options.include, exclude: options.exclude },
      pageSize: Math.max(
        1,
        Math.floor(options.readPageSize ?? DEFAULT_D1_MATCH_PAGE_SIZE),
      ),
    },
  );
  await sync.flush();
  sync.logDrift("reindex");
  return {
    processedQuadCount: driver.processedQuadCount,
    chunkRowCount,
    vectorSync: sync.report,
  };
}

/**
 * createD1SearchIndexRebuilder returns a closure that rebuilds search chunks using stable D1 dependencies.
 */
export function createD1SearchIndexRebuilder(
  dependencies: ReadProjectSearchChunksOptions,
): () => Promise<RebuildD1SearchIndexFromQuadsResult> {
  return () => rebuildD1SearchIndexFromQuads(dependencies);
}
