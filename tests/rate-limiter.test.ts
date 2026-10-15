import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.ts";
import { FakeClock, seededRandom } from "./helpers.ts";

describe("SlidingWindowRateLimiter", () => {
  it("lets `limit` requests start straight away, then waits for the window to slide", async () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowRateLimiter(5, 1000, clock);
    const starts: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      await limiter.acquire();
      starts.push(clock.now());
    }
    assert.deepEqual(starts, [0, 0, 0, 0, 0, 1000, 1000]);
  });

  it("never allows more than `limit` starts in any rolling window", async () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowRateLimiter(5, 1000, clock);
    const random = seededRandom(1);
    const starts: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      await limiter.acquire();
      starts.push(clock.now());
      clock.current += random() * 400; // the request itself takes 0-400 ms
    }
    for (const start of starts) {
      const inWindow = starts.filter((t) => t >= start && t < start + 1000).length;
      assert.ok(inWindow <= 5, `${inWindow} requests started within 1 s of t=${start}`);
    }
  });

  it("does not wait at all when requests are already slow enough", async () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowRateLimiter(5, 1000, clock);
    for (let i = 0; i < 10; i += 1) {
      await limiter.acquire();
      clock.current += 250;
    }
    assert.deepEqual(clock.sleeps, []);
  });
});
