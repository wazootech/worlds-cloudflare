import assert from "node:assert/strict";
import test from "node:test";
import { rejected } from "../../../test/thrown.ts";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { runCommitConformanceSuite } from "@worlds/sdk/testing";
import type {
  CommitConformanceContract,
  CommitConformanceCreateOptions,
  CommitConformanceSubject,
} from "@worlds/sdk/testing";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { D1QuadStore } from "./mod.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "@/cloudflare/d1/d1-connection-driver.ts";
import { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import { D1RdfjsStore } from "@/cloudflare/rdfjs-store/mod.ts";
import { D1SearchQueryBuilder } from "@/cloudflare/search-index/d1-search-query-builder.ts";
import { D1SearchIndexProjector } from "@/cloudflare/search-index/d1-search-index-projector.ts";
import { FakeVectorSearchIndex } from "@/cloudflare/search-index/vector-search/fake-vector-search-index.ts";

/** WipeSql is the statement text of a replace-import wipe (an unscoped world). */
const WIPE_SQL = new Set(["DELETE FROM chunks", "DELETE FROM quads"]);

interface TaggedStatement extends D1PreparedStatementLike {
  sql: string;
  inner: D1PreparedStatementLike;
}

function tag(inner: D1PreparedStatementLike, sql: string): TaggedStatement {
  return {
    sql,
    inner,
    bind: (...values) => tag(inner.bind(...values), sql),
    all: () => inner.all(),
    first: () => inner.first(),
    run: () => inner.run(),
  };
}

/** CHUNK_INSERT starts the statement that writes a search chunk row. */
const CHUNK_INSERT = "INSERT INTO chunks";

/** FailingD1 is a D1 binding whose write batches can be made to fail once. */
export interface FailingD1 {
  database: D1DatabaseLike;

  /** fullRebuilds counts the full search-index rebuilds that started: a first page read of every stored quad. */
  fullRebuilds(): number;

  /** failWriteAfter makes the write batch after `skip` more write batches fail once. A replace wipe never counts. */
  failWriteAfter(skip: number): void;

  /**
   * failLaterWrite arms one failure on the first chunk-row insert that a write
   * batch carries. Quad inserts that come earlier (in the same batch, or in an
   * earlier batch) still run first; see `laterFailure`.
   */
  failLaterWrite(): void;

  /** laterFailure is where the armed later-write failure landed, once it has fired. */
  laterFailure(): LaterFailure | undefined;
}

/**
 * LaterFailure records the statements written since `failLaterWrite` was armed,
 * in order, and the index of the poisoned chunk-row insert among them.
 */
export interface LaterFailure {
  statements: string[];
  failedAt: number;
}

/** POISON is a chunk-row insert that D1 rejects (an unknown column) when it executes. */
const POISON = "INSERT INTO chunks (no_such_column) VALUES (1)";

/**
 * failingD1 wraps a D1 binding. Reads (`prepare().all()`) always work; a
 * `batch()` call is a write. The armed failure skips replace-import wipe
 * batches so the failure lands on the write after the wipe, which is where a
 * replace import can be left half-done.
 */
export function failingD1(database: D1DatabaseLike): FailingD1 {
  let skip: number | undefined;
  let rebuilds = 0;
  let armedLater = false;
  let written: string[] = [];
  let later: LaterFailure | undefined;
  return {
    fullRebuilds: () => rebuilds,
    failLaterWrite: () => {
      armedLater = true;
      written = [];
      later = undefined;
    },
    laterFailure: () => later,
    failWriteAfter: (count) => {
      skip = count;
    },
    database: {
      prepare: (sql) => {
        if (
          sql.includes("ORDER BY quad_id ASC") && !sql.includes("quad_id >")
        ) {
          rebuilds++;
        }
        return tag(database.prepare(sql), sql);
      },
      exec: (sql) => database.exec(sql),
      batch: (statements) => {
        const tagged = statements as TaggedStatement[];
        const isWipe = tagged.every((s) => WIPE_SQL.has(s.sql));
        if (!isWipe && skip !== undefined) {
          if (skip === 0) {
            skip = undefined;
            return Promise.reject(new Error("injected D1 write failure"));
          }
          skip--;
        }
        if (armedLater) {
          const at = tagged.findIndex((s) => s.sql.startsWith(CHUNK_INSERT));
          if (at < 0) written.push(...tagged.map((s) => s.sql));
          else {
            // Run the real batch with the chunk-row insert swapped for one
            // that fails when it executes, so every statement before it has
            // already run when D1 rejects the batch.
            armedLater = false;
            later = {
              statements: [...written, ...tagged.map((s) => s.sql)],
              failedAt: written.length + at,
            };
            return database.batch(
              tagged.map((s, i) =>
                i === at ? database.prepare(POISON) : s.inner
              ),
            );
          }
        }
        return database.batch(tagged.map((s) => s.inner));
      },
    },
  };
}

/** D1TestSubject is the conformance subject plus its teardown and failure hook. */
export interface D1TestSubject extends CommitConformanceSubject {
  failWriteAfter(skip: number): void;
  failLaterWrite(): void;
  laterFailure(): LaterFailure | undefined;
  dispose(): Promise<void>;
}

/** createD1Subject wires a miniflare D1 world with chunk and vector projection. */
export async function createD1Subject(
  options: CommitConformanceCreateOptions & {
    maxWriteBatchSize?: number;
    maxBatchWeight?: number;
  },
): Promise<D1TestSubject> {
  const substrate = await createTestD1();
  const failing = failingD1(substrate.database);
  let readerPages = 0;
  const connection = new D1ConnectionDriver(failing.database);
  const store = new D1RdfjsStore({ connection });
  await store.ensureSchema();
  const searchQueryBuilder = new D1SearchQueryBuilder(32);
  const projector = new D1SearchIndexProjector({
    connection,
    searchQueryBuilder,
    textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
    embeddingService: options.embeddingService,
    vectorSearch: new FakeVectorSearchIndex(),
    vectorDimensions: 32,
  });
  const quadStore = new D1QuadStore({
    connection,
    store,
    searchQueryBuilder,
    searchIndexProjector: projector,
    searchIndexOnImport: options.searchIndexOnImport,
    maxWriteBatchSize: options.maxWriteBatchSize,
    maxBatchWeight: options.maxBatchWeight,
  });
  return {
    commit: async (patch: Patch, context?: TransactionContext) => {
      await quadStore.createTransaction()
        .addQuads(patch.insertions ?? [])
        .removeQuads(patch.deletions ?? [])
        .commit(context);
    },
    storedQuads: async () => {
      // The store's own paged read looks like a rebuild's first page; don't count it.
      const before = failing.fullRebuilds();
      const quads = await store.getQuads();
      readerPages += failing.fullRebuilds() - before;
      return quads;
    },
    chunkedQuadIds: async () => {
      const { rows } = await connection.execute({
        sql: "SELECT quad_id FROM chunks",
      });
      return rows.map((row) => String(row.quad_id));
    },
    failNextWrite: () => failing.failWriteAfter(0),
    failWriteAfter: (skip) => failing.failWriteAfter(skip),
    failLaterWrite: () => failing.failLaterWrite(),
    laterFailure: () => failing.laterFailure(),
    fullRebuildCount: () => failing.fullRebuilds() - readerPages,
    dispose: substrate.dispose,
  };
}

const disposers: Array<() => Promise<void>> = [];

/** createWith returns a subject factory whose commits batch within `maxWriteBatchSize` statements and `maxBatchWeight` estimated bytes. */
function createWith(maxWriteBatchSize?: number, maxBatchWeight?: number) {
  return async (options: CommitConformanceCreateOptions) => {
    const subject = await createD1Subject({
      ...options,
      maxWriteBatchSize,
      maxBatchWeight,
    });
    disposers.push(subject.dispose);
    return subject;
  };
}

async function disposeAll() {
  for (const dispose of disposers.splice(0)) await dispose();
}

async function runSuite(
  maxWriteBatchSize: number | undefined,
  contract: CommitConformanceContract,
  maxBatchWeight?: number,
) {
  try {
    const report = await runCommitConformanceSuite({
      create: createWith(maxWriteBatchSize, maxBatchWeight),
      contract,
    });
    const failed = report.results.filter((r) => !r.ok);
    assert.ok(report.ok, `conformance failures: ${JSON.stringify(failed)}`);
    // A skipped case is not a pass: the later-write case must actually run.
    assert.deepStrictEqual(
      (report.notes ?? []).filter((note) => note.includes("later-write")),
      [],
    );
    assert.ok(
      report.results.some((r) =>
        r.name === "later-write failure follows the contract" && r.ok
      ),
      "the later-write case must run and pass",
    );
  } finally {
    await disposeAll();
  }
}

/**
 * D1's contract. A commit that fits in one `batch()` call (the write batch
 * size and byte budget, 2,000 statements and 16 MiB by default) is atomic, and a failed replace import
 * keeps the old graph. A larger commit takes the shared core's chunked
 * fallback, which is not atomic and leaves an empty graph if a replace import
 * fails after its wipe. Embedding failures throw; imports default to "incremental".
 *
 * This suite runs on miniflare's D1. Real D1 was probed once (2026-11-22, a
 * throwaway database, see README): a 2,000-statement `batch()` whose last
 * statement violated a primary key left zero rows, so the atomic claim holds
 * there too. The `failLaterWrite` case exercises it here: the failing statement is a chunk-row
 * insert that comes after the quad inserts in the same batch.
 */
test("D1 satisfies the shared commit conformance suite on the atomic path", async () => {
  await runSuite(undefined, {
    atomic: true,
    embeddingFailure: "throws",
    replaceImportFailure: "keeps-old-graph",
    defaultSearchIndexOnImport: "incremental",
    laterWriteFailure: "restores-prior-state",
  });
});

test("D1 satisfies the shared commit conformance suite on the chunked fallback path", async () => {
  // One statement per batch sends every commit down the fallback.
  await runSuite(1, {
    atomic: false,
    embeddingFailure: "throws",
    replaceImportFailure: "empties-graph",
    defaultSearchIndexOnImport: "incremental",
    // The compensating cleanup removes the quads that earlier batches wrote.
    laterWriteFailure: "restores-prior-state",
  });
});

test("D1 satisfies the shared commit conformance suite on the byte-budget chunked path", async () => {
  // A 1-byte budget puts every statement alone in its own batch.
  await runSuite(undefined, {
    atomic: false,
    embeddingFailure: "throws",
    replaceImportFailure: "empties-graph",
    defaultSearchIndexOnImport: "incremental",
    laterWriteFailure: "restores-prior-state",
  }, 1);
});

const { namedNode, literal, quad } = DataFactory;
const one = quad(
  namedNode("urn:d1:one"),
  namedNode("urn:d1:p"),
  literal("one"),
);
const two = quad(
  namedNode("urn:d1:two"),
  namedNode("urn:d1:p"),
  literal("two"),
);

test("a failed write after the first batch removes the novel quads and their chunk rows", async () => {
  const subject = await createD1Subject({
    searchIndexOnImport: "incremental",
    embeddingService: new FakeEmbeddingService(),
    maxWriteBatchSize: 2,
  });
  try {
    // Batch 1 (the first quads) succeeds; batch 2 fails; the cleanup removes batch 1.
    subject.failWriteAfter(1);
    await rejected(
      () => subject.commit({ insertions: [one, two], deletions: [] }),
      Error,
      "injected D1 write failure",
    );
    assert.deepStrictEqual(await subject.storedQuads(), []);
    assert.deepStrictEqual(await subject.chunkedQuadIds(), []);
  } finally {
    await subject.dispose();
  }
});

for (
  const [name, size, weight] of [
    ["atomic batch", undefined, undefined],
    ["chunked batches", 1, undefined],
    ["byte-budget batches", undefined, 1],
  ] as const
) {
  test(`the later-write failure follows the quad writes (${name})`, async () => {
    const subject = await createD1Subject({
      searchIndexOnImport: "incremental",
      embeddingService: new FakeEmbeddingService(),
      maxWriteBatchSize: size,
      maxBatchWeight: weight,
    });
    try {
      subject.failLaterWrite();
      await rejected(() =>
        subject.commit({ insertions: [one, two], deletions: [] })
      );
      const failure = subject.laterFailure();
      assert.ok(failure, "the armed failure must fire");
      const quadWrites = failure.statements.map((sql, index) => ({
        sql,
        index,
      }))
        .filter(({ sql }) => sql.includes(" INTO quads "));
      assert.ok(quadWrites.length > 0, "the commit must write quads");
      assert.ok(
        quadWrites.every(({ index }) => index < failure.failedAt),
        `every quad insert must precede the failing write: ${
          JSON.stringify(failure)
        }`,
      );
      assert.deepStrictEqual(await subject.storedQuads(), []);
      assert.deepStrictEqual(await subject.chunkedQuadIds(), []);
    } finally {
      await subject.dispose();
    }
  });
}
