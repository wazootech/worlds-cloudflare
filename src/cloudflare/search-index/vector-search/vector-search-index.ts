/**
 * VectorSearchIndex abstracts the vector nearest-neighbor index behind the
 * hosted search path (Phase C, worlds-api#1). The Cloudflare implementation
 * wraps a Vectorize binding; the fake is used in tests.
 *
 * Vector ids are the SDK's deterministic `buildSearchResultId` values — the
 * SAME ids the keyword FTS path emits — so hybrid fusion can correlate the
 * two result lists without any id reconciliation.
 */
export interface VectorSearchEntry {
  /** Contract search-result id (buildSearchResultId of the chunk quad). */
  id: string;
  /** Embedded chunk vector; must match the index dimensions. */
  vector: Float32Array;
  /**
   * Metadata used for filtering and result rendering. `world_uid` must be
   * present for per-world scoping (the hosted index registers it as a
   * filterable property at creation time).
   */
  metadata: Record<string, string>;
}

export interface VectorSearchHit {
  /** The entry id (`buildSearchResultId` of the chunk quad). */
  id: string;
  /** Cosine similarity in [-1, 1]; consumers clamp to the [0, 1] contract scale. */
  score: number;
  /** The entry metadata (subject/predicate/graph/value + world_uid). */
  metadata?: Record<string, string>;
}

export interface VectorSearchQueryOptions {
  /** Maximum number of nearest neighbors to return. */
  topK: number;
  /**
   * Exact-match metadata filter (e.g. `{ world_uid }`). The Cloudflare
   * binding only supports properties registered as filterable on the index.
   */
  filter?: Record<string, string>;
}

/**
 * VectorizeIndexLike is the minimal Vectorize binding surface the hosted
 * seam uses: query (similarity search), upsert, and deleteByIds. Cloudflare's
 * real `VectorizeIndex` binding satisfies it structurally (like
 * D1DatabaseLike), so tests can also exercise it with call-sites that accept
 * either.
 */
export interface VectorizeIndexLike {
  query(
    vector: number[],
    options?: {
      topK?: number;
      filter?: Record<string, string>;
      returnValues?: boolean;
      returnMetadata?: boolean;
    },
  ): Promise<{ matches: VectorizeMatchLike[]; count: number }>;
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, string>;
    }>,
  ): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

/** A single Vectorize query match, loosely typed for structural compatibility. */
export interface VectorizeMatchLike {
  id: string;
  score: number;
  metadata?: Record<string, string>;
}

/**
 * VectorSearchIndex is the provider boundary for vector nearest-neighbor
 * search used by the hybrid/semantic search path.
 */
export interface VectorSearchIndex {
  /** query returns the topK nearest neighbors to `vector`, best first. */
  query(
    vector: number[],
    options: VectorSearchQueryOptions,
  ): Promise<VectorSearchHit[]>;

  /** upsert inserts or replaces the given entries. */
  upsert(entries: VectorSearchEntry[]): Promise<void>;

  /** deleteByIds removes entries by id (best-effort for unknown ids). */
  deleteByIds(ids: string[]): Promise<void>;
}
