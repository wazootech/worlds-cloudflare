import type { SqlDialect } from "@worlds/sqlite/sql-core";
import type { EmbeddedChunk } from "@worlds/sdk/search-index/quad-chunker";
import type { D1Statement } from "@/cloudflare/d1/d1-connection-driver.ts";
import { buildInsertRow } from "@/cloudflare/d1/d1-quad-row.ts";
import {
  buildBulkInsertQuads,
  buildDeleteDerivedQuadsByQuadIds,
  buildDeleteQuadsByQuadIds,
  buildWipeAllGraphDataStatements,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import type { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import type { D1DerivedChanges } from "./d1-derived-changes.ts";

/** D1CommitDialectOptions configures how the shared core's decisions become D1 statements. */
export interface D1CommitDialectOptions {
  /** searchQueryBuilder builds the chunk-row statements. */
  searchQueryBuilder: D1SearchQueryBuilder;

  /** worldId scopes every statement to one logical world. */
  worldId?: string;

  /** lookupChunkSize is the ids per IN clause (host-parameter cap, world id reserved). */
  lookupChunkSize: number;

  /** derived is the inference change set; its presence marks asserted rows `derived = 0`. */
  derived?: D1DerivedChanges;

  /** onChunkRows sees every chunk row the core builds, so their vectors can reach the outside-D1 index. */
  onChunkRows?: (rows: readonly EmbeddedChunk[]) => void;
}

/** chunked slices `ids` into IN-clause sized groups and builds one statement per group. */
function chunked(
  ids: readonly string[],
  size: number,
  build: (chunk: string[]) => D1Statement,
): D1Statement[] {
  const statements: D1Statement[] = [];
  for (let index = 0; index < ids.length; index += size) {
    statements.push(build(ids.slice(index, index + size)));
  }
  return statements;
}

/**
 * createD1CommitDialect builds one commit's statements. Create one per commit:
 * the inference change set rides the first `buildDeletions` call, which the
 * core makes whenever the patch deletes or writes anything, and every quad
 * delete in that call precedes the derived writes, as inference requires.
 *
 * `buildDeletions` removes quad rows only. A deleted quad's chunk rows stay
 * until a reindex or the hosted API's orphan cleanup: they are the only record
 * of the vector ids to remove from the outside-D1 vector index.
 */
export function createD1CommitDialect(
  options: D1CommitDialectOptions,
): SqlDialect<D1Statement> {
  const { worldId, lookupChunkSize, searchQueryBuilder, derived } = options;
  let derivedPending = derived;
  const deleteChunks = (ids: readonly string[]) =>
    chunked(
      ids,
      lookupChunkSize,
      (chunk) => searchQueryBuilder.buildDeleteByQuadIds(chunk),
    );
  const takeDerivedStatements = (): D1Statement[] => {
    const changes = derivedPending;
    derivedPending = undefined;
    if (!changes) return [];
    return [
      ...chunked(
        changes.removeIds,
        lookupChunkSize,
        (chunk) => buildDeleteDerivedQuadsByQuadIds(chunk, worldId),
      ),
      // OR IGNORE: a quad that is asserted (now or already) stays asserted.
      ...buildBulkInsertQuads(changes.addRows, { orIgnore: true }),
    ];
  };
  return {
    keyOf: (_quad, hash) => hash,
    buildWipe: () => buildWipeAllGraphDataStatements(worldId),
    // Chunk rows are replaced per quad (see buildChunkRows), so a rebuild
    // needs no wipe; chunk rows of deleted quads are left to the orphan cleanup.
    buildClearChunks: () => [],
    buildDeletions: (keys) => [
      ...chunked(
        keys,
        lookupChunkSize,
        (chunk) => buildDeleteQuadsByQuadIds(chunk, worldId),
      ),
      ...takeDerivedStatements(),
    ],
    buildInserts: (quads, _keys, hashes) =>
      buildBulkInsertQuads(quads.map((quad, index) => ({
        ...buildInsertRow(quad, hashes[index]!),
        world_id: worldId,
        ...(derived && { derived: 0 as const }),
      }))),
    buildChunkRows: (rows) => {
      options.onChunkRows?.(rows);
      return [
        ...deleteChunks([...new Set(rows.map((row) => row.chunk.quad_id))]),
        ...rows.map(({ chunk, ftsValue, vector }) =>
          searchQueryBuilder.buildInsertChunk({
            quad_id: chunk.quad_id,
            subject: chunk.subject,
            predicate: chunk.predicate,
            graph: chunk.graph,
            value: chunk.value,
            fts_value: ftsValue,
            vector: vector ? new Float32Array(vector) : undefined,
            world_id: worldId,
          })
        ),
      ];
    },
    buildCleanup: (keys) => [
      ...chunked(
        keys,
        lookupChunkSize,
        (chunk) => buildDeleteQuadsByQuadIds(chunk, worldId),
      ),
      ...deleteChunks(keys),
    ],
  };
}
