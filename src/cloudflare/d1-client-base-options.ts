import type { QuadFilter } from "@worlds/sdk/quad-store";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";

/**
 * InferenceOptions turns on OWL 2 RL materialization for one world. Off by
 * default: without it the commit path is unchanged and `quads.derived` is not
 * required.
 */
export interface InferenceOptions {
  /** enabled opts the world in. `{ enabled: false }` is the same as omitting it. */
  enabled: boolean;

  /**
   * graphs is the reasoner's named-graph mode. `"per-graph"` (default) lists
   * each entailed quad in the graph(s) that entail it alone, else in
   * `https://wazoo.dev/ns/reasoner#derived`; `"union"` merges all graphs and
   * lists everything in the default graph.
   */
  graphs?: "per-graph" | "union";

  /**
   * maxAssertedQuads is the size guard (default 100000). Each commit rebuilds
   * the reasoner from the world's asserted quads, so a commit that would
   * exceed it fails before writing instead of exhausting the isolate.
   */
  maxAssertedQuads?: number;
}

/**
 * D1ClientBaseOptions lists configuration shared by quad index Cloudflare D1 client factories.
 */
export interface D1ClientBaseOptions extends QuadFilter {
  /** embeddingService is an optional service projected for transforming text literals into comparison vectors. */
  embeddingService?: EmbeddingService;

  /** textSplitter is an optional custom text splitting facility, defaults to sensible character-based splitting. */
  textSplitter?: TextSplitterInterface;

  /** maxLookupChunkSize specifies the maximum number of host parameters allowed in cache query IN clauses before split-chunking. Defaults to 100 (D1's 100-bound-params/statement cap). */
  maxLookupChunkSize?: number;

  /**
   * vectorDimensions pins F32_BLOB width for chunk vectors and must match every embedding produced when embeddingService is set (default 1536).
   */
  vectorDimensions?: number;

  /**
   * matchPageSize limits rows per D1RdfjsStore.match SQL round-trip on reads (default 1000).
   */
  matchPageSize?: number;

  /** maxWriteBatchSize caps how many statements are sent per D1 batch, and so how many a commit may hold and still be atomic. Defaults to 2,000, the largest count measured fine on a real D1 at every vector dimension (Cloudflare documents no per-batch statement cap; the 100 limit is bound parameters per statement, a separate cap). */
  maxWriteBatchSize?: number;

  /** maxBatchWeight caps the estimated serialized bytes per D1 batch (default 16 MiB, 2x under the 32 MiB Worker-to-D1 RPC limit measured on a real D1). A commit is atomic only if it fits this and `maxWriteBatchSize`; heavy rows (1,536-dim vectors) hit this first. */
  maxBatchWeight?: number;

  /**
   * searchIndexOnImport controls when FTS/vector chunk projection runs during import.
   *
   * - `"incremental"` (default): chunks each quad on commit, so an import embeds only the quads it writes.
   * - `"deferred"`: persists quads on each import, then rebuilds FTS/vector chunks for the whole world in one pass.
   * - `"disabled"`: skips chunking entirely; caller calls `client.reindex()` before searching.
   */
  searchIndexOnImport?: SearchIndexOnImport;

  /**
   * inference opts this world in to OWL 2 RL materialization on write. Needs
   * the `quads.derived` column (see migrations/0001-quads-derived-column.sql).
   */
  inference?: InferenceOptions;
}
