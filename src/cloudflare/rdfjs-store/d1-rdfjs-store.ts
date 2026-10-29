import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine";
import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import { DEFAULT_D1_MATCH_PAGE_SIZE } from "@/cloudflare/quad-store/d1-quad-query-builder.ts";
import { DEFAULT_D1_MAX_LOOKUP_CHUNK_SIZE } from "@/cloudflare/d1/d1-batch-executor.ts";
import { DEFAULT_D1_MAX_WRITE_BATCH_SIZE } from "@/cloudflare/d1/d1-batch-executor.ts";
import { D1SchemaBuilder } from "@/cloudflare/schema/d1-schema-builder.ts";
import { D1QuadStream } from "./d1-quad-stream.ts";
import { D1TransactionImpl } from "./d1-rdfjs-transaction.ts";
import type { D1Transaction } from "./d1-rdfjs-transaction.ts";
import {
  applyD1Patch,
  deleteD1Quad,
  insertD1Quad,
} from "./d1-rdfjs-store-patch.ts";
import { D1WriteQueue } from "./d1-write-queue.ts";
import { applyD1Schema } from "./d1-rdfjs-store-lifecycle.ts";
import {
  collectQuads,
  countD1Matches,
  matchD1Pages,
  removeMatchedQuads,
} from "./d1-rdfjs-store-read.ts";

export type { D1Transaction } from "./d1-rdfjs-transaction.ts";

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

  /** worldId scopes all reads and writes when schema has a world_id column. */
  worldId?: string;

  /** requireDerivedColumn makes ensureSchema verify `quads.derived` (inference). */
  requireDerivedColumn?: boolean;
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
  private readonly worldId?: string;
  private readonly requireDerivedColumn: boolean;
  private readonly writes: D1WriteQueue;

  public constructor(options: D1RdfjsStoreOptions) {
    this.connection = options.connection;
    this.matchPageSize = options.matchPageSize ?? DEFAULT_D1_MATCH_PAGE_SIZE;
    this.writeBatchSize = options.maxWriteBatchSize ??
      DEFAULT_D1_MAX_WRITE_BATCH_SIZE;
    this.lookupChunkSize = options.maxLookupChunkSize ??
      DEFAULT_D1_MAX_LOOKUP_CHUNK_SIZE;
    this.schemaBuilder = options.schemaBuilder ??
      new D1SchemaBuilder(32, { worldId: options.worldId });
    this.worldId = options.worldId;
    this.requireDerivedColumn = options.requireDerivedColumn ?? false;
    this.writes = new D1WriteQueue(this.connection, this.worldId);
  }

  /**
   * ensureSchema creates the quads/chunks tables, covering indexes, and the
   * FTS5 external-content table + triggers (idempotent) and seeds the live
   * count. Called by the SDK factory; safe to call again.
   *
   * Statements run through the prepared-statement path (not exec()) because
   * D1's script executor splits on newlines, which would truncate the
   * shared sql-core emitters' multi-line DDL.
   */
  public async ensureSchema(): Promise<void> {
    await applyD1Schema(this.connection, this.schemaBuilder, {
      worldId: this.worldId,
      requireDerivedColumn: this.requireDerivedColumn,
    });
    await this.writes.refreshCount();
  }

  /** flush resolves once every queued write has committed. */
  public flush(): Promise<void> {
    return this.writes.flush();
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
    return this.writes.enqueueWrite(async () => {
      await applyD1Patch(
        {
          connection: this.connection,
          writeBatchSize: this.writeBatchSize,
          lookupChunkSize: this.lookupChunkSize,
          worldId: this.worldId,
        },
        patch,
        context,
      );
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
    void this.writes.enqueueWrite(() =>
      insertD1Quad(this.connection, this.worldId, quad)
    );
    return this;
  }

  public removeQuad(quad: rdfjs.Quad): this {
    void this.writes.enqueueWrite(() =>
      deleteD1Quad(this.connection, this.worldId, quad)
    );
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
      matchD1Pages(
        this.connection,
        this.matchPageSize,
        this.worldId,
        subject,
        predicate,
        object,
        graph,
      )
    );
  }

  /** getQuads collects the matching quads into an array. */
  public getQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<rdfjs.Quad[]> {
    return collectQuads(this.match(subject, predicate, object, graph));
  }

  /** countQuads returns the number of quads matching the pattern. */
  public countQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<number> {
    return countD1Matches(
      this.connection,
      this.worldId,
      subject,
      predicate,
      object,
      graph,
    );
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
      removeMatchedQuads(this, subject, predicate, object, graph)
    );
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
    return this.writes.liveCount;
  }
}
