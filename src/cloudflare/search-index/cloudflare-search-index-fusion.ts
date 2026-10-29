import {
  normalizeRrfScore,
  type SearchMode,
  type SearchResult,
} from "@worlds/sdk/search-index";
import type { VectorSearchHit } from "./vector-search/mod.ts";

interface RankedCandidate {
  score: number;
  result: SearchResult;
}

/**
 * fuseRankedLists merges the keyword and vector ranked lists into the final
 * ranked result set (contract D7, hybrid factor):
 *
 * - Keyword-only: every hit is `rrf` with its normalized keyword rank score.
 * - Vec-only (semantic): every hit is `cosine` with `max(0, cosine)`.
 * - Hybrid: hits present in BOTH lists score the mean of their normalized
 *   keyword and vector ranks (rank 0 in both → 1.0) as `rrf` (fused
 *   reciprocal rank); hits only in the vector list stay `cosine`; hits only
 *   in the keyword list stay `rrf`. Final order is score-descending (stable).
 *
 * `mode` reports what actually ran so consumers never assume semantic.
 */
export function fuseRankedLists(
  keywordHits: Array<SearchResult & { rankIndex: number }>,
  vectorHits: VectorSearchHit[],
): { results: RankedCandidate[]; mode: SearchMode } {
  if (vectorHits.length === 0) {
    return {
      mode: "keyword",
      results: keywordHits.map((hit) => ({ score: hit.score, result: hit })),
    };
  }

  if (keywordHits.length === 0) {
    const results = vectorHits.map((hit) => ({
      score: clampCosine(hit.score),
      result: hitToSearchResult(hit),
    }));
    return { mode: "semantic", results };
  }

  const keywordById = new Map(keywordHits.map((hit) => [hit.id, hit]));
  const results: RankedCandidate[] = [];

  for (let vectorRank = 0; vectorRank < vectorHits.length; vectorRank++) {
    const hit = vectorHits[vectorRank];
    const keywordMatch = keywordById.get(hit.id);
    if (keywordMatch) {
      // Present in both lists: mean of normalized ranks (rank 0 in both → 1.0).
      const fused = (keywordMatch.score + normalizeRrfScore(vectorRank)) / 2;
      results.push({
        score: fused,
        result: {
          id: keywordMatch.id,
          subject: keywordMatch.subject,
          predicate: keywordMatch.predicate,
          graph: keywordMatch.graph,
          text: keywordMatch.text,
          score: fused,
          scoreType: "rrf",
        },
      });
      keywordById.delete(hit.id);
    } else {
      results.push({
        score: clampCosine(hit.score),
        result: hitToSearchResult(hit),
      });
    }
  }

  for (const keywordOnly of keywordById.values()) {
    results.push({ score: keywordOnly.score, result: keywordOnly });
  }

  // Stable descending order by emitted score.
  results.sort((a, b) => b.score - a.score);
  return { mode: "hybrid", results };
}

function hitToSearchResult(hit: VectorSearchHit): SearchResult {
  return {
    id: hit.id,
    subject: hit.metadata?.subject ?? "",
    predicate: hit.metadata?.predicate ?? "",
    graph: hit.metadata?.graph ?? "",
    text: hit.metadata?.value ?? "",
    score: clampCosine(hit.score),
    scoreType: "cosine",
  };
}

/** Vectorize returns cosine similarity in [-1, 1]; clamp to the contract [0, 1]. */
function clampCosine(score: number): number {
  return Math.max(0, Math.min(1, score));
}
