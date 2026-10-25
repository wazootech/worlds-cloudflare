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

  world_id?: string;

  /**
   * derived marks a row materialized by inference (1) instead of asserted (0).
   * Left undefined, the column is omitted from the INSERT, which keeps
   * databases without `quads.derived` working.
   */
  derived?: 0 | 1;

  g: string;

  g_type: string;
}

export function generatePlaceholders(count: number): string {
  return Array(count).fill("?").join(", ");
}

export function buildDeleteQuadsByQuadIds(
  quadIds: string[],
  worldId?: string,
): { sql: string; args: string[] } {
  const placeholders = generatePlaceholders(quadIds.length);
  return {
    sql: `DELETE FROM quads WHERE quad_id IN (${placeholders})${
      worldId ? " AND world_id = ?" : ""
    }`,
    args: worldId ? [...quadIds, worldId] : quadIds,
  };
}

/**
 * buildDeleteDerivedQuadsByQuadIds deletes only inferred rows, so inference
 * can never remove an asserted quad.
 */
export function buildDeleteDerivedQuadsByQuadIds(
  quadIds: string[],
  worldId?: string,
): { sql: string; args: string[] } {
  const placeholders = generatePlaceholders(quadIds.length);
  return {
    sql: `DELETE FROM quads WHERE derived = 1 AND quad_id IN (${placeholders})${
      worldId ? " AND world_id = ?" : ""
    }`,
    args: worldId ? [...quadIds, worldId] : quadIds,
  };
}

/** buildDeleteAllDerivedQuads removes every inferred row, never an asserted one. */
export function buildDeleteAllDerivedQuads(
  worldId?: string,
): { sql: string; args: string[] } {
  return {
    sql: `DELETE FROM quads WHERE derived = 1${
      worldId ? " AND world_id = ?" : ""
    }`,
    args: worldId ? [worldId] : [],
  };
}

/** buildSelectExistingQuadIds finds stored ids; `assertedOnly` ignores inferred rows. */
export function buildSelectExistingQuadIds(
  quadIds: string[],
  worldId?: string,
  options: { assertedOnly?: boolean } = {},
): { sql: string; args: string[] } {
  const placeholders = generatePlaceholders(quadIds.length);
  return {
    sql: `SELECT quad_id AS id FROM quads WHERE quad_id IN (${placeholders})${
      options.assertedOnly ? " AND derived = 0" : ""
    }${worldId ? " AND world_id = ?" : ""}`,
    args: worldId ? [...quadIds, worldId] : quadIds,
  };
}

/** buildCountAssertedQuads counts the asserted (not inferred) rows. */
export function buildCountAssertedQuads(
  worldId?: string,
): { sql: string; args: string[] } {
  return {
    sql: `SELECT COUNT(*) AS count FROM quads WHERE derived = 0${
      worldId ? " AND world_id = ?" : ""
    }`,
    args: worldId ? [worldId] : [],
  };
}

/** buildSelectAssertedQuadsPage pages the asserted rows by quad_id. */
export function buildSelectAssertedQuadsPage(
  pageOptions: { afterQuadId?: string; limit: number },
  worldId?: string,
): { sql: string; args: string[] } {
  const conditions = ["derived = 0"];
  const args: string[] = [];
  if (worldId) {
    conditions.push("world_id = ?");
    args.push(worldId);
  }
  if (pageOptions.afterQuadId) {
    conditions.push("quad_id > ?");
    args.push(pageOptions.afterQuadId);
  }
  args.push(String(Math.max(1, Math.floor(pageOptions.limit))));
  return {
    sql:
      `SELECT quad_id AS id, s, s_type, p, o, o_type, o_datatype, o_lang, g, g_type FROM quads WHERE ${
        conditions.join(" AND ")
      } ORDER BY quad_id ASC LIMIT ?`,
    args,
  };
}

export function buildMatchQuadsQuery(
  pattern: D1QuadPattern,
  pageOptions?: { afterQuadId?: string; limit?: number },
  worldId?: string,
): { sql: string; args: (string | null)[] } {
  const { conditions, args } = buildD1QuadPatternWhereClause(pattern);
  if (worldId) {
    conditions.push("world_id = ?");
    args.push(worldId);
  }

  if (pageOptions?.afterQuadId) {
    conditions.push("quad_id > ?");
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
      `SELECT quad_id AS id, s, s_type, p, o, o_type, o_datatype, o_lang, g, g_type FROM quads ${whereClause} ORDER BY quad_id ASC${limitClause}`,
    args,
  };
}

export function buildCountQuadsQuery(
  pattern: D1QuadPattern,
  worldId?: string,
): { sql: string; args: (string | null)[] } {
  const { conditions, args } = buildD1QuadPatternWhereClause(pattern);
  if (worldId) {
    conditions.push("world_id = ?");
    args.push(worldId);
  }
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
): { sql: string; args: (string | null | number)[] } {
  return buildBulkInsertQuads([insertQuadOptions])[0];
}

/**
 * buildBulkInsertQuads builds one INSERT per row. By default a row replaces an
 * existing quad_id; `orIgnore` keeps the existing row instead, which is how
 * inferred rows are written so they can never overwrite an asserted one.
 */
export function buildBulkInsertQuads(
  insertQuadRows: InsertQuadRow[],
  options: { orIgnore?: boolean } = {},
): Array<{ sql: string; args: (string | null | number)[] }> {
  if (insertQuadRows.length === 0) {
    return [];
  }

  const statements: Array<
    { sql: string; args: (string | null | number)[] }
  > = [];

  for (
    let rowOffset = 0;
    rowOffset < insertQuadRows.length;
    rowOffset += D1_INSERT_QUAD_ROWS_PER_STATEMENT
  ) {
    const rowBatch = insertQuadRows.slice(
      rowOffset,
      rowOffset + D1_INSERT_QUAD_ROWS_PER_STATEMENT,
    );
    const hasWorld = rowBatch[0]?.world_id !== undefined;
    const hasDerived = rowBatch[0]?.derived !== undefined;
    const columnCount = D1_INSERT_QUAD_COLUMN_COUNT + (hasWorld ? 1 : 0) +
      (hasDerived ? 1 : 0);
    const valuePlaceholders = rowBatch
      .map(() => `(${generatePlaceholders(columnCount)})`)
      .join(", ");
    const args: (string | null | number)[] = [];

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
        ...(hasWorld ? [insertQuadRow.world_id!] : []),
        ...(hasDerived ? [insertQuadRow.derived!] : []),
      );
    }

    if (args.length > rowBatch.length * columnCount) {
      throw new Error(
        `buildBulkInsertQuads: batch exceeds D1 host-parameter budget (${args.length})`,
      );
    }

    statements.push({
      sql: `INSERT OR ${
        options.orIgnore ? "IGNORE" : "REPLACE"
      } INTO quads (quad_id, s, s_type, p, o, o_type, o_datatype, o_lang, g, g_type${
        hasWorld ? ", world_id" : ""
      }${hasDerived ? ", derived" : ""}) VALUES ${valuePlaceholders}`,
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

export function buildWipeAllGraphDataStatements(
  worldId?: string,
): Array<{ sql: string; args: (string | undefined)[] }> {
  const suffix = worldId ? " WHERE world_id = ?" : "";
  return [
    { sql: `DELETE FROM chunks${suffix}`, args: worldId ? [worldId] : [] },
    { sql: `DELETE FROM quads${suffix}`, args: worldId ? [worldId] : [] },
  ];
}
