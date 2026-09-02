import type { SearchRequest } from "@worlds/sdk/search-index";
import {
  buildIncludeExcludeFilterClauses,
  buildKeywordFtsStatement,
  generatePlaceholders,
  RRF_FUSION_K,
  sanitizeFtsQuery,
} from "@worlds/sqlite/sql-core";
import type { ColumnMapping, SqlStatement } from "@worlds/sqlite/sql-core";

export { sanitizeFtsQuery };

/**
 * RRF_REFERENCE_CONSTANT is the reciprocal-rank constant used by both backends
 * (k = 60), kept as a compatibility alias for sql-core's RRF_FUSION_K.
 * @deprecated Import RRF_FUSION_K from @worlds/sqlite/sql-core instead.
 */
export const RRF_REFERENCE_CONSTANT = RRF_FUSION_K;

/** CHUNKS_TABLE_COLUMNS maps QuadFilter fields to chunks table column names. */
const CHUNKS_TABLE_COLUMNS: ColumnMapping = {
  subjects: "chunks.subject",
  predicates: "chunks.predicate",
  graphs: "chunks.graph",
};

/** Maximum embedding dimensions accepted by D1SearchQueryBuilder (Vectorize cap: 1536 float32). */
const D1_SEARCH_QUERY_BUILDER_MAX_VECTOR_DIMENSIONS = 1536;

/**
 * D1SearchQueryBuilder builds keyword-only FTS5 chunk queries against the
 * `chunks`/`chunks_fts` tables. The vector signal lives outside D1 (Vectorize,
 * Phase C), so no `vector_top_k` / `vector32` SQL is emitted here; chunk rows
 * store the F32_BLOB width for future Vectorize sync.
 */
export interface D1SearchQueryBuilderOptions {
  worldUid?: string;
}

export class D1SearchQueryBuilder {
  public readonly vectorDimensions: number;
  public readonly worldUid?: string;

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
    this.worldUid = options?.worldUid;
  }

  public buildInsertChunk(insertOptions: {
    quad_id: string;
    subject: string;
    predicate: string;
    graph: string;
    value: string;
    fts_value: string;
    vector?: Float32Array | null;
    world_uid?: string;
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
    if (this.worldUid) args.push(insertOptions.world_uid ?? this.worldUid);
    return {
      sql:
        `INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value, vector${
          this.worldUid ? ", world_uid" : ""
        })
          VALUES (?, ?, ?, ?, ?, ?, ?${this.worldUid ? ", ?" : ""})`,
      args,
    };
  }

  public buildDeleteByQuadIds(
    quadIds: string[],
  ): SqlStatement {
    const placeholders = generatePlaceholders(quadIds.length);
    return {
      sql: `DELETE FROM chunks WHERE quad_id IN (${placeholders})${
        this.worldUid ? " AND world_uid = ?" : ""
      }`,
      args: this.worldUid ? [...quadIds, this.worldUid] : quadIds,
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
          this.worldUid ? " AND world_uid = ?" : ""
        }`,
      args: this.worldUid ? [...quadIds, this.worldUid] : quadIds,
    };
  }

  public sanitizeFtsQuery(query: string): string {
    return sanitizeFtsQuery(query);
  }

  public buildSearchQuery(
    request: SearchRequest,
    searchBuildOptions: { limit: number },
  ): SqlStatement {
    const { limit } = searchBuildOptions;

    const { whereClauses, filterArgs } = buildIncludeExcludeFilterClauses(
      request,
      CHUNKS_TABLE_COLUMNS,
    );
    if (this.worldUid) {
      whereClauses.push("chunks.world_uid = ?");
      filterArgs.push(this.worldUid);
    }

    const whereFilter = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const hasQuery = !!request.query && request.query.trim().length > 0;
    const sanitizedQuery = hasQuery ? sanitizeFtsQuery(request.query) : "";
    // A present query with zero searchable tokens (pure punctuation, emoji)
    // must not emit `MATCH ""` — FTS5 crashes on the empty match string.
    const hasKeyword = sanitizedQuery.length > 0;

    if (hasKeyword) {
      return buildKeywordFtsStatement({
        sanitizedQuery,
        limit,
        whereFilter,
        filterArgs,
      });
    }

    return {
      sql:
        "SELECT NULL as subject, NULL as predicate, NULL as graph, NULL as value, 0 as combined_rank WHERE 0 = 1",
      args: [],
    };
  }
}
