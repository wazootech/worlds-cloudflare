import assert from "node:assert/strict";
import test from "node:test";
import { rejected } from "../../../test/thrown.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";

/**
 * What a D1 `batch()` call guarantees, checked against miniflare's D1. The
 * shared commit contract relies on it: the batch is the atomic unit, and the
 * 750 in `DEFAULT_D1_MAX_WRITE_BATCH_SIZE` is a chosen size, not a limit
 * D1 documents on statements per batch (Cloudflare's 100 limit is bound
 * parameters per statement, a separate cap).
 */
async function withTable(
  run: (t: Awaited<ReturnType<typeof createTestD1>>) => Promise<void>,
) {
  const substrate = await createTestD1();
  try {
    await substrate.connection.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)",
    );
    await run(substrate);
  } finally {
    await substrate.dispose();
  }
}

const insert = (id: number) => ({
  sql: "INSERT INTO t (id, label) VALUES (?, ?)",
  args: [id, `row ${id}`],
});

async function count(
  substrate: Awaited<ReturnType<typeof createTestD1>>,
): Promise<number> {
  const { rows } = await substrate.connection.execute({
    sql: "SELECT COUNT(*) AS n FROM t",
  });
  return Number(rows[0]!.n);
}

test("a batch rolls back every statement when one fails", () =>
  withTable(async (substrate) => {
    await substrate.connection.batch([insert(1), insert(2)]);
    await rejected(() =>
      substrate.connection.batch([insert(3), insert(4), insert(1)])
    );
    assert.deepStrictEqual(
      await count(substrate),
      2,
      "rows 3 and 4 must not persist",
    );
  }));

test("one batch() call accepts more statements than the 100 bound-parameter cap", () =>
  withTable(async (substrate) => {
    const statements = Array.from({ length: 250 }, (_, i) => insert(i + 1));
    await substrate.connection.batch(statements);
    assert.deepStrictEqual(await count(substrate), 250);
  }));

test("chunked batches are independent: a later failure keeps earlier batches", () =>
  withTable(async (substrate) => {
    await substrate.connection.batch([insert(1), insert(2)]);
    await rejected(() => substrate.connection.batch([insert(2)]));
    assert.ok(
      (await count(substrate)) === 2,
      "the earlier batch stays committed; only the failing batch rolls back",
    );
  }));
