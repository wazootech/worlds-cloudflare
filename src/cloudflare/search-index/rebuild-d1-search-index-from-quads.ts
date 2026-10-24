import type * as rdfjs from "@rdfjs/types";
import { filterQuads } from "@worlds/sdk/quad-store";
import { quadFromD1Row } from "@/cloudflare/d1/d1-quad-row.ts";
import {
  buildMatchQuadsQuery,
  buildSelectAssertedQuadsPage,
  DEFAULT_D1_MATCH_PAGE_SIZE,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import {
  type ProjectSearchChunksOptions,
  refreshSearchChunksForQuads,
} from "./project-search-chunks.ts";
import {
  emptyVectorSyncReport,
  logVectorSyncDrift,
  mergeVectorSyncReports,
  type VectorSyncReport,
} from "./vector-sync-report.ts";

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
 * rebuildD1SearchIndexFromQuads rebuilds FTS chunk rows from the `quads` table without re-importing graph data.
 *
 * Use after schema upgrades, label predicate changes, or discovery-index tuning so existing corpora pick up refreshed `fts_value`.
 */
export async function rebuildD1SearchIndexFromQuads(
  options: ReadProjectSearchChunksOptions,
): Promise<RebuildD1SearchIndexFromQuadsResult> {
  const {
    connection,
    include,
    exclude,
    readPageSize,
    searchQueryBuilder,
  } = options;
  const pageSize = Math.max(
    1,
    Math.floor(readPageSize ?? DEFAULT_D1_MATCH_PAGE_SIZE),
  );
  const matcher = filterQuads({ include, exclude });

  let processedQuadCount = 0;
  let chunkRowCount = 0;
  let vectorSync = emptyVectorSyncReport(
    Boolean(options.embeddingService && options.vectorSearch),
  );
  let afterQuadId: string | undefined;

  for (;;) {
    // Inferred rows are not indexed: they are rebuildable from asserted ones,
    // and indexing them would put entailed copies in search results.
    const query = options.inference?.enabled
      ? buildSelectAssertedQuadsPage(
        { afterQuadId, limit: pageSize },
        searchQueryBuilder.worldId,
      )
      : buildMatchQuadsQuery(
        { subject: null, predicate: null, object: null, graph: null },
        { afterQuadId, limit: pageSize },
        searchQueryBuilder.worldId,
      );
    const resultSet = await connection.execute(query);

    if (resultSet.rows.length === 0) {
      break;
    }

    const pageQuads: rdfjs.Quad[] = [];
    for (const row of resultSet.rows) {
      afterQuadId = String(row.id);
      try {
        const reconstructedQuad = quadFromD1Row(row);
        if (matcher(reconstructedQuad)) {
          pageQuads.push(reconstructedQuad);
        }
        processedQuadCount++;
      } catch (error) {
        console.warn(
          `rebuildD1SearchIndexFromQuads: skipping corrupt row s="${row.s}"`,
          error,
        );
      }
    }

    if (pageQuads.length > 0) {
      const refreshed = await refreshSearchChunksForQuads(pageQuads, options);
      chunkRowCount += refreshed.chunkRowCount;
      vectorSync = mergeVectorSyncReports(vectorSync, refreshed.vectorSync);
    }

    if (resultSet.rows.length < pageSize) {
      break;
    }
  }

  logVectorSyncDrift(vectorSync, {
    worldId: searchQueryBuilder.worldId,
    operation: "reindex",
  });
  return { processedQuadCount, chunkRowCount, vectorSync };
}

/**
 * createD1SearchIndexRebuilder returns a closure that rebuilds search chunks using stable D1 dependencies.
 */
export function createD1SearchIndexRebuilder(
  dependencies: ReadProjectSearchChunksOptions,
): () => Promise<RebuildD1SearchIndexFromQuadsResult> {
  return () => rebuildD1SearchIndexFromQuads(dependencies);
}
