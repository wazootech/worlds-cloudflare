import type {
  VectorizeIndexLike,
  VectorSearchEntry,
  VectorSearchHit,
  VectorSearchIndex,
  VectorSearchQueryOptions,
} from "./vector-search-index.ts";

/**
 * VectorizeVectorSearchIndex implements VectorSearchIndex over a Cloudflare
 * Vectorize binding.
 *
 * The underlying index must be provisioned with `world_id` registered as a
 * filterable metadata property (wrangler `vectorize create` with a metadata
 * index config) so per-world scoping works at query time.
 */
export class VectorizeVectorSearchIndex implements VectorSearchIndex {
  public constructor(
    private readonly options: {
      index: VectorizeIndexLike;
      /** worldId scopes queries via the world_id metadata filter. */
      worldId?: string;
    },
  ) {}

  public async query(
    vector: number[],
    options: VectorSearchQueryOptions,
  ): Promise<VectorSearchHit[]> {
    const filter = options.filter ??
      (this.options.worldId ? { world_id: this.options.worldId } : undefined);

    const result = await this.options.index.query(vector, {
      topK: options.topK,
      ...(filter && { filter }),
      returnValues: false,
      returnMetadata: true,
    });

    return result.matches.map((match) => ({
      id: match.id,
      score: typeof match.score === "number" ? match.score : 0,
      metadata: metadataToRecord(match.metadata),
    }));
  }

  public async upsert(entries: VectorSearchEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.options.index.upsert(
      entries.map((entry) => ({
        id: entry.id,
        values: Array.from(entry.vector),
        metadata: { ...entry.metadata },
      })),
    );
  }

  public async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.options.index.deleteByIds(ids);
  }
}

function metadataToRecord(
  metadata: unknown,
): Record<string, string> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (
    const [key, value] of Object.entries(
      metadata as Record<string, unknown>,
    )
  ) {
    result[key] = String(value);
  }
  return result;
}
