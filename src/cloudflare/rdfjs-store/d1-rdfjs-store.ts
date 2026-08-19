import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import { hashQuads, isReplaceImportCommit } from "@worlds/sdk/quad-store";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import {
  buildBulkInsertQuads,
  buildCountQuadsQuery,
  buildDeleteQuadsByQuadIds,
  buildMatchQuadsQuery,
  buildSelectExistingQuadIds,
  buildWipeAllGraphDataStatements,
  DEFAULT_D1_MATCH_PAGE_SIZE,
  type InsertQuadRow,
} from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { D1BatchExecutor } from "@/cloudflare/d1/d1-batch-executor.ts";
import { DEFAULT_D1_MAX_LOOKUP_CHUNK_SIZE } from "@/cloudflare/d1/d1-batch-executor.ts";
import { DEFAULT_D1_MAX_WRITE_BATCH_SIZE } from "@/cloudflare/d1/d1-batch-executor.ts";
import { quadFromD1Row } from "@/cloudflare/d1/d1-quad-row.ts";
import { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import { D1QuadStream } from "./d1-quad-stream.ts";

/**
 * D1RdfjsStoreOptions configures D1RdfjsStore.
 */
export interface D1RdfjsStoreOptions {
  /** connection is the D1ConnectionDriver wrapping the D1 binding. */
  connection: D1ConnectionDriver;

  /** matchPageSize limits rows per match SQL round-trip (default 1000). */
  matchPageSize?: number;

  /** maxWriteBatchSize caps statements per D1 batch() call (default 500). */
  maxWriteBatchSize?: number;

  /** maxLookupChunkSize caps IN-clause / deletion chunk width (default 100). */
  maxLookupChunkSize?: number;

  /** schemaBuilder supplies the DDL the store applies in ensureSchema(). */
  schemaBuilder?: D1SchemaBuilder;
}

/**
 * D1Transaction is the atomic patch contract a SPARQL update uses to buffer
 * writes. D1 has no interactive transactions, so commit() persists the whole
 * patch in one `db.batch()` call.
 */
export interface D1Transaction {
  /** add buffers a single quad for insertion on the next commit. */
  add(quad: rdfjs.Quad): unknown;

  /** delete buffers a single quad for deletion on the next commit. */
  delete(quad: rdfjs.Quad): unknown;

  /** commit persists the buffered patch (one D1 batch). */
  commit(): Promise<void>;

  /** rollback discards any uncommitted insertions and deletions. */
  rollback(): void;
}

/** D1TransactionImpl buffers a SPARQL update patch for atomic commit. */
class D1TransactionImpl implements D1Transaction {
  private readonly inserted = new Map<string, rdfjs.Quad>();
  private readonly deleted = new Map<string, rdfjs.Quad>();

  public constructor(private readonly store: D1RdfjsStore) {}

  public add(quad: rdfjs.Quad): void {
    this.deleted.delete(quadKey(quad));
    this.inserted.set(quadKey(quad), quad);
  }

  public delete(quad: rdfjs.Quad): void {
    if (this.inserted.delete(quadKey(quad))) {
      return; // add + delete of the same quad nets to nothing
    }
    this.deleted.set(quadKey(quad), quad);
  }

  public commit(): Promise<void> {
    return this.store.applyPatch({
      insertions: [...this.inserted.values()],
      deletions: [...this.deleted.values()],
    });
  }

  public rollback(): void {
    this.inserted.clear();
    this.deleted.clear();
  }
}

/** quadKey builds a deduplication key for a quad (subject/predicate/object/graph values). */
function quadKey(quad: rdfjs.Quad): string {
  const objectIsLiteral = quad.object.termType === "Literal";
  const literal = objectIsLiteral ? quad.object as rdfjs.Literal : null;
  return [
    quad.subject.termType,
    quad.subject.value,
    quad.predicate.value,
    quad.object.termType,
    quad.object.value,
    literal?.datatype?.value ?? "",
    literal?.language ?? "",
    quad.graph.termType,
    quad.graph.value,
  ].join("\u0000");
}

/**
 * D1RdfjsStore is a durable RDF/JS Store over Cloudflare D1. It mirrors the
 * libsql reference shape (10-column `quads` table + 7 covering indexes) and
 * the libsql patch-commit flow, adapted to D1's constraints:
 *
 * - D1 has no interactive transactions; the atomic unit is one `db.batch()`
 *   call, which rolls back the whole sequence on any failure. commit() and
 *   applyPatch() persist each patch in one batch (chunked only when the
 *   staged statements exceed the write batch size),
 * - the 100-bound-params-per-statement cap is respected by inserting
 *   10 quads per statement (10 columns × 10 rows = 100 params),
 * - quad ids are content-addressed (`hashQuads`, RDFC-1.0 canonical ids)
 *   exactly like the libsql reference, so the same quad always maps to the
 *   same row and insertions are idempotent,
 * - `size` is a synchronous approximation refreshed after every write
 *   transaction, mirroring the postgres/sqlite stores.
 *
 * The engine remains store-agnostic and consumes this store through its
 * `createTransaction` hook:
 *
 *   const store = new D1RdfjsStore({ connection });
 *   const engine = new WazooSparqlEngine({
 *     store,
 *     createTransaction: () => store.createTransaction(),
 *   });
 */
export class D1RdfjsStore implements rdfjs.Store<rdfjs.Quad> {
  private readonly connection: D1ConnectionDriver;
  private readonly matchPageSize: number;
  private readonly writeBatchSize: number;
  private readonly lookupChunkSize: number;
  private readonly schemaBuilder: D1SchemaBuilder;
  /** serialized write queue: every mutation runs after the previous one. */
  private mutationQueue: Promise<void> = Promise.resolve();
  /** synchronous size approximation, refreshed after every write. */
  private liveCount = 0;

  public constructor(options: D1RdfjsStoreOptions) {
    this.connection = options.connection;
    this.matchPageSize = options.matchPageSize ?? DEFAULT_D1_MATCH_PAGE_SIZE;
    this.writeBatchSize = options.maxWriteBatchSize ??
      DEFAULT_D1_MAX_WRITE_BATCH_SIZE;
    this.lookupChunkSize = options.maxLookupChunkSize ??
      DEFAULT_D1_MAX_LOOKUP_CHUNK_SIZE;
    this.schemaBuilder = options.schemaBuilder ?? new D1SchemaBuilder(32);
  }

  /**
   * ensureSchema creates the quads/chunks tables, covering indexes, and the
   * FTS5 external-content table + triggers (idempotent) and seeds the live
   * count. Called by the SDK factory; safe to call again.
   */
  public async ensureSchema(): Promise<void> {
    for (const ddl of this.schemaBuilder.buildTables()) {
      await this.connection.exec(ddl);
    }
    for (const ddl of this.schemaBuilder.buildIndexes()) {
      await this.connection.exec(ddl);
    }
    await this.connection.exec(this.schemaBuilder.buildD1ChunksQuadIdIndex());
    await this.connection.exec(this.schemaBuilder.buildD1ChunksFtsTable());
    for (const ddl of this.schemaBuilder.buildD1ChunksTriggers()) {
      await this.connection.exec(ddl);
    }
    await this.refreshCount();
  }

  private async refreshCount(): Promise<void> {
    const result = await this.connection.execute<{ count: number }>(
      { sql: "SELECT COUNT(*) AS count FROM quads" },
    );
    this.liveCount = Number(result.rows[0]?.count ?? 0);
  }

  /** flush resolves once every queued write has committed. */
  public flush(): Promise<void> {
    return this.mutationQueue;
  }

  /**
   * enqueueWrite serializes a write batch behind all prior writes and
   * refreshes the live count on completion.
   */
  private enqueueWrite(work: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.then(async () => {
      await work();
      await this.refreshCount();
    });
    this.mutationQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * applyPatch persists a patch atomically in one D1 batch (chunked only when
   * staged statements exceed the write batch size). Quad ids are
   * content-addressed via hashQuads; only truly novel ids are inserted.
   * context.importMode === "replace" clears quads and chunks first (the SDK's
   * replace-import contract).
   */
  public applyPatch(
    patch: Patch,
    context?: TransactionContext,
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const executor = new D1BatchExecutor({
        connection: this.connection,
        writeBatchSize: this.writeBatchSize,
      });

      if (isReplaceImportCommit(context)) {
        await executor.stage(buildWipeAllGraphDataStatements());
      }

      const targetedDeletions = patch.deletions ?? [];
      const targetedInsertions = patch.insertions ?? [];

      if (targetedDeletions.length > 0) {
        const deletionIds = await hashQuads(targetedDeletions);
        await stageChunked(
          executor,
          deletionIds,
          this.lookupChunkSize,
          (chunk) => [buildDeleteQuadsByQuadIds(chunk)],
        );
      }

      if (targetedInsertions.length > 0) {
        const proposedIds = await hashQuads(targetedInsertions);
        const existingIds = await queryCachePresence(
          this.connection,
          proposedIds,
          this.lookupChunkSize,
        );

        const novelRows: InsertQuadRow[] = [];
        for (let index = 0; index < targetedInsertions.length; index++) {
          if (existingIds.has(proposedIds[index]!)) {
            continue;
          }
          novelRows.push(await quadToInsertRow(targetedInsertions[index]!));
        }

        if (novelRows.length > 0) {
          await executor.stage(buildBulkInsertQuads(novelRows));
        }
      }

      try {
        await executor.flush();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`failed to execute D1 batch: ${detail}`, { cause });
      }
    });
  }

  /** createTransaction returns a fresh transaction over this store. */
  public createTransaction(): D1Transaction {
    return new D1TransactionImpl(this);
  }

  public addQuad(quad: rdfjs.Quad): this;
  public addQuad(
    subject: rdfjs.Term,
    predicate: rdfjs.Term,
    object: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this;
  public addQuad(
    quadOrSubject: rdfjs.Quad | rdfjs.Term,
    predicate?: rdfjs.Term,
    object?: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this {
    const quad = predicate !== undefined && object !== undefined
      ? DataFactory.quad(
        quadOrSubject as rdfjs.Quad_Subject,
        predicate as rdfjs.Quad_Predicate,
        object as rdfjs.Quad_Object,
        graph as rdfjs.Quad_Graph,
      )
      : quadOrSubject as rdfjs.Quad;
    void this.enqueueWrite(async () => {
      await this.connection.batch(
        buildBulkInsertQuads([await quadToInsertRow(quad)]),
      );
    });
    return this;
  }

  public removeQuad(quad: rdfjs.Quad): this {
    void this.enqueueWrite(async () => {
      const [id] = await hashQuads([quad]);
      await this.connection.batch([buildDeleteQuadsByQuadIds([id])]);
    });
    return this;
  }

  public remove(stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    stream.on("data", (quad: rdfjs.Quad) => this.removeQuad(quad));
    return stream;
  }

  public import(stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    stream.on("data", (quad: rdfjs.Quad) => this.addQuad(quad));
    return stream;
  }

  /**
   * match returns a stream of quads matching the given quad pattern.
   * Queries resolve via a single hexastore index seek with no in-memory
   * hydration; reads are keyset-paged by content-addressed quad id.
   */
  public match(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): D1QuadStream {
    return new D1QuadStream(() =>
      this.matchPages(subject, predicate, object, graph)
    );
  }

  private async *matchPages(
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
        { afterQuadId, limit: this.matchPageSize },
      );
      const result = await this.connection.execute<Record<string, unknown>>({
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
      if (result.rows.length < this.matchPageSize) {
        return;
      }
    }
  }

  /** getQuads collects the matching quads into an array. */
  public async getQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<rdfjs.Quad[]> {
    const stream = this.match(subject, predicate, object, graph);
    const quads: rdfjs.Quad[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (quad: rdfjs.Quad) => quads.push(quad));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    return quads;
  }

  /** countQuads returns the number of quads matching the pattern. */
  public async countQuads(
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
    });
    const result = await this.connection.execute<{ count: number }>({
      sql,
      args,
    });
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * removeMatches deletes every matching quad in one D1 batch and streams the
   * removed quads.
   */
  public removeMatches(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): D1QuadStream {
    return new D1QuadStream(() =>
      this.removeMatchesGenerator(subject, predicate, object, graph)
    );
  }

  private async *removeMatchesGenerator(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): AsyncGenerator<rdfjs.Quad> {
    const matches = await this.getQuads(subject, predicate, object, graph);
    if (matches.length > 0) {
      await this.applyPatch({ insertions: [], deletions: matches });
      for (const quad of matches) {
        yield quad;
      }
    }
  }

  /** deleteGraph removes every quad in the named graph. */
  public deleteGraph(
    graph: rdfjs.Quad_Graph | string,
  ): D1QuadStream {
    const graphTerm = typeof graph === "string"
      ? DataFactory.namedNode(graph)
      : graph;
    return this.removeMatches(null, null, null, graphTerm);
  }

  /**
   * size is the synchronous count approximation — refreshed after every
   * write transaction and on ensureSchema. D1 has no synchronous count;
   * consumers needing the exact count await countQuads() instead.
   */
  public get size(): number {
    return this.liveCount;
  }
}

/** quadToInsertRow flattens a quad into a D1 insert row with a content-addressed id. */
async function quadToInsertRow(quad: rdfjs.Quad): Promise<InsertQuadRow> {
  const [id] = await hashQuads([quad]);
  const subject = quad.subject;
  const object = quad.object;
  const graph = quad.graph;
  return {
    quad_id: id,
    s: subject.value,
    s_type: subject.termType,
    p: quad.predicate.value,
    o: object.value,
    o_type: object.termType,
    o_datatype: object.termType === "Literal"
      ? (object as rdfjs.Literal).datatype?.value ?? null
      : null,
    o_lang: object.termType === "Literal"
      ? (object as rdfjs.Literal).language || null
      : null,
    g: graph.value,
    g_type: graph.termType,
  };
}

/** stageChunked slices ids into chunks and stages the generated statements per chunk. */
async function stageChunked(
  executor: D1BatchExecutor,
  ids: string[],
  chunkSize: number,
  build: (chunk: string[]) => Array<{ sql: string; args: unknown[] }>,
): Promise<void> {
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    await executor.stage(build(chunk));
  }
}

/** queryCachePresence polls D1 for which quad ids are already persisted. */
async function queryCachePresence(
  connection: D1ConnectionDriver,
  quadIds: string[],
  lookupChunkSize: number,
): Promise<Set<string>> {
  const cachedIds = new Set<string>();
  for (let index = 0; index < quadIds.length; index += lookupChunkSize) {
    const chunk = quadIds.slice(index, index + lookupChunkSize);
    const result = await connection.execute(buildSelectExistingQuadIds(chunk));
    for (const row of result.rows) {
      if (row.id) {
        cachedIds.add(String(row.id));
      }
    }
  }
  return cachedIds;
}
