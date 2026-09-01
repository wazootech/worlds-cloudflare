import type * as rdfjs from "@rdfjs/types";

const rdfLangStringIri =
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

const xsdStringIri = "http://www.w3.org/2001/XMLSchema#string";

export interface D1QuadPattern {
  subject: rdfjs.Term | null;

  predicate: rdfjs.Term | null;

  object: rdfjs.Term | null;

  graph: rdfjs.Term | null;
}

export interface D1QuadPatternWhereClause {
  conditions: string[];

  args: (string | null)[];
}

export const DEFAULT_D1_MATCH_PAGE_SIZE = 1000;

const D1_INSERT_QUAD_COLUMN_COUNT = 10;

/**
 * Keep quad writes to one row per statement. D1 has exhibited incorrect
 * parameter binding for multi-row INSERT OR REPLACE statements in batches;
 * D1BatchExecutor still groups these single-row statements atomically.
 */
export const D1_INSERT_QUAD_ROWS_PER_STATEMENT = 1;

export interface InsertQuadRow {
  quad_id: string;

  s: string;

  s_type: string;

  p: string;

  o: string;

  o_type: string;

  o_datatype?: string | null;

  o_lang?: string | null;

  g: string;

  g_type: string;
}

export function generatePlaceholders(count: number): string {
  return Array(count).fill("?").join(", ");
}

export function buildDeleteQuadsByQuadIds(
  quadIds: string[],
): { sql: string; args: string[] } {
  const placeholders = generatePlaceholders(quadIds.length);
  return {
    sql: `DELETE FROM quads WHERE id IN (${placeholders})`,
    args: quadIds,
  };
}

export function buildSelectExistingQuadIds(
  quadIds: string[],
): { sql: string; args: string[] } {
  const placeholders = generatePlaceholders(quadIds.length);
  return {
    sql: `SELECT id FROM quads WHERE id IN (${placeholders})`,
    args: quadIds,
  };
}

export function buildMatchQuadsQuery(
  pattern: D1QuadPattern,
  pageOptions?: { afterQuadId?: string; limit?: number },
): { sql: string; args: (string | null)[] } {
  const { conditions, args } = buildD1QuadPatternWhereClause(pattern);

  if (pageOptions?.afterQuadId) {
    conditions.push("id > ?");
    args.push(pageOptions.afterQuadId);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  let limitClause = "";
  if (pageOptions?.limit != null) {
    limitClause = " LIMIT ?";
    args.push(String(Math.max(1, Math.floor(pageOptions.limit))));
  }

  return {
    sql:
      `SELECT id, s, s_type, p, o, o_type, o_datatype, o_lang, g, g_type FROM quads ${whereClause} ORDER BY id ASC${limitClause}`,
    args,
  };
}

export function buildCountQuadsQuery(
  pattern: D1QuadPattern,
): { sql: string; args: (string | null)[] } {
  const { conditions, args } = buildD1QuadPatternWhereClause(pattern);
  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  return {
    sql: `SELECT COUNT(*) AS count FROM quads ${whereClause}`,
    args,
  };
}

export function buildInsertQuad(
  insertQuadOptions: InsertQuadRow,
): { sql: string; args: (string | null)[] } {
  return buildBulkInsertQuads([insertQuadOptions])[0];
}

export function buildBulkInsertQuads(
  insertQuadRows: InsertQuadRow[],
): Array<{ sql: string; args: (string | null)[] }> {
  if (insertQuadRows.length === 0) {
    return [];
  }

  const statements: Array<{ sql: string; args: (string | null)[] }> = [];

  for (
    let rowOffset = 0;
    rowOffset < insertQuadRows.length;
    rowOffset += D1_INSERT_QUAD_ROWS_PER_STATEMENT
  ) {
    const rowBatch = insertQuadRows.slice(
      rowOffset,
      rowOffset + D1_INSERT_QUAD_ROWS_PER_STATEMENT,
    );
    const valuePlaceholders = rowBatch
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    const args: (string | null)[] = [];

    for (const insertQuadRow of rowBatch) {
      args.push(
        insertQuadRow.quad_id,
        insertQuadRow.s,
        insertQuadRow.s_type,
        insertQuadRow.p,
        insertQuadRow.o,
        insertQuadRow.o_type,
        insertQuadRow.o_datatype ?? null,
        insertQuadRow.o_lang ?? null,
        insertQuadRow.g,
        insertQuadRow.g_type,
      );
    }

    if (
      args.length > D1_INSERT_QUAD_ROWS_PER_STATEMENT *
          D1_INSERT_QUAD_COLUMN_COUNT
    ) {
      throw new Error(
        `buildBulkInsertQuads: batch exceeds D1 host-parameter budget (${args.length})`,
      );
    }

    statements.push({
      sql:
        `INSERT OR REPLACE INTO quads (id, s, s_type, p, o, o_type, o_datatype, o_lang, g, g_type) VALUES ${valuePlaceholders}`,
      args,
    });
  }

  return statements;
}

export function buildD1QuadPatternWhereClause(
  pattern: D1QuadPattern,
): D1QuadPatternWhereClause {
  const conditions: string[] = [];
  const args: (string | null)[] = [];

  appendTermCondition(conditions, args, "s", "s_type", pattern.subject);
  appendTermCondition(conditions, args, "o", "o_type", pattern.object);

  if (pattern.predicate) {
    conditions.push("p = ?");
    args.push(pattern.predicate.value);
  }

  appendTermCondition(conditions, args, "g", "g_type", pattern.graph);

  return { conditions, args };
}

function appendTermCondition(
  conditions: string[],
  args: (string | null)[],
  valueColumn: string,
  typeColumn: string,
  term: rdfjs.Term | null,
): void {
  if (!term) return;

  conditions.push(`${valueColumn} = ?`);
  args.push(term.value);

  conditions.push(`${typeColumn} = ?`);
  args.push(term.termType);

  if (term.termType === "Literal") {
    const literalTerm = term as rdfjs.Literal;
    if (literalTerm.language) {
      conditions.push(`o_lang = ?`);
      args.push(literalTerm.language);
    }
    if (literalTerm.datatype) {
      const datatypeValue = literalTerm.datatype.value;
      if (datatypeValue === xsdStringIri) {
        conditions.push(
          `(o_datatype IS NULL OR o_datatype = '' OR o_datatype = '${xsdStringIri}')`,
        );
      } else if (datatypeValue === rdfLangStringIri) {
        conditions.push(
          `(o_datatype IS NULL OR o_datatype = '' OR o_datatype = '${rdfLangStringIri}')`,
        );
      } else {
        conditions.push(`o_datatype = ?`);
        args.push(datatypeValue);
      }
    }
  }
}

export function buildWipeAllGraphDataStatements(): Array<
  { sql: string; args: [] }
> {
  return [
    { sql: "DELETE FROM chunks", args: [] },
    { sql: "DELETE FROM quads", args: [] },
  ];
}
