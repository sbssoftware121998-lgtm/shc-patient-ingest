import { systemClock, type Clock } from "./clock.ts";

/**
 * Allows at most `limit` acquisitions in any rolling `windowMs` window, which is exactly
 * "N requests per second". (A token bucket with a burst of N can let nearly 2N through
 * within one rolling second.) Every HTTP attempt, including retries and split batches,
 * acquires a slot first.
 */
export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: Clock;
  /** Start times of the most recent `limit` acquisitions, oldest first. */
  private readonly recent: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(limit: number, windowMs = 1000, clock: Clock = systemClock) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  /** Resolves when one more request may start. Concurrent callers are served in order. */
  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(): Promise<void> {
    if (this.recent.length >= this.limit) {
      const oldest = this.recent.shift() ?? 0;
      // Re-check after sleeping: timers can fire a fraction of a millisecond early.
      let wait = oldest + this.windowMs - this.clock.now();
      while (wait > 0) {
        await this.clock.sleep(wait);
        wait = oldest + this.windowMs - this.clock.now();
      }
    }
    this.recent.push(this.clock.now());
  }
}
