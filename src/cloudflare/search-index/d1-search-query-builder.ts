import type { QuadFilter } from "@worlds/sdk/quad-store";
import type { SearchRequest } from "@worlds/sdk/search-index";

const D1_FTS_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "please",
  "that",
  "the",
  "their",
  "these",
  "those",
  "this",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

/** RRF_REFERENCE_CONSTANT is the reciprocal-rank constant used by both backends (k = 60). */
export const RRF_REFERENCE_CONSTANT = 60;

/** ColumnMapping maps QuadFilter dimensions to SQL column names. */
interface ColumnMapping {
  subjects: string;
  predicates: string;
  graphs: string;
}

/** CHUNKS_TABLE_COLUMNS maps QuadFilter fields to chunks table column names. */
const CHUNKS_TABLE_COLUMNS: ColumnMapping = {
  subjects: "chunks.subject",
  predicates: "chunks.predicate",
  graphs: "chunks.graph",
};

/**
 * generatePlaceholders generates a comma-delimited set of parameterized SQLite bound variables.
 */
function generatePlaceholders(count: number): string {
  return Array(count).fill("?").join(", ");
}

/**
 * buildIncludeExcludeFilterClauses builds parameterized WHERE fragments from a QuadFilter using the given column mapping.
 */
function buildIncludeExcludeFilterClauses(
  filter: QuadFilter | undefined,
  columnMapping: ColumnMapping,
): { whereClauses: string[]; filterArgs: string[] } {
  const whereClauses: string[] = [];
  const filterArgs: string[] = [];

  const filterConfigurations = [
    {
      values: filter?.exclude?.subjects,
      column: columnMapping.subjects,
      operator: "NOT IN",
    },
    {
      values: filter?.exclude?.predicates,
      column: columnMapping.predicates,
      operator: "NOT IN",
    },
    {
      values: filter?.exclude?.graphs,
      column: columnMapping.graphs,
      operator: "NOT IN",
    },
    {
      values: filter?.include?.subjects,
      column: columnMapping.subjects,
      operator: "IN",
    },
    {
      values: filter?.include?.predicates,
      column: columnMapping.predicates,
      operator: "IN",
    },
    {
      values: filter?.include?.graphs,
      column: columnMapping.graphs,
      operator: "IN",
    },
  ] as const;

  for (const { values, column, operator } of filterConfigurations) {
    if (values?.length) {
      const placeholders = generatePlaceholders(values.length);
      whereClauses.push(`${column} ${operator} (${placeholders})`);
      filterArgs.push(...values);
    }
  }

  return { whereClauses, filterArgs };
}

/**
 * sanitizeFtsQuery defends SQLite against internal parsing crash vectors
 * by splitting inputs into safe token fragments (Unicode letters, numbers,
 * and combining marks — FTS5's default unicode61 tokenizer handles the
 * rest), stripping filler words, and wrapping the remaining content words
 * in explicit quotes.
 *
 * Returns an empty string when the query contains no searchable tokens
 * (e.g. pure punctuation); callers must treat that as "no keyword match"
 * rather than emitting `MATCH ""` (which crashes FTS5).
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) =>
      token
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}]+/gu, "")
    )
    .filter((token) => token.length > 0);

  const filteredTokens = tokens.filter((token) => !D1_FTS_STOPWORDS.has(token));
  const normalizedTokens = filteredTokens.length > 0 ? filteredTokens : tokens;

  return normalizedTokens
    .map((token) => `"${token.replace(/"/g, "")}"`)
    .join(" ");
}

/** Maximum embedding dimensions accepted by D1SearchQueryBuilder (Vectorize cap: 1536 float32). */
const D1_SEARCH_QUERY_BUILDER_MAX_VECTOR_DIMENSIONS = 1536;

/**
 * D1SearchQueryBuilder builds keyword-only FTS5 chunk queries against the
 * `chunks`/`chunks_fts` tables. The vector signal lives outside D1 (Vectorize,
 * Phase C), so no `vector_top_k` / `vector32` SQL is emitted here; chunk rows
 * store the F32_BLOB width for future Vectorize sync.
 */
export class D1SearchQueryBuilder {
  public readonly vectorDimensions: number;

  public constructor(vectorDimensions: number) {
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
  }

  public buildInsertChunk(insertOptions: {
    quad_id: string;
    subject: string;
    predicate: string;
    graph: string;
    value: string;
    fts_value: string;
    vector?: Float32Array | null;
  }): { sql: string; args: (string | number | Uint8Array | null)[] } {
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
    return {
      sql:
        `INSERT INTO chunks (quad_id, subject, predicate, graph, value, fts_value, vector)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args,
    };
  }

  public buildDeleteByQuadIds(
    quadIds: string[],
  ): { sql: string; args: string[] } {
    const placeholders = generatePlaceholders(quadIds.length);
    return {
      sql: `DELETE FROM chunks WHERE quad_id IN (${placeholders})`,
      args: quadIds,
    };
  }

  public sanitizeFtsQuery(query: string): string {
    return sanitizeFtsQuery(query);
  }

  public buildSearchQuery(
    request: SearchRequest,
    searchBuildOptions: { limit: number },
  ): { sql: string; args: (string | number)[] } {
    const { limit } = searchBuildOptions;

    const { whereClauses, filterArgs } = buildIncludeExcludeFilterClauses(
      request,
      CHUNKS_TABLE_COLUMNS,
    );

    const whereFilter = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const hasQuery = !!request.query && request.query.trim().length > 0;
    const sanitizedQuery = hasQuery ? sanitizeFtsQuery(request.query) : "";
    // A present query with zero searchable tokens (pure punctuation, emoji)
    // must not emit `MATCH ""` — FTS5 crashes on the empty match string.
    const hasKeyword = sanitizedQuery.length > 0;

    if (hasKeyword) {
      const args: (string | number)[] = [
        sanitizedQuery,
        limit,
        ...filterArgs,
        limit,
      ];

      const sql = `
      WITH fts_matches AS (
        SELECT
          rowid,
          row_number() OVER (ORDER BY rank) AS rank_number,
          rank AS score
        FROM
          chunks_fts
        WHERE
          chunks_fts MATCH ?
        LIMIT ?
      ), final AS (
        SELECT
          chunks.subject,
          chunks.predicate,
          chunks.graph,
          chunks.value,
          COALESCE(1.0 / (${RRF_REFERENCE_CONSTANT} + fts_matches.rank_number), 0.0) AS combined_rank
        FROM
          fts_matches
          JOIN chunks ON chunks.id = fts_matches.rowid
        ${whereFilter}
        ORDER BY
          combined_rank DESC
        LIMIT ?
      )
      SELECT * FROM final;
    `;
      return { sql, args };
    }

    return {
      sql:
        "SELECT NULL as subject, NULL as predicate, NULL as graph, NULL as value, 0 as combined_rank WHERE 0 = 1",
      args: [],
    };
  }
}
