import assert from "node:assert/strict";
import test from "node:test";
import { rejected } from "../../../test/thrown.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { literal, namedNode } from "./d1-rdfjs-store-test-helpers.ts";
import { D1RdfjsStore } from "./mod.ts";

/**
 * Fire-and-forget writes (addQuad/removeQuad return synchronously) must not
 * vanish: the failure is logged, flush() rejects with an AggregateError of
 * every failure since the previous flush, and the queue keeps draining later
 * writes (#71 item 5).
 */
test("a failed fire-and-forget write is logged and rejects flush()", async () => {
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
    await rejected(() => store.flush());
    assert.ok(
      errors.length === 1,
      `expected one logged failure, got ${errors.length}`,
    );
    const [message, error] = errors[0]!;
    assert.ok(
      String(message).includes('addQuad write failed for world "<unscoped>"'),
      `unexpected log message: ${message}`,
    );
    assert.ok(error instanceof Error);
  } finally {
    console.error = original;
    await substrate.dispose();
  }
});

test("the write queue keeps draining after a failed write", async () => {
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

    // The queued write after the failure still ran, but flush() reports the
    // earlier failure as an AggregateError; a following flush() resolves.
    const error = await store.flush().then(
      () => {
        throw new Error("expected flush() to reject");
      },
      (e: unknown) => e,
    );
    assert.ok(error instanceof AggregateError, `not AggregateError: ${error}`);
    assert.deepStrictEqual(error.errors.length, 1);
    await store.flush();

    const rows = await substrate.connection.execute<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM quads",
    });
    assert.deepStrictEqual(Number(rows.rows[0]!.n), 1);
    assert.deepStrictEqual(errors.length, 1);
  } finally {
    console.error = original;
    await substrate.dispose();
  }
});

test("flush() aggregates an earlier failure with a later success", async () => {
  const substrate = await createTestD1();
  const original = console.error;
  console.error = () => {};
  try {
    const store = new D1RdfjsStore({ connection: substrate.connection });
    await store.ensureSchema();
    await substrate.connection.execute({ sql: "DROP TABLE quads" });
    store.addQuad(namedNode("urn:alice"), namedNode("urn:name"), literal("A"));

    // Repair the store, then let a later write succeed.
    for (const table of ["chunks", "chunks_fts", "worlds_data_plane_schema"]) {
      await substrate.connection.execute({ sql: `DROP TABLE ${table}` });
    }
    await store.ensureSchema();
    store.addQuad(namedNode("urn:bob"), namedNode("urn:name"), literal("B"));

    // The first failure still surfaces even though the last write succeeded.
    const error = await store.flush().then(
      () => {
        throw new Error("expected flush() to reject");
      },
      (e: unknown) => e,
    );
    assert.ok(error instanceof AggregateError, `not AggregateError: ${error}`);
    assert.deepStrictEqual(error.errors.length, 1);
    assert.deepStrictEqual(
      Number(
        (
          await substrate.connection.execute<{ n: number }>({
            sql: "SELECT COUNT(*) AS n FROM quads",
          })
        ).rows[0]!.n,
      ),
      1,
    );

    // Reporting clears the failure list: the next flush() resolves.
    await store.flush();
  } finally {
    console.error = original;
    await substrate.dispose();
  }
});

test("flush() caps the AggregateError at 10 errors plus a count", async () => {
  const substrate = await createTestD1();
  const original = console.error;
  console.error = () => {};
  try {
    const store = new D1RdfjsStore({ connection: substrate.connection });
    await store.ensureSchema();
    await substrate.connection.execute({ sql: "DROP TABLE quads" });
    for (let i = 0; i < 12; i++) {
      store.addQuad(
        namedNode(`urn:q${i}`),
        namedNode("urn:name"),
        literal(String(i)),
      );
    }
    const error = await store.flush().then(
      () => {
        throw new Error("expected flush() to reject");
      },
      (e: unknown) => e,
    );
    assert.ok(error instanceof AggregateError, `not AggregateError: ${error}`);
    assert.deepStrictEqual(error.errors.length, 11); // first 10 + one suppression marker
    const marker = error.errors[10]! as Error;
    assert.ok(
      marker.message.includes("2 more write failure(s) suppressed"),
      `unexpected marker: ${marker.message}`,
    );
  } finally {
    console.error = original;
    await substrate.dispose();
  }
});
