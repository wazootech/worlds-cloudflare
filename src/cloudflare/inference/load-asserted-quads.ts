import type * as rdfjs from "@rdfjs/types";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import { quadFromD1Row } from "@/cloudflare/d1/d1-quad-row.ts";
import {
  buildCountAssertedQuads,
  buildSelectAssertedQuadsPage,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";

/** DEFAULT_MAX_ASSERTED_QUADS is the default inference size guard. */
export const DEFAULT_MAX_ASSERTED_QUADS = 100_000;

const PAGE_SIZE = 1000;

/** InferenceSizeGuardError is thrown, before any write, when a world is too big to reason over. */
export class InferenceSizeGuardError extends Error {
  public constructor(
    public readonly assertedQuads: number,
    public readonly maxAssertedQuads: number,
  ) {
    super(
      `inference size guard: ${assertedQuads} asserted quads exceed maxAssertedQuads (${maxAssertedQuads}); ` +
        `each commit rebuilds the reasoner from all asserted quads. Disable inference for this world or raise the limit.`,
    );
    this.name = "InferenceSizeGuardError";
  }
}

/**
 * loadAssertedQuads reads every asserted (derived = 0) quad of the world,
 * failing with InferenceSizeGuardError when `pendingInsertions` more would
 * exceed `maxAssertedQuads`.
 */
export async function loadAssertedQuads(
  connection: D1ConnectionDriver,
  options: {
    worldId?: string;
    maxAssertedQuads: number;
    pendingInsertions: number;
  },
): Promise<rdfjs.Quad[]> {
  const count = await connection.execute<{ count: number }>(
    buildCountAssertedQuads(options.worldId),
  );
  const total = Number(count.rows[0]?.count ?? 0);
  if (total + options.pendingInsertions > options.maxAssertedQuads) {
    throw new InferenceSizeGuardError(
      total + options.pendingInsertions,
      options.maxAssertedQuads,
    );
  }

  const quads: rdfjs.Quad[] = [];
  let afterQuadId: string | undefined;
  for (;;) {
    const page = await connection.execute<Record<string, unknown>>(
      buildSelectAssertedQuadsPage(
        { afterQuadId, limit: PAGE_SIZE },
        options.worldId,
      ),
    );
    for (const row of page.rows) quads.push(quadFromD1Row(row));
    if (page.rows.length < PAGE_SIZE) return quads;
    afterQuadId = String(page.rows[page.rows.length - 1]!.id);
  }
}
