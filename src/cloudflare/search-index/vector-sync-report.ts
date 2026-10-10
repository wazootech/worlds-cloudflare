/**
 * VectorSyncReport records what happened to the outside-D1 vector index
 * during a projection or reindex (worlds-cloudflare#40).
 *
 * Vector sync never fails a write — D1 is the source of truth and keyword
 * search keeps serving — but a failure is no longer discarded: it is counted
 * here, logged as an error, and surfaced by reindex so a caller can tell
 * "completed" from "D1 rebuilt, vectors drifted". Reindex is the repair path:
 * it re-embeds and re-upserts every chunk, and vector ids are deterministic
 * per world, so reruns are idempotent.
 */
export interface VectorSyncReport {
  /** enabled is false when no vector index or embedding service is wired. */
  enabled: boolean;
  /** attempted is the number of vectors sent to the vector index. */
  attempted: number;
  /** upserted is the number of vectors the vector index accepted. */
  upserted: number;
  /** failedUpserts is the number of vectors whose upsert failed. */
  failedUpserts: number;
  /** embeddingFailures is the number of chunks stored without a vector. */
  embeddingFailures: number;
  /** staleDeleteFailures is the number of stale vectors that could not be removed. */
  staleDeleteFailures: number;
  /** errors holds the first few failure messages, for diagnosis. */
  errors: string[];
}

const MAX_ERRORS = 5;

/** emptyVectorSyncReport starts a report for a pass with vector sync on or off. */
export function emptyVectorSyncReport(enabled: boolean): VectorSyncReport {
  return {
    enabled,
    attempted: 0,
    upserted: 0,
    failedUpserts: 0,
    embeddingFailures: 0,
    staleDeleteFailures: 0,
    errors: [],
  };
}

/** mergeVectorSyncReports sums two reports (e.g. across reindex pages). */
export function mergeVectorSyncReports(
  left: VectorSyncReport,
  right: VectorSyncReport,
): VectorSyncReport {
  return {
    enabled: left.enabled || right.enabled,
    attempted: left.attempted + right.attempted,
    upserted: left.upserted + right.upserted,
    failedUpserts: left.failedUpserts + right.failedUpserts,
    embeddingFailures: left.embeddingFailures + right.embeddingFailures,
    staleDeleteFailures: left.staleDeleteFailures + right.staleDeleteFailures,
    errors: [...left.errors, ...right.errors].slice(0, MAX_ERRORS),
  };
}

/** vectorSyncSucceeded is true when nothing was dropped or left stale. */
export function vectorSyncSucceeded(report: VectorSyncReport): boolean {
  return report.failedUpserts === 0 && report.embeddingFailures === 0 &&
    report.staleDeleteFailures === 0;
}

/** recordVectorSyncError appends a failure message, keeping the list short. */
export function recordVectorSyncError(
  report: VectorSyncReport,
  stage: string,
  error: unknown,
): void {
  if (report.errors.length >= MAX_ERRORS) return;
  const message = error instanceof Error ? error.message : String(error);
  report.errors.push(`${stage}: ${message}`);
}

/**
 * logVectorSyncDrift emits one structured error when a pass left the vector
 * index out of step with D1, so drift is visible in Worker logs.
 */
export function logVectorSyncDrift(
  report: VectorSyncReport,
  context: { worldId?: string; operation: string },
): void {
  if (!report.enabled || vectorSyncSucceeded(report)) return;
  console.error(
    "[vector-sync] vector index drifted from D1; run reindex to repair",
    JSON.stringify({
      worldId: context.worldId ?? null,
      operation: context.operation,
      attempted: report.attempted,
      upserted: report.upserted,
      failedUpserts: report.failedUpserts,
      embeddingFailures: report.embeddingFailures,
      staleDeleteFailures: report.staleDeleteFailures,
      errors: report.errors,
    }),
  );
}
