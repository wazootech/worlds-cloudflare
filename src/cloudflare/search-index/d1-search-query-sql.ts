import type { SearchRequest } from "@worlds/sdk/search-index";
import {
  buildIncludeExcludeFilterClauses,
  buildKeywordFtsStatement,
  sanitizeFtsQuery,
} from "@worlds/sqlite/sql-core";
import type { ColumnMapping, SqlStatement } from "@worlds/sqlite/sql-core";

/** CHUNKS_TABLE_COLUMNS maps QuadFilter fields to chunks table column names. */
const CHUNKS_TABLE_COLUMNS: ColumnMapping = {
  subjects: "chunks.subject",
  predicates: "chunks.predicate",
  graphs: "chunks.graph",
};

/** buildD1KeywordSearchStatement builds the keyword FTS5 chunk query (or the empty-result statement). */
export function buildD1KeywordSearchStatement(
  request: SearchRequest,
  limit: number,
  worldId?: string,
): SqlStatement {
  const { whereClauses, filterArgs } = buildIncludeExcludeFilterClauses(
    request,
    CHUNKS_TABLE_COLUMNS,
  );
  if (worldId) {
    whereClauses.push("chunks.world_id = ?");
    filterArgs.push(worldId);
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
    const statement = buildKeywordFtsStatement({
      sanitizedQuery,
      limit,
      whereFilter,
      filterArgs,
    });
    return {
      ...statement,
      sql: statement.sql.replaceAll("chunks.id", "chunks.chunk_id"),
    };
  }

  return {
    sql:
      "SELECT NULL as subject, NULL as predicate, NULL as graph, NULL as value, 0 as combined_rank WHERE 0 = 1",
    args: [],
  };
}
