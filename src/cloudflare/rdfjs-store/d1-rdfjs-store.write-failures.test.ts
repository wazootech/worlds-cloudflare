import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { literal, namedNode } from "./d1-rdfjs-store-test-helpers.ts";
import { D1RdfjsStore } from "./mod.ts";

/**
 * Fire-and-forget writes (addQuad/removeQuad return synchronously) must not
 * vanish: the failure is logged, flush() rejects with it, and the queue keeps
 * draining later writes (#71 item 5).
 */
Deno.test("a failed fire-and-forget write is logged and rejects flush()", async () => {
  const substrate = await createTestD1();
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => errors.push(parts);
  try {
    const store = new D1RdfjsStore({ connection: substrate.connection });
    await store.ensureSchema();
    // Break the write path: the quads table (and its insert) no longer exists.
    await substrate.connection.execute({ sql: "DROP TABLE quads" });

    store.addQuad(namedNode("urn:alice"), namedNode("urn:name"), literal("A"));
    await assertRejects(() => store.flush());
    assert(
      errors.length === 1,
      `expected one logged failure, got ${errors.length}`,
    );
    const [message, error] = errors[0]!;
    assert(
      String(message).includes('addQuad write failed for world "<unscoped>"'),
      `unexpected log message: ${message}`,
    );
    assert(error instanceof Error);
  } finally {
    console.error = original;
    await substrate.dispose();
  }
});

Deno.test("the write queue keeps draining after a failed write", async () => {
  const substrate = await createTestD1();
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => errors.push(parts);
  try {
    const store = new D1RdfjsStore({ connection: substrate.connection });
    await store.ensureSchema();
    await substrate.connection.execute({ sql: "DROP TABLE quads" });
    store.addQuad(namedNode("urn:alice"), namedNode("urn:name"), literal("A"));

    // Repair the store: drop the remaining tables so ensureSchema rebuilds
    // everything from scratch (the compatibility check only runs when some
    // table still exists).
    for (const table of ["chunks", "chunks_fts", "worlds_data_plane_schema"]) {
      await substrate.connection.execute({ sql: `DROP TABLE ${table}` });
    }
    await store.ensureSchema();
    store.addQuad(namedNode("urn:bob"), namedNode("urn:name"), literal("B"));
    await store.flush();

    const rows = await substrate.connection.execute<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM quads",
    });
    assertEquals(Number(rows.rows[0]!.n), 1);
    assertEquals(errors.length, 1);
  } finally {
    console.error = original;
    await substrate.dispose();
  }
});
