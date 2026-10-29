import type * as rdfjs from "@rdfjs/types";

export const rdfLangStringIri =
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

export const xsdStringIri = "http://www.w3.org/2001/XMLSchema#string";

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

export const D1_INSERT_QUAD_COLUMN_COUNT = 10;

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
