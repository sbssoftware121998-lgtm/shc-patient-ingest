import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ApiUnavailableError,
  FatalApiError,
  PatientLoader,
  backoffDelayMs,
  classifyStatus,
  parseRetryAfterMs,
  type LoaderOptions,
} from "../src/load.ts";
import { silentLogger } from "../src/logger.ts";
import type { FailureEntry } from "../src/types.ts";
import { FakeClock, cleanRecord, fakeFetch, json } from "./helpers.ts";

function makeLoader(fetchImpl: typeof fetch, overrides: Partial<LoaderOptions> = {}) {
  const clock = new FakeClock();
  const failures: FailureEntry[] = [];
  const loader = new PatientLoader({
    url: "https://api.test/v1/patients",
    token: "secret-token",
    batchSize: 100,
    retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    requestTimeoutMs: 1000,
    maxConsecutiveFailedBatches: 3,
    limiter: { acquire: async () => {} },
    failures: { append: async (entry) => void failures.push(entry) },
    logger: silentLogger,
    fetch: fetchImpl,
    clock,
    random: () => 1, // jitter at its maximum, so delays are exactly base·2^(n-1)
    ...overrides,
  });
  return { loader, clock, failures };
}

const records = (count: number) => Array.from({ length: count }, (_, i) => cleanRecord(`P-${1000 + i}`, i + 2));

describe("PatientLoader", () => {
  it("sends at most batchSize records per request", async () => {
    const api = fakeFetch(() => json(200));
    const { loader } = makeLoader(api.fetch);
    const stats = await loader.load(records(250));
    assert.deepEqual(api.calls.map((call) => call.ids.length), [100, 100, 50]);
    assert.equal(stats.loaded, 250);
  });

  it("POSTs JSON with a bearer token and never follows redirects", async () => {
    const api = fakeFetch(() => json(200));
    const { loader } = makeLoader(api.fetch);
    await loader.load(records(1));
    const [call] = api.calls;
    assert.equal(call?.init.method, "POST");
    assert.equal(call?.init.redirect, "manual");
    assert.equal(call?.headers.get("authorization"), "Bearer secret-token");
    assert.equal(call?.headers.get("content-type"), "application/json");
    assert.match(call?.headers.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/);
  });

  it("retries 5xx with exponential backoff, reusing one idempotency key", async () => {
    const api = fakeFetch(({ call }) => (call <= 3 ? json(503) : json(200)));
    const { loader, clock } = makeLoader(api.fetch);
    const stats = await loader.load(records(1));
    assert.deepEqual(clock.sleeps, [100, 200, 400]);
    assert.equal(new Set(api.calls.map((call) => call.headers.get("idempotency-key"))).size, 1);
    assert.deepEqual([stats.requests, stats.retries, stats.loaded], [4, 3, 1]);
  });

  it("waits at least as long as a 429's Retry-After", async () => {
    const api = fakeFetch(({ call }) => (call === 1 ? json(429, {}, { "retry-after": "1" }) : json(200)));
    const { loader, clock } = makeLoader(api.fetch);
    await loader.load(records(1));
    assert.deepEqual(clock.sleeps, [1000]);
  });

  it("retries connection failures and timeouts", async () => {
    const api = fakeFetch(({ call }) => {
      if (call === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      if (call === 2) throw new DOMException("The operation timed out.", "TimeoutError");
      return json(200);
    });
    const { loader } = makeLoader(api.fetch);
    const stats = await loader.load(records(1));
    assert.deepEqual([stats.retries, stats.loaded], [2, 1]);
  });

  it("isolates rejected records by splitting the batch, and loads all the others", async () => {
    const invalid = new Set(["P-1042", "P-1077"]);
    const api = fakeFetch(({ ids }) =>
      ids.some((id) => invalid.has(id)) ? json(400, { error: "validation_failed" }) : json(200),
    );
    const { loader, failures } = makeLoader(api.fetch);
    const stats = await loader.load(records(100));

    assert.deepEqual([stats.loaded, stats.rejected], [98, 2]);
    assert.deepEqual(failures.map((entry) => entry.patient_id), ["P-1042", "P-1077"]);
    assert.deepEqual(
      failures.map(({ stage, reason, status_code, retryable, http_status, detail }) => ({ stage, reason, status_code, retryable, http_status, detail })),
      Array(2).fill({
        stage: "api",
        reason: "rejected_by_api",
        status_code: 400, // the API's own status: the data must be fixed, not resent
        retryable: false,
        http_status: 400,
        detail: { error: "validation_failed" },
      }),
    );
    // Bisection costs about two requests per level per bad record, not one request per record.
    assert.ok(api.calls.length <= 1 + 2 * 2 * Math.ceil(Math.log2(100)), `${api.calls.length} requests`);
  });

  it("logs a batch whose retries run out and carries on with the next batch", async () => {
    const api = fakeFetch(({ ids }) => (ids.includes("P-1000") ? json(503) : json(200)));
    const { loader, failures } = makeLoader(api.fetch, { batchSize: 2 });
    const stats = await loader.load(records(4));
    assert.deepEqual([stats.loaded, stats.failedAfterRetries], [2, 2]);
    assert.deepEqual(
      failures.map((entry) => [entry.patient_id, entry.reason, entry.status_code, entry.retryable, entry.http_status]),
      [["P-1000", "api_unavailable", 503, true, 503], ["P-1001", "api_unavailable", 503, true, 503]],
    );
  });

  for (const [name, fail, reason, statusCode] of [
    ["a connection failure", () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }, "network_error", 500],
    ["a timeout", () => { throw new DOMException("The operation timed out.", "TimeoutError"); }, "api_timeout", 504],
    ["a 429", () => json(429), "api_unavailable", 503],
    ["a 408", () => json(408), "api_timeout", 504],
  ] as const) {
    it(`logs ${name} that outlasts the retries as ${reason} (${statusCode})`, async () => {
      const api = fakeFetch(fail);
      const { loader, failures } = makeLoader(api.fetch);
      await loader.load(records(1));
      assert.deepEqual(
        failures.map(({ reason, status_code, retryable, record }) => ({ reason, status_code, retryable, id: record?.patient_id })),
        [{ reason, status_code: statusCode, retryable: true, id: "P-1000" }],
      );
    });
  }

  it("stops once several batches in a row exhaust their retries (the API is down)", async () => {
    const api = fakeFetch(() => json(503));
    const { loader, failures } = makeLoader(api.fetch, { batchSize: 1, maxConsecutiveFailedBatches: 2 });
    await assert.rejects(loader.load(records(5)), ApiUnavailableError);
    assert.equal(api.calls.length, 2 * 4); // two batches × (1 attempt + 3 retries)
    // The three batches never sent are logged too, so --retry can pick them up.
    assert.deepEqual(
      failures.map((entry) => [entry.patient_id, entry.reason, entry.status_code]),
      [["P-1000", "api_unavailable", 503], ["P-1001", "api_unavailable", 503], ["P-1002", "not_attempted", 503], ["P-1003", "not_attempted", 503], ["P-1004", "not_attempted", 503]],
    );
    assert.equal(loader.stats.notAttempted, 3);
  });

  for (const [status, message] of [
    [401, /credentials/],
    [403, /credentials/],
    [404, /endpoint not found/],
    [302, /redirect/],
  ] as const) {
    it(`stops the run on HTTP ${status} instead of retrying, and logs the unsent records as retryable`, async () => {
      const api = fakeFetch(() => new Response(null, { status }));
      const { loader, failures } = makeLoader(api.fetch);
      await assert.rejects(loader.load(records(3)), (error: Error) => error instanceof FatalApiError && message.test(error.message));
      assert.equal(api.calls.length, 1);
      // Their data is fine: once the configuration is fixed, --retry sends them.
      assert.deepEqual(new Set(failures.map((entry) => `${entry.reason} ${entry.status_code} ${entry.retryable}`)), new Set(["not_attempted 503 true"]));
      assert.equal(failures.length, 3);
    });
  }

  it("stops before its next request once shutdown is requested", async () => {
    const shutdown = new AbortController();
    const api = fakeFetch(() => {
      shutdown.abort();
      return json(200);
    });
    const { loader } = makeLoader(api.fetch, { batchSize: 1, signal: shutdown.signal });
    await assert.rejects(loader.load(records(3)), { name: "AbortError" });
    assert.equal(api.calls.length, 1);
    assert.equal(loader.stats.loaded, 1); // the in-flight request was allowed to finish
  });
});

describe("classifyStatus", () => {
  it("sorts statuses into the four ways we handle them", () => {
    const table = Object.fromEntries([200, 201, 302, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503].map((s) => [s, classifyStatus(s)]));
    assert.deepEqual(table, {
      200: "success", 201: "success", 302: "fatal", 400: "reject", 401: "fatal", 403: "fatal", 404: "fatal", 408: "retry",
      409: "reject", 413: "reject", 422: "reject", 429: "retry", 500: "retry", 502: "retry", 503: "retry",
    });
  });
});

describe("backoffDelayMs", () => {
  const policy = { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30_000 };

  it("doubles each retry and stays between half and all of the ceiling", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => backoffDelayMs(policy, n, () => 1)), [1000, 2000, 4000, 8000]);
    assert.deepEqual([1, 2, 3, 4].map((n) => backoffDelayMs(policy, n, () => 0)), [500, 1000, 2000, 4000]);
  });

  it("is capped at maxDelayMs", () => {
    assert.equal(backoffDelayMs(policy, 10, () => 1), 30_000);
  });

  it("treats Retry-After as a floor, also capped", () => {
    assert.equal(backoffDelayMs(policy, 1, () => 1, 5000), 5000);
    assert.equal(backoffDelayMs(policy, 4, () => 1, 1000), 8000);
    assert.equal(backoffDelayMs(policy, 1, () => 1, 3_600_000), 30_000);
  });
});

describe("parseRetryAfterMs", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    assert.equal(parseRetryAfterMs("2", now), 2000);
    assert.equal(parseRetryAfterMs("Tue, 13 Oct 2026 12:00:05 GMT", now), 5000);
    assert.equal(parseRetryAfterMs("soon", now), undefined);
    assert.equal(parseRetryAfterMs(null, now), undefined);
  });
});
