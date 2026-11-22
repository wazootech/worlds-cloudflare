import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1Statement } from "@/cloudflare/d1/d1-connection-driver.ts";

/** DEFAULT_D1_MAX_LOOKUP_CHUNK_SIZE is the default IN-clause and deletion chunk width (100 params/statement cap). */
export const DEFAULT_D1_MAX_LOOKUP_CHUNK_SIZE = 100;

/** DEFAULT_D1_MAX_WRITE_BATCH_SIZE limits statements per D1 batch() call (a chosen size: Cloudflare documents no per-batch statement cap, and its own example runs a 2,000-statement batch; the 100-parameter cap is per statement and is a separate limit). */
export const DEFAULT_D1_MAX_WRITE_BATCH_SIZE = 2000;

/**
 * effectiveLookupChunkSize resolves the IN-clause chunk width for a statement
 * run. The documented cap is host parameters per statement; world-scoped
 * statements also bind world_id, so reserve one slot for it.
 */
export function effectiveLookupChunkSize(
  maxLookupChunkSize: number | undefined,
  worldScoped: boolean,
): number {
  return Math.max(
    1,
    (maxLookupChunkSize ?? DEFAULT_D1_MAX_LOOKUP_CHUNK_SIZE) -
      (worldScoped ? 1 : 0),
  );
}

/** STAGING_FLUSH_THRESHOLD flushes staged SQL during large commits to avoid huge in-memory arrays. */
export const STAGING_FLUSH_THRESHOLD = 10_000;

/**
 * D1BatchExecutorOptions defines the configuration for the batch executor.
 */
export interface D1BatchExecutorOptions {
  /** connection is the D1ConnectionDriver used for executing writes. */
  connection: D1ConnectionDriver;

  /** writeBatchSize limits statements per D1 batch() call. */
  writeBatchSize: number;
}

/**
 * D1BatchExecutor encapsulates statement buffering and chunked execution for D1.
 * It prevents memory blowouts by eagerly flushing when the staging buffer reaches the threshold.
 */
export class D1BatchExecutor {
  private readonly statements: D1Statement[] = [];

  /**
   * failure is set once a batch() call fails mid-flush. The executor is then
   * fail-closed: staged statements after the failed batch were never executed
   * and a retry would silently skip them, so every later stage/flush rejects.
   */
  private failure: { sent: number; staged: number; cause: unknown } | null =
    null;

  public constructor(private readonly options: D1BatchExecutorOptions) {}

  /**
   * stage appends statements and flushes eagerly when the staging buffer grows too large.
   */
  public async stage(source: readonly D1Statement[]): Promise<void> {
    if (this.failure) {
      throw this.failureError("stage");
    }
    const sourceLength = source.length;
    for (let index = 0; index < sourceLength; index++) {
      this.statements.push(source[index]!);
      if (this.statements.length >= STAGING_FLUSH_THRESHOLD) {
        await this.flush();
      }
    }
  }

  /**
   * flush executes and clears all currently staged write statements.
   * D1's atomic unit is a single batch() call (documented as a transaction),
   * so staged statements are chunked by writeBatchSize and executed
   * sequentially: a commit larger than one chunk is not atomic.
   *
   * A failure mid-stream leaves the commit partially applied (statements before
   * the failed batch committed; the rest never ran). The executor records that
   * state and refuses further use rather than letting a later flush silently
   * skip the unexecuted tail.
   */
  public async flush(): Promise<void> {
    if (this.failure) {
      throw this.failureError("flush");
    }
    if (this.statements.length === 0) {
      return;
    }

    const { connection, writeBatchSize } = this.options;
    const staged = this.statements.splice(0, this.statements.length);

    let sent = 0;
    try {
      for (let index = 0; index < staged.length; index += writeBatchSize) {
        await connection.batch(staged.slice(index, index + writeBatchSize));
        sent += Math.min(writeBatchSize, staged.length - index);
      }
    } catch (cause) {
      this.failure = { sent, staged: staged.length, cause };
      throw this.wrapFlushFailure(cause);
    }
  }

  private wrapFlushFailure(cause: unknown): Error {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const { sent = 0, staged = 0 } = this.failure ?? {};
    return new Error(
      `D1 batch failed after ${sent} of ${staged} staged statements (${
        staged - sent
      } not executed): ${detail}`,
      { cause },
    );
  }

  private failureError(operation: string): Error {
    const { sent = 0, staged = 0, cause } = this.failure!;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new Error(
      `D1 batch executor is fail-closed after a mid-stream batch failure (${sent} of ${staged} statements executed, ${
        staged - sent
      } not executed); ${operation} refused: ${detail}`,
      { cause },
    );
  }
}
