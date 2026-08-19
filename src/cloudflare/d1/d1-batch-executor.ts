import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import type { D1Statement } from "@/cloudflare/d1/d1-connection-driver.ts";

/** DEFAULT_MAX_LOOKUP_CHUNK_SIZE is the default IN-clause and deletion chunk width (100 params/statement cap). */
export const DEFAULT_D1_MAX_LOOKUP_CHUNK_SIZE = 100;

/** DEFAULT_D1_MAX_WRITE_BATCH_SIZE limits statements per D1 batch() call (100 = the D1 batch cap). */
export const DEFAULT_D1_MAX_WRITE_BATCH_SIZE = 100;

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

  public constructor(private readonly options: D1BatchExecutorOptions) {}

  /**
   * stage appends statements and flushes eagerly when the staging buffer grows too large.
   */
  public async stage(source: readonly D1Statement[]): Promise<void> {
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
   * D1's atomic unit is a single batch() call capped at 100 statements, so
   * staged statements are chunked by writeBatchSize and executed sequentially.
   */
  public async flush(): Promise<void> {
    if (this.statements.length === 0) {
      return;
    }

    const { connection, writeBatchSize } = this.options;
    const staged = this.statements.splice(0, this.statements.length);

    try {
      for (let index = 0; index < staged.length; index += writeBatchSize) {
        await connection.batch(staged.slice(index, index + writeBatchSize));
      }
    } finally {
      this.statements.length = 0;
    }
  }
}
