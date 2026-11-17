import { buildWipeAllGraphDataStatements } from "./quad-store/d1-quad-delete-sql.ts";
import type { D1ConnectionDriver } from "./d1/d1-connection-driver.ts";
import type { VectorSearchIndex } from "./search-index/vector-search/mod.ts";

/**
 * PurgeWorldOptions configures purgeWorld.
 */
export interface PurgeWorldOptions {
  /** connection is the D1 connection driver the SDK uses. */
  connection: D1ConnectionDriver;

  /** worldId is the world being deleted. Required and validated: a purge is
   * irreversible, so it must never run unscoped across a shared database. */
  worldId: string;

  /** vectorSearch is the optional outside-D1 vector index bound to this
   * world; when present its vectors for this world are deleted too. */
  vectorSearch?: VectorSearchIndex;
}

/**
 * PurgeWorldResult reports what purgeWorld removed.
 */
export interface PurgeWorldResult {
  /** vectorsPurged is true when the vector index reported a successful purge. */
  vectorsPurged: boolean;

  /** vectorsSkipped is true when no vectorSearch was configured, so no
   * vectors existed (or were reachable) for this purge. */
  vectorsSkipped: boolean;
}

/**
 * purgeWorld deletes every derived copy of a world's data: the `quads` rows
 * (asserted and inference-derived alike), the `chunks` rows (whose AFTER
 * DELETE trigger maintains `chunks_fts`), and — when a vectorSearch is
 * configured — every vector the index holds for the world
 * (worlds-cloudflare#71 item 6).
 *
 * The D1 statements run as one atomic batch, so the store is either fully
 * purged or untouched. The vector purge runs after the D1 batch commits:
 * if it throws, the D1 side is already gone and the error says so, so the
 * caller can retry just the vector half rather than re-running the wipe.
 */
export async function purgeWorld(
  options: PurgeWorldOptions,
): Promise<PurgeWorldResult> {
  const { worldId } = options;
  if (typeof worldId !== "string" || worldId.length === 0) {
    throw new Error(
      "purgeWorld: worldId must be a non-empty string; refusing to run an unscoped purge across every world in the database",
    );
  }

  await options.connection.batch(buildWipeAllGraphDataStatements(worldId));

  if (!options.vectorSearch) {
    return { vectorsPurged: false, vectorsSkipped: true };
  }
  await options.vectorSearch.deleteAll();
  return { vectorsPurged: true, vectorsSkipped: false };
}
