import type {
  VectorSearchEntry,
  VectorSearchHit,
  VectorSearchIndex,
  VectorSearchQueryOptions,
} from "./vector-search-index.ts";

/**
 * FakeVectorSearchIndex is an in-memory cosine-similarity VectorSearchIndex
 * for tests. Deterministic and dependency-free: cosine is exact, equal scores
 * keep insertion order (stable sort), and filters match metadata exactly.
 */
export class FakeVectorSearchIndex implements VectorSearchIndex {
  private readonly entries = new Map<string, VectorSearchEntry>();

  public get size(): number {
    return this.entries.size;
  }

  public has(id: string): boolean {
    return this.entries.has(id);
  }

  public query(
    vector: number[],
    options: VectorSearchQueryOptions,
  ): Promise<VectorSearchHit[]> {
    const scored: Array<{ entry: VectorSearchEntry; score: number }> = [];
    for (const entry of this.entries.values()) {
      if (
        options.filter &&
        !hasMatchingFilter(entry.metadata, options.filter)
      ) {
        continue;
      }
      scored.push({ entry, score: cosine(vector, Array.from(entry.vector)) });
    }
    scored.sort((a, b) => b.score - a.score);
    return Promise.resolve(
      scored.slice(0, options.topK).map(({ entry, score }) => ({
        id: entry.id,
        score,
        metadata: { ...entry.metadata },
      })),
    );
  }

  public upsert(entries: VectorSearchEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
    return Promise.resolve();
  }

  public deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.entries.delete(id);
    }
    return Promise.resolve();
  }
}

function hasMatchingFilter(
  metadata: Record<string, string>,
  filter: Record<string, string>,
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (metadata[key] !== value) return false;
  }
  return true;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
