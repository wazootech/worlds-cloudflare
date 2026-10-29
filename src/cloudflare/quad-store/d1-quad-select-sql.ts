import {
  type D1QuadPattern,
  generatePlaceholders,
} from "./d1-quad-sql-types.ts";
import { buildD1QuadPatternWhereClause } from "./d1-quad-where-sql.ts";

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
