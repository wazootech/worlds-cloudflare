import { assert, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine/data-model";
import { hashQuad } from "@worlds/sdk/quad-store";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { runCommitConformanceSuite } from "@worlds/sdk/testing";
import type {
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
  return {
    failWriteAfter: (count) => {
      skip = count;
    },
    database: {
      prepare: (sql) => tag(database.prepare(sql), sql),
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

/** CountingProjector counts full search-index rebuilds. */
class CountingProjector extends D1SearchIndexProjector {
  public rebuilds = 0;

  public override async reindexAll(): Promise<void> {
    this.rebuilds++;
    await super.reindexAll();
  }
}

/** D1TestSubject is the conformance subject plus its teardown and failure hook. */
export interface D1TestSubject extends CommitConformanceSubject {
  failWriteAfter(skip: number): void;
  dispose(): Promise<void>;
}

/** createD1Subject wires a miniflare D1 world with chunk and vector projection. */
export async function createD1Subject(
  options: CommitConformanceCreateOptions,
): Promise<D1TestSubject> {
  const substrate = await createTestD1();
  const failing = failingD1(substrate.database);
  const connection = new D1ConnectionDriver(failing.database);
  const store = new D1RdfjsStore({ connection });
  await store.ensureSchema();
  const searchQueryBuilder = new D1SearchQueryBuilder(32);
  const projector = new CountingProjector({
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
  });
  return {
    commit: async (patch: Patch, context?: TransactionContext) => {
      await quadStore.createTransaction()
        .addQuads(patch.insertions ?? [])
        .removeQuads(patch.deletions ?? [])
        .commit(context);
    },
    storedQuads: () => store.getQuads(),
    chunkedQuadIds: async () => {
      const { rows } = await connection.execute({
        sql: "SELECT quad_id FROM chunks",
      });
      return rows.map((row) => String(row.quad_id));
    },
    failNextWrite: () => failing.failWriteAfter(0),
    failWriteAfter: (skip) => failing.failWriteAfter(skip),
    fullRebuildCount: () => projector.rebuilds,
    dispose: substrate.dispose,
  };
}

const disposers: Array<() => Promise<void>> = [];

async function create(options: CommitConformanceCreateOptions) {
  const subject = await createD1Subject(options);
  disposers.push(subject.dispose);
  return subject;
}

async function disposeAll() {
  for (const dispose of disposers.splice(0)) await dispose();
}

/**
 * D1's real contract. A commit is a sequence of D1 `batch()` calls, one per
 * `writeBatchSize` statements, so it is not atomic; a replace import wipes in
 * its own batch first, so a later failure leaves an empty graph; embedding
 * failures degrade to keyword-only chunks; and imports default to "deferred".
 */
Deno.test("D1 satisfies the shared commit conformance suite", async () => {
  try {
    const report = await runCommitConformanceSuite({
      create,
      contract: {
        atomic: false,
        embeddingFailure: "degrades",
        replaceImportFailure: "empties-graph",
        defaultSearchIndexOnImport: "deferred",
      },
    });
    const failed = report.results.filter((r) => !r.ok);
    assert(report.ok, `conformance failures: ${JSON.stringify(failed)}`);
  } finally {
    await disposeAll();
  }
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

Deno.test("a failed chunk write keeps the committed quads and removes their chunk rows", async () => {
  const subject = await createD1Subject({
    searchIndexOnImport: "incremental",
    embeddingService: new FakeEmbeddingService(),
  });
  try {
    // Write 1 (the quads) succeeds; write 2 (the chunk rows) fails.
    subject.failWriteAfter(1);
    await assertRejects(
      () => subject.commit({ insertions: [one, two], deletions: [] }),
      Error,
      "search chunk sync batch",
    );
    const stored = (await subject.storedQuads()).map(hashQuad).sort();
    assertEquals(stored, [hashQuad(one), hashQuad(two)].sort());
    assertEquals(await subject.chunkedQuadIds(), []);
  } finally {
    await subject.dispose();
  }
});
