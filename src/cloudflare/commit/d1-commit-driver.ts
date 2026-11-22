import type * as rdfjs from "@rdfjs/types";
import { filterQuads, type QuadFilter } from "@worlds/sdk/quad-store";
import type { SqlCommitDriver } from "@worlds/sqlite/sql-core";
import type {
  D1ConnectionDriver,
  D1Statement,
} from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  DEFAULT_D1_MAX_WRITE_BATCH_SIZE,
  effectiveLookupChunkSize,
} from "@/cloudflare/d1/d1-batch-executor.ts";
import { quadFromD1Row } from "@/cloudflare/d1/d1-quad-row.ts";
import {
  buildMatchQuadsQuery,
  buildSelectAssertedQuadsPage,
  buildSelectExistingQuadIds,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";

/** D1CommitDriverOptions configures the D1 execution surface of the shared SQL commit core. */
export interface D1CommitDriverOptions extends QuadFilter {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** worldId scopes every lookup and page to one logical world. */
  worldId?: string;

  /** inferenceEnabled makes lookups and rebuild pages ignore inferred rows. */
  inferenceEnabled?: boolean;

  /** maxLookupChunkSize caps host parameters per IN clause (default 100). */
  maxLookupChunkSize?: number;

  /** maxWriteBatchSize is both the atomic limit and the fallback batch size (default 750). */
  maxWriteBatchSize?: number;

  /** beforePage runs on each page of a rebuild before it is chunked and written. */
  beforePage?: (quads: rdfjs.Quad[]) => Promise<void>;
}

/** D1CommitDriver is the shared core's driver plus a count of the quads a rebuild read. */
export interface D1CommitDriver extends SqlCommitDriver<D1Statement> {
  /** processedQuadCount is how many stored quads `streamQuads` has read so far. */
  processedQuadCount: number;
}

/**
 * createD1CommitDriver adapts a D1 connection to the shared core's driver. D1's
 * atomic unit is one `batch()` call. Cloudflare documents no statement cap for
 * it, so the atomic limit is the chosen write batch size: a commit that fits
 * is atomic, a larger one takes the core's chunked fallback with cleanup.
 */
export function createD1CommitDriver(
  options: D1CommitDriverOptions,
): D1CommitDriver {
  const { connection, worldId } = options;
  const batchSize = options.maxWriteBatchSize ??
    DEFAULT_D1_MAX_WRITE_BATCH_SIZE;
  const lookupChunkSize = effectiveLookupChunkSize(
    options.maxLookupChunkSize,
    Boolean(worldId),
  );
  const matches = filterQuads(options);
  const driver: D1CommitDriver = {
    maxAtomicStatements: batchSize,
    writeBatchSize: batchSize,
    processedQuadCount: 0,
    executeBatch: (statements) => connection.batch(statements),
    async lookupExisting(keys) {
      const existing = new Set<string>();
      for (let index = 0; index < keys.length; index += lookupChunkSize) {
        const { rows } = await connection.execute(
          buildSelectExistingQuadIds(
            keys.slice(index, index + lookupChunkSize),
            worldId,
            { assertedOnly: options.inferenceEnabled === true },
          ),
        );
        for (const row of rows) if (row.id) existing.add(String(row.id));
      }
      return existing;
    },
    async streamQuads({ after, pageSize }) {
      const afterQuadId = after as string | undefined;
      const { rows } = await connection.execute(
        // Inferred rows are not indexed: they are rebuildable from asserted ones.
        options.inferenceEnabled
          ? buildSelectAssertedQuadsPage(
            { afterQuadId, limit: pageSize },
            worldId,
          )
          : buildMatchQuadsQuery(
            { subject: null, predicate: null, object: null, graph: null },
            { afterQuadId, limit: pageSize },
            worldId,
          ),
      );
      const quads: rdfjs.Quad[] = [];
      for (const row of rows) {
        try {
          const quad = quadFromD1Row(row);
          if (matches(quad)) quads.push(quad);
          driver.processedQuadCount++;
        } catch (error) {
          console.warn(`D1 rebuild: skipping corrupt row s="${row.s}"`, error);
        }
      }
      if (quads.length > 0) await options.beforePage?.(quads);
      const last = rows[rows.length - 1];
      return {
        quads,
        next: rows.length >= pageSize && last ? String(last.id) : undefined,
      };
    },
  };
  return driver;
}
