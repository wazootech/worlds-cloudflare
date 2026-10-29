import { generatePlaceholders } from "./d1-quad-sql-types.ts";

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

export function buildWipeAllGraphDataStatements(
  worldId?: string,
): Array<{ sql: string; args: (string | undefined)[] }> {
  const suffix = worldId ? " WHERE world_id = ?" : "";
  return [
    { sql: `DELETE FROM chunks${suffix}`, args: worldId ? [worldId] : [] },
    { sql: `DELETE FROM quads${suffix}`, args: worldId ? [worldId] : [] },
  ];
}
