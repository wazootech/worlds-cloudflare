import {
  buildChunksFtsTable,
  buildChunksQuadIdIndex,
  buildChunksTriggers,
} from "@worlds/sqlite/sql-core";

/** Maximum embedding dimensions accepted by D1SchemaBuilder (Vectorize cap: 1536 float32). */
const D1_MAX_VECTOR_DIMENSIONS = 1536;

/**
 * D1SchemaBuilder exposes DDL helpers bound to a single vector dimension for
 * D1 schema initialization. It mirrors the libsql reference shape (10-column
 * `quads` table + 7 covering indexes + `chunks` + FTS5 external-content
 * `chunks_fts`) but D1-safe: no loadable extensions, so the `chunks.vector`
 * column stays a plain `F32_BLOB(dim)` and the vector signal lives outside
 * D1 (Vectorize). FTS5 external-content tables and sync triggers are
 * supported on D1.
 */
export class D1SchemaBuilder {
  public readonly vectorDimensions: number;

  public constructor(vectorDimensions: number) {
    const dimensions = Math.floor(Number(vectorDimensions));
    if (
      !Number.isFinite(dimensions) ||
      dimensions < 1 ||
      dimensions > D1_MAX_VECTOR_DIMENSIONS
    ) {
      throw new Error(
        `vectorDimensions must be a finite integer in [1, ${D1_MAX_VECTOR_DIMENSIONS}], received: ${
          String(vectorDimensions)
        }`,
      );
    }
    this.vectorDimensions = dimensions;
  }

  /**
   * buildTables returns the idempotent DDL that creates the quads and chunks
   * tables in dependency order.
   */
  public buildTables(): string[] {
    return [this.buildD1QuadsTable(), this.buildD1ChunksTable()];
  }

  /**
   * buildIndexes returns DDL for 7 covering composite indexes on the quads table
   * (six subject-predicate-object-graph index orders + GPSO for graph-scoped access) enabling any quad pattern
   * to be resolved via a single index seek.
   */
  public buildIndexes(): string[] {
    return [
      "CREATE INDEX IF NOT EXISTS idx_quads_spog ON quads(s, p, o, g)",
      "CREATE INDEX IF NOT EXISTS idx_quads_sopg ON quads(s, o, p, g)",
      "CREATE INDEX IF NOT EXISTS idx_quads_pso ON quads(p, s, o)",
      "CREATE INDEX IF NOT EXISTS idx_quads_pos ON quads(p, o, s)",
      "CREATE INDEX IF NOT EXISTS idx_quads_ospg ON quads(o, s, p, g)",
      "CREATE INDEX IF NOT EXISTS idx_quads_opsg ON quads(o, p, s, g)",
      "CREATE INDEX IF NOT EXISTS idx_quads_gpso ON quads(g, p, s, o)",
    ];
  }

  public buildD1QuadsTable(): string {
    return "CREATE TABLE IF NOT EXISTS quads (id TEXT PRIMARY KEY, s TEXT NOT NULL, s_type TEXT NOT NULL, p TEXT NOT NULL, o TEXT NOT NULL, o_type TEXT NOT NULL, o_datatype TEXT, o_lang TEXT, g TEXT NOT NULL, g_type TEXT NOT NULL)";
  }

  public buildD1ChunksTable(): string {
    return `CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, quad_id TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, graph TEXT NOT NULL, value TEXT NOT NULL, fts_value TEXT NOT NULL, vector F32_BLOB(${this.vectorDimensions}))`;
  }

  public buildD1ChunksQuadIdIndex(): string {
    return buildChunksQuadIdIndex();
  }

  public buildD1ChunksFtsTable(): string {
    return buildChunksFtsTable();
  }

  public buildD1ChunksTriggers(): string[] {
    return buildChunksTriggers();
  }
}
