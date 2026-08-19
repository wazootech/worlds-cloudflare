import type { QuadFilter } from "@worlds/sdk/quad-store";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";

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

  /** maxWriteBatchSize caps how many statements are sent per D1 batch. Defaults to 500. */
  maxWriteBatchSize?: number;

  /**
   * searchIndexOnImport controls when FTS/vector chunk projection runs during import.
   *
   * - `"incremental"`: chunks each quad on commit.
   * - `"deferred"` (default for Cloudflare): persists quads on each import, rebuilds FTS/vector chunks in one pass afterward.
   * - `"disabled"`: skips chunking entirely; caller calls `client.reindex()` before searching.
   */
  searchIndexOnImport?: SearchIndexOnImport;
}
