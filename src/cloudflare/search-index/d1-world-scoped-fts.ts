import type { SqlStatement } from "@worlds/sqlite/sql-core";

/** RRF constant shared with the generic keyword plan (1 / (60 + rank)). */
const RRF_K = 60;

/**
 * buildWorldScopedKeywordStatement builds the keyword FTS5 query for a
 * multi-tenant `chunks` table. The `chunks_fts` index is shared by every world,
 * so the world and include/exclude filters are applied in the same join as the
 * MATCH, before ORDER BY rank and LIMIT. The candidate window is therefore
 * filled only with the requesting world's rows and other tenants' rows can
 * neither crowd out nor truncate it.
 *
 * Tradeoff: FTS5 still scores every matching row of the term across all
 * tenants to order the world's rows, so cost grows with the term's global
 * frequency instead of being bounded by `limit`. This favors correctness; a
 * per-world FTS table would be the structural fix.
 */
export function buildWorldScopedKeywordStatement(options: {
  sanitizedQuery: string;
  limit: number;
  whereClauses: string[];
  filterArgs: (string | number | Uint8Array | null)[];
}): SqlStatement {
  const conditions = ["chunks_fts MATCH ?", ...options.whereClauses];
  return {
    sql: `
      WITH scoped AS (
        SELECT
          chunks.subject AS subject,
          chunks.predicate AS predicate,
          chunks.graph AS graph,
          chunks.value AS value,
          chunks_fts.rank AS fts_rank
        FROM chunks_fts
        JOIN chunks ON chunks.chunk_id = chunks_fts.rowid
        WHERE ${conditions.join(" AND ")}
        ORDER BY chunks_fts.rank
        LIMIT ?
      )
      SELECT
        subject, predicate, graph, value,
        COALESCE(1.0 / (${RRF_K} + row_number() OVER (ORDER BY fts_rank)), 0.0) AS combined_rank
      FROM scoped
      ORDER BY combined_rank DESC
    `,
    args: [options.sanitizedQuery, ...options.filterArgs, options.limit],
  };
}
