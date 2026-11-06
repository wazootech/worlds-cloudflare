import type { SearchRequest } from "@worlds/sdk/search-index";
import {
  generatePlaceholders,
  RRF_FUSION_K,
  sanitizeFtsQuery,
} from "@worlds/sqlite/sql-core";
import type { SqlStatement } from "@worlds/sqlite/sql-core";
import { buildD1KeywordSearchStatement } from "./d1-search-query-sql.ts";

export { sanitizeFtsQuery };

/**
 * RRF_REFERENCE_CONSTANT is the reciprocal-rank constant used by both backends
 * (k = 60), kept as a compatibility alias for sql-core's RRF_FUSION_K.
 * @deprecated Import RRF_FUSION_K from @worlds/sqlite/sql-core instead.
 */
export const RRF_REFERENCE_CONSTANT = RRF_FUSION_K;

/** Maximum embedding dimensions accepted by D1SearchQueryBuilder (Vectorize cap: 1536 float32). */
const D1_SEARCH_QUERY_BUILDER_MAX_VECTOR_DIMENSIONS = 1536;

/**
 * D1SearchQueryBuilder builds keyword-only FTS5 chunk queries against the
 * `chunks`/`chunks_fts` tables. The vector signal lives outside D1 (Vectorize,
 * Phase C), so no `vector_top_k` / `vector32` SQL is emitted here; chunk rows
 * store the F32_BLOB width for future Vectorize sync.
 */
export interface D1SearchQueryBuilderOptions {
  worldId?: string;
}

export class D1SearchQueryBuilder {
  public readonly vectorDimensions: number;
  public readonly worldId?: string;

  public constructor(
    vectorDimensions: number,
    options?: D1SearchQueryBuilderOptions,
  ) {
    const dimensions = Math.floor(Number(vectorDimensions));
    if (
      !Number.isFinite(dimensions) ||
      dimensions < 1 ||
      dimensions > D1_SEARCH_QUERY_BUILDER_MAX_VECTOR_DIMENSIONS
    ) {
      throw new Error(
        `vectorDimensions must be a finite integer in [1, ${D1_SEARCH_QUERY_BUILDER_MAX_VECTOR_DIMENSIONS}], received: ${
          String(vectorDimensions)
        }`,
      );
    }
    this.vectorDimensions = dimensions;
    this.worldId = options?.worldId;
  }

  public buildInsertChunk(insertOptions: {
    quad_id: string;
    subject: string;
    predicate: string;
    graph: string;
    value: string;
    fts_value: string;
    vector?: Float32Array | null;
    world_id?: string;
  }): SqlStatement {
    const args: (string | number | Uint8Array | null)[] = [
      insertOptions.quad_id,
      insertOptions.subject,
      insertOptions.predicate,
      insertOptions.graph,
      insertOptions.value,
      insertOptions.fts_value,
    ];
    if (insertOptions.vector) {
      args.push(new Uint8Array(insertOptions.vector.buffer));
    } else {
      args.push(null);
    }
    if (this.worldId) args.push(insertOptions.world_id ?? this.worldId);
    return {
      sql:
        `INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value, vector${
          this.worldId ? ", world_id" : ""
        })
          VALUES (?, ?, ?, ?, ?, ?, ?${this.worldId ? ", ?" : ""})`,
      args,
    };
  }

  public buildDeleteByQuadIds(
    quadIds: string[],
  ): SqlStatement {
    const placeholders = generatePlaceholders(quadIds.length);
    return {
      sql: `DELETE FROM chunks WHERE quad_id IN (${placeholders})${
        this.worldId ? " AND world_id = ?" : ""
      }`,
      args: this.worldId ? [...quadIds, this.worldId] : quadIds,
    };
  }

  /**
   * buildChunkVectorLookupByQuadIds selects the fields needed to recompute
   * deterministic vector ids (`buildSearchResultId`) for the chunk rows of
   * the given quads — used by the projector to delete stale vectors from the
   * outside-D1 vector index before refreshing chunk rows.
   */
  public buildChunkVectorLookupByQuadIds(
    quadIds: string[],
  ): SqlStatement {
    const placeholders = generatePlaceholders(quadIds.length);
    return {
      sql:
        `SELECT quad_id, subject, predicate, graph, value FROM chunks WHERE quad_id IN (${placeholders})${
          this.worldId ? " AND world_id = ?" : ""
        }`,
      args: this.worldId ? [...quadIds, this.worldId] : quadIds,
    };
  }

  public sanitizeFtsQuery(query: string): string {
    return sanitizeFtsQuery(query);
  }

  public buildSearchQuery(
    request: SearchRequest,
    searchBuildOptions: { limit: number },
  ): SqlStatement {
    return buildD1KeywordSearchStatement(
      request,
      searchBuildOptions.limit,
      this.worldId,
    );
  }
}
