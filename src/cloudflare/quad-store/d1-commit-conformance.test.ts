import { assert, assertEquals, assertRejects } from "@std/assert";
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

/** FailingD1 is a D1 binding whose write batches can be made to fail once. */
export interface FailingD1 {
  database: D1DatabaseLike;

  /** fullRebuilds counts the full search-index rebuilds that started: a first page read of every stored quad. */
  fullRebuilds(): number;

  /** failWriteAfter makes the write batch after `skip` more write batches fail once. A replace wipe never counts. */
  failWriteAfter(skip: number): void;
}

/**
 * failingD1 wraps a D1 binding. Reads (`prepare().all()`) always work; a
 * `batch()` call is a write. The armed failure skips replace-import wipe
 * batches so the failure lands on the write after the wipe, which is where a
 * replace import can be left half-done.
 */
export function failingD1(database: D1DatabaseLike): FailingD1 {
  let skip: number | undefined;
  let rebuilds = 0;
  return {
    fullRebuilds: () => rebuilds,
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
        return database.batch(tagged.map((s) => s.inner));
      },
    },
  };
}

/** D1TestSubject is the conformance subject plus its teardown and failure hook. */
export interface D1TestSubject extends CommitConformanceSubject {
  failWriteAfter(skip: number): void;
  dispose(): Promise<void>;
}

/** createD1Subject wires a miniflare D1 world with chunk and vector projection. */
export async function createD1Subject(
  options: CommitConformanceCreateOptions & { maxWriteBatchSize?: number },
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
    fullRebuildCount: () => failing.fullRebuilds() - readerPages,
    dispose: substrate.dispose,
  };
}

const disposers: Array<() => Promise<void>> = [];

/** createWith returns a subject factory whose commits batch at most `maxWriteBatchSize` statements. */
function createWith(maxWriteBatchSize?: number) {
  return async (options: CommitConformanceCreateOptions) => {
    const subject = await createD1Subject({ ...options, maxWriteBatchSize });
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
) {
  try {
    const report = await runCommitConformanceSuite({
      create: createWith(maxWriteBatchSize),
      contract,
    });
    const failed = report.results.filter((r) => !r.ok);
    assert(report.ok, `conformance failures: ${JSON.stringify(failed)}`);
  } finally {
    await disposeAll();
  }
}

/**
 * D1's contract. A commit that fits in one `batch()` call (the write batch
 * size, 100 statements by default) is atomic, and a failed replace import
 * keeps the old graph. A larger commit takes the shared core's chunked
 * fallback, which is not atomic and leaves an empty graph if a replace import
 * fails after its wipe. Embedding failures throw; imports default to "incremental".
 */
Deno.test("D1 satisfies the shared commit conformance suite on the atomic path", async () => {
  await runSuite(undefined, {
    atomic: true,
    embeddingFailure: "throws",
    replaceImportFailure: "keeps-old-graph",
    defaultSearchIndexOnImport: "incremental",
  });
});

Deno.test("D1 satisfies the shared commit conformance suite on the chunked fallback path", async () => {
  // One statement per batch sends every commit down the fallback.
  await runSuite(1, {
    atomic: false,
    embeddingFailure: "throws",
    replaceImportFailure: "empties-graph",
    defaultSearchIndexOnImport: "incremental",
  });
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

Deno.test("a failed write after the first batch removes the novel quads and their chunk rows", async () => {
  const subject = await createD1Subject({
    searchIndexOnImport: "incremental",
    embeddingService: new FakeEmbeddingService(),
    maxWriteBatchSize: 2,
  });
  try {
    // Batch 1 (the first quads) succeeds; batch 2 fails; the cleanup removes batch 1.
    subject.failWriteAfter(1);
    await assertRejects(
      () => subject.commit({ insertions: [one, two], deletions: [] }),
      Error,
      "injected D1 write failure",
    );
    assertEquals(await subject.storedQuads(), []);
    assertEquals(await subject.chunkedQuadIds(), []);
  } finally {
    await subject.dispose();
  }
});
