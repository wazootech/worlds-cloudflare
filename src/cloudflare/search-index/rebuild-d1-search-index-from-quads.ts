import type * as rdfjs from "@rdfjs/types";
import { filterQuads } from "@worlds/sdk/quad-store";
import { quadFromD1Row } from "@/cloudflare/d1/d1-quad-row.ts";
import {
  buildMatchQuadsQuery,
  DEFAULT_D1_MATCH_PAGE_SIZE,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import {
  type ProjectSearchChunksOptions,
  refreshSearchChunksForQuads,
} from "./project-search-chunks.ts";

/**
 * RebuildD1SearchIndexFromQuadsResult reports how many quads and chunk rows were processed.
 */
export interface RebuildD1SearchIndexFromQuadsResult {
  /** processedQuadCount is the number of quads read from durable storage. */
  processedQuadCount: number;
  /** chunkRowCount is the number of chunk rows written to FTS tables. */
  chunkRowCount: number;
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
  let afterQuadId: string | undefined;

  for (;;) {
    const query = buildMatchQuadsQuery(
      { subject: null, predicate: null, object: null, graph: null },
      { afterQuadId, limit: pageSize },
      searchQueryBuilder.worldUid,
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
      chunkRowCount += await refreshSearchChunksForQuads(pageQuads, options);
    }

    if (resultSet.rows.length < pageSize) {
      break;
    }
  }

  return { processedQuadCount, chunkRowCount };
}

/**
 * createD1SearchIndexRebuilder returns a closure that rebuilds search chunks using stable D1 dependencies.
 */
export function createD1SearchIndexRebuilder(
  dependencies: ReadProjectSearchChunksOptions,
): () => Promise<RebuildD1SearchIndexFromQuadsResult> {
  return () => rebuildD1SearchIndexFromQuads(dependencies);
}
