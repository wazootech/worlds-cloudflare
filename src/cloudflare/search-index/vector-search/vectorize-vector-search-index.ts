import type {
  VectorizeIndexLike,
  VectorSearchEntry,
  VectorSearchHit,
  VectorSearchIndex,
  VectorSearchQueryOptions,
} from "./vector-search-index.ts";
import { VECTORIZE_FILTERABLE_PROPERTY } from "./vectorize-provisioning.ts";

/** RESULT_ID_KEY is the metadata key carrying the contract search-result id. */
const RESULT_ID_KEY = "result_id";

/** WORLD_ID_KEY is the filterable metadata key that scopes vectors per world. */
const WORLD_ID_KEY = VECTORIZE_FILTERABLE_PROPERTY;

/**
 * VectorizeVectorSearchIndex implements VectorSearchIndex over a Cloudflare
 * Vectorize binding.
 *
 * One Vectorize index is shared by every world, so this class is where world
 * isolation is enforced rather than left to callers (worlds-cloudflare#41):
 *
 * - it cannot be constructed without a `worldId`;
 * - every upserted vector carries `world_id`, and a conflicting one is refused;
 * - every query is filtered on `world_id`, ANDed with any caller filter;
 * - physical vector ids are namespaced by world. Contract search-result ids
 *   are derived from the chunk quad alone, so two worlds holding the same
 *   triple text would otherwise share an id and overwrite or delete each
 *   other's vectors. The contract id travels in `result_id` metadata and is
 *   what callers see in hits and pass to `deleteByIds`.
 *
 * The underlying index must be provisioned with `world_id` registered as a
 * filterable metadata property (wrangler `vectorize create` with a metadata
 * index config).
 */
export class VectorizeVectorSearchIndex implements VectorSearchIndex {
  private readonly worldId: string;

  public constructor(
    private readonly options: {
      index: VectorizeIndexLike;
      /** worldId scopes every write, query and delete; required. */
      worldId: string;
    },
  ) {
    if (typeof options.worldId !== "string" || options.worldId.length === 0) {
      throw new Error(
        "VectorizeVectorSearchIndex requires a worldId: the Vectorize index is shared across worlds",
      );
    }
    this.worldId = options.worldId;
  }

  public async query(
    vector: number[],
    options: VectorSearchQueryOptions,
  ): Promise<VectorSearchHit[]> {
    const requested = options.filter?.[WORLD_ID_KEY];
    if (requested !== undefined && requested !== this.worldId) {
      throw new Error(
        `Vector query filter targets world ${requested}, but this index is scoped to ${this.worldId}`,
      );
    }
    const result = await this.options.index.query(vector, {
      topK: options.topK,
      filter: { ...options.filter, [WORLD_ID_KEY]: this.worldId },
      returnValues: false,
      returnMetadata: true,
    });
    return result.matches.map((match) => {
      const metadata = metadataToRecord(match.metadata);
      return {
        id: metadata?.[RESULT_ID_KEY] ?? match.id,
        score: typeof match.score === "number" ? match.score : 0,
        metadata,
      };
    });
  }

  public async upsert(entries: VectorSearchEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const vectors = [];
    for (const entry of entries) {
      const stated = entry.metadata[WORLD_ID_KEY];
      if (stated !== undefined && stated !== this.worldId) {
        throw new Error(
          `Vector ${entry.id} is labelled for world ${stated}, but this index is scoped to ${this.worldId}`,
        );
      }
      vectors.push({
        id: await this.physicalId(entry.id),
        values: Array.from(entry.vector),
        metadata: {
          ...entry.metadata,
          [WORLD_ID_KEY]: this.worldId,
          [RESULT_ID_KEY]: entry.id,
        },
      });
    }
    await this.options.index.upsert(vectors);
  }

  public async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.options.index.deleteByIds(
      await Promise.all(ids.map((id) => this.physicalId(id))),
    );
  }

  /**
   * physicalId namespaces a contract search-result id by world. Vectorize
   * caps ids at 64 bytes, so the pair is hashed (SHA-256, base64url: 45
   * characters with the prefix) instead of concatenated.
   */
  private async physicalId(resultId: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${this.worldId}\u0000${resultId}`),
    );
    return `v.${base64Url(new Uint8Array(digest))}`;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
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
