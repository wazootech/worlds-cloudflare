import {
  D1_INSERT_QUAD_COLUMN_COUNT,
  D1_INSERT_QUAD_ROWS_PER_STATEMENT,
  generatePlaceholders,
  type InsertQuadRow,
} from "./d1-quad-sql-types.ts";

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
