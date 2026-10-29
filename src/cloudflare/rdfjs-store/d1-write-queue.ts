import type { D1ConnectionDriver } from "@/cloudflare/d1/d1-connection-driver.ts";
import { countD1Quads } from "./d1-rdfjs-store-lifecycle.ts";

/**
 * D1WriteQueue serializes mutations (each runs after the previous one) and
 * keeps the synchronous size approximation refreshed after every write.
 */
export class D1WriteQueue {
  /** serialized write queue: every mutation runs after the previous one. */
  private mutationQueue: Promise<void> = Promise.resolve();
  /** synchronous size approximation, refreshed after every write. */
  public liveCount = 0;

  public constructor(
    private readonly connection: D1ConnectionDriver,
    private readonly worldId?: string,
  ) {}

  public async refreshCount(): Promise<void> {
    this.liveCount = await countD1Quads(this.connection, this.worldId);
  }

  /** flush resolves once every queued write has committed. */
  public flush(): Promise<void> {
    return this.mutationQueue;
  }

  /**
   * enqueueWrite serializes a write batch behind all prior writes and
   * refreshes the live count on completion.
   */
  public enqueueWrite(work: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.then(async () => {
      await work();
      await this.refreshCount();
    });
    this.mutationQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}
