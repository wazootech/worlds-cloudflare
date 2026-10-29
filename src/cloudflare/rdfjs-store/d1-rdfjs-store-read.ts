import type * as rdfjs from "@rdfjs/types";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  buildCountQuadsQuery,
  buildMatchQuadsQuery,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { quadFromD1Row } from "@/cloudflare/d1/d1-quad-row.ts";

/** matchD1Pages keyset-pages the quads matching a pattern, one SQL round-trip per page. */
export async function* matchD1Pages(
  connection: D1ConnectionDriver,
  matchPageSize: number,
  worldId: string | undefined,
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): AsyncGenerator<rdfjs.Quad> {
  const pattern = {
    subject: subject ?? null,
    predicate: predicate ?? null,
    object: object ?? null,
    graph: graph ?? null,
  };

  let afterQuadId: string | undefined;
  for (;;) {
    const { sql, args } = buildMatchQuadsQuery(
      pattern,
      { afterQuadId, limit: matchPageSize },
      worldId,
    );
    const result = await connection.execute<Record<string, unknown>>({
      sql,
      args,
    });
    if (result.rows.length === 0) {
      return;
    }
    for (const row of result.rows) {
      afterQuadId = String(row.id);
      yield quadFromD1Row(row);
    }
    if (result.rows.length < matchPageSize) {
      return;
    }
  }
}

/** collectQuads drains a quad stream into an array. */
export async function collectQuads(
  stream: rdfjs.Stream<rdfjs.Quad>,
): Promise<rdfjs.Quad[]> {
  const quads: rdfjs.Quad[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (quad: rdfjs.Quad) => quads.push(quad));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return quads;
}

/** countD1Matches returns the number of quads matching the pattern. */
export async function countD1Matches(
  connection: D1ConnectionDriver,
  worldId: string | undefined,
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): Promise<number> {
  const { sql, args } = buildCountQuadsQuery({
    subject: subject ?? null,
    predicate: predicate ?? null,
    object: object ?? null,
    graph: graph ?? null,
  }, worldId);
  const result = await connection.execute<{ count: number }>({
    sql,
    args,
  });
  return Number(result.rows[0]?.count ?? 0);
}

/** PatchingQuadStore is the slice of the store removeMatchedQuads drives. */
export interface PatchingQuadStore {
  getQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<rdfjs.Quad[]>;
  applyPatch(
    patch: { insertions: rdfjs.Quad[]; deletions: rdfjs.Quad[] },
  ): Promise<void>;
}

/** removeMatchedQuads deletes every matching quad in one patch and yields the removed quads. */
export async function* removeMatchedQuads(
  store: PatchingQuadStore,
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): AsyncGenerator<rdfjs.Quad> {
  const matches = await store.getQuads(subject, predicate, object, graph);
  if (matches.length > 0) {
    await store.applyPatch({ insertions: [], deletions: matches });
    for (const quad of matches) {
      yield quad;
    }
  }
}
