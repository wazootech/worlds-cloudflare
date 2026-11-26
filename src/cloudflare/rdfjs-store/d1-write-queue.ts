import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import { countD1Quads } from "./d1-rdfjs-store-lifecycle.ts";

/**
 * D1WriteQueue serializes mutations (each runs after the previous one) and
 * keeps the synchronous size approximation refreshed after every write.
 */
export class D1WriteQueue {
  /** serialized write queue: every mutation runs after the previous one. */
  private mutationQueue: Promise<void> = Promise.resolve();
  /** Write failures recorded since the last flush() report. */
  private pendingFailures: unknown[] = [];
  /** synchronous size approximation, refreshed after every write. */
  public liveCount = 0;

  public constructor(
    private readonly connection: D1ConnectionDriver,
    private readonly worldId?: string,
  ) {}

  public async refreshCount(): Promise<void> {
    this.liveCount = await countD1Quads(this.connection, this.worldId);
  }

  /**
   * flush resolves once every queued write has committed, and rejects with an
   * AggregateError listing every failure since the previous flush (capped at
   * the first 10 plus a count of the rest, so a long outage does not produce
   * hundreds of copies of the same error). The queue itself keeps draining
   * later writes.
   */
  public flush(): Promise<void> {
    return this.mutationQueue.then(() => {
      const failures = this.pendingFailures;
      this.pendingFailures = [];
      if (failures.length === 0) return;
      const capped = failures.slice(0, MAX_REPORTED_FAILURES);
      const suppressed = failures.length - capped.length;
      const errors =
        suppressed > 0
          ? [
              ...capped,
              new Error(
                `${suppressed} more write failure(s) suppressed; see the logged errors`,
              ),
            ]
          : capped;
      throw new AggregateError(
        errors,
        `${failures.length} queued write(s) failed`,
      );
    });
  }

  /**
   * enqueueWrite serializes a write batch behind all prior writes and
   * refreshes the live count on completion.
   */
  public enqueueWrite(work: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.then(async () => {
      try {
        await work();
        await this.refreshCount();
      } catch (error) {
        this.pendingFailures.push(error);
        throw error;
      }
    });
    this.mutationQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

/** flush() reports at most this many of the failures it aggregates. */
const MAX_REPORTED_FAILURES = 10;
