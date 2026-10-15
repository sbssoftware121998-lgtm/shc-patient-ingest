import { setTimeout as delay } from "node:timers/promises";

/** Time source, injectable so retry and rate-limit behaviour can be tested without real waiting. */
export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Resolves after `ms`; rejects early if `signal` is aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, signal) => delay(Math.max(0, Math.ceil(ms)), undefined, signal ? { signal } : undefined),
};
