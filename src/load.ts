import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.ts";
import type { Logger } from "./logger.ts";
import {
  FAILURE_STATUS_CODES,
  errorMessage,
  isRetryable,
  type ApiFailureReason,
  type CleanRecord,
  type FailureEntry,
} from "./types.ts";

export const USER_AGENT = "globalhealth-shc-ingest/1.0.0";

export interface RetryPolicy {
  /** Retries after the first attempt, so up to maxRetries + 1 attempts in total. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type ResponseClass = "success" | "retry" | "reject" | "fatal";

/**
 * How each HTTP status is handled:
 *  - 2xx                → delivered;
 *  - 408, 429, 5xx      → transient: retried with exponential backoff;
 *  - 400, 409, 413, 422 → the API refused this payload: the bad record(s) are isolated and
 *                          logged to failed_records.json, and the run carries on;
 *  - anything else      → the integration itself is misconfigured (bad token, wrong URL, a
 *                          redirect): the run stops, since every later request would fail too.
 */
export function classifyStatus(status: number): ResponseClass {
  if (status >= 200 && status < 300) return "success";
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return "retry";
  if (status === 400 || status === 409 || status === 413 || status === 422) return "reject";
  return "fatal";
}

/**
 * Exponential backoff with "equal jitter": retry n waits between ½× and 1× of
 * baseDelayMs·2^(n-1), capped at maxDelayMs. A server's Retry-After is honoured as a floor.
 */
export function backoffDelayMs(
  policy: RetryPolicy,
  retryNumber: number,
  random: () => number,
  retryAfterMs?: number,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryNumber - 1));
  const delay = ceiling / 2 + random() * (ceiling / 2);
  return retryAfterMs === undefined ? delay : Math.max(delay, Math.min(retryAfterMs, policy.maxDelayMs));
}

/** Retry-After is either a number of seconds or an HTTP date. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** The API rejected the integration itself (credentials, URL...). Stops the run. */
export class FatalApiError extends Error {
  override name = "FatalApiError";
}

/** Too many consecutive batches exhausted their retries: the API is down. Stops the run. */
export class ApiUnavailableError extends Error {
  override name = "ApiUnavailableError";
}

type DeliveryFailure = "network_error" | "api_unavailable" | "api_timeout";

class RetriesExhaustedError extends Error {
  override name = "RetriesExhaustedError";
  readonly reason: DeliveryFailure;
  readonly status: number | null;

  constructor(message: string, reason: DeliveryFailure, status: number | null) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

export interface LoadStats {
  batches: number;
  requests: number;
  retries: number;
  loaded: number;
  rejected: number;
  failedAfterRetries: number;
  /** Never sent because the run stopped first. */
  notAttempted: number;
}

export interface LoaderOptions {
  url: string;
  token: string;
  batchSize: number;
  retry: RetryPolicy;
  requestTimeoutMs: number;
  maxConsecutiveFailedBatches: number;
  limiter: { acquire(): Promise<void> };
  failures: { append(entry: FailureEntry): Promise<void> };
  logger: Logger;
  fetch?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  /** Aborting stops the load before its next request; a request already in flight finishes. */
  signal?: AbortSignal;
}

interface ApiResponse {
  status: number;
  body: unknown;
}

/** Sends clean records to the SHC API in rate-limited batches, retrying transient failures. */
export class PatientLoader {
  readonly stats: LoadStats = {
    batches: 0,
    requests: 0,
    retries: 0,
    loaded: 0,
    rejected: 0,
    failedAfterRetries: 0,
    notAttempted: 0,
  };
  private readonly options: LoaderOptions;
  private readonly fetch: typeof fetch;
  private readonly clock: Clock;
  private readonly random: () => number;
  /** Records that were loaded, rejected or logged as failed; anything else was never sent. */
  private readonly settled = new Set<CleanRecord>();

  constructor(options: LoaderOptions) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
  }

  /**
   * If the load stops early (API down, bad credentials, shutdown), every record it did not get
   * to is logged as not_attempted before the error is rethrown, so failed_records.json always
   * holds every valid record that is not in the API.
   */
  async load(records: readonly CleanRecord[]): Promise<LoadStats> {
    try {
      return await this.loadAll(records);
    } catch (error) {
      for (const record of records) {
        if (this.settled.has(record)) continue;
        this.stats.notAttempted += 1;
        await this.logFailure(record, null, "not_attempted", null, `not sent: ${errorMessage(error)}`);
      }
      throw error;
    }
  }

  private async loadAll(records: readonly CleanRecord[]): Promise<LoadStats> {
    const { batchSize, maxConsecutiveFailedBatches, signal } = this.options;
    const total = Math.ceil(records.length / batchSize);
    let consecutiveFailures = 0;

    for (let index = 0; index < total; index += 1) {
      signal?.throwIfAborted();
      const batch = records.slice(index * batchSize, (index + 1) * batchSize);
      this.stats.batches += 1;
      const apiAvailable = await this.deliver(batch, `batch ${index + 1}/${total}`);
      consecutiveFailures = apiAvailable ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= maxConsecutiveFailedBatches) {
        throw new ApiUnavailableError(
          `${consecutiveFailures} consecutive batches failed even after retries; stopping instead of retrying every remaining batch`,
        );
      }
    }
    return this.stats;
  }

  /**
   * Sends one batch. When the API refuses its content (400-class), the batch is split in half
   * and each half re-sent, recursively, until the offending records are isolated: one invalid
   * patient should not keep 99 valid ones out. Returns false only when retries ran out.
   */
  private async deliver(batch: readonly CleanRecord[], batchName: string, offset = 0, whole = true): Promise<boolean> {
    const label = whole
      ? batchName
      : batch.length === 1
        ? `${batchName} record ${offset + 1}`
        : `${batchName} records ${offset + 1}-${offset + batch.length}`;
    let response: ApiResponse;
    try {
      response = await this.send(batch, label);
    } catch (error) {
      if (!(error instanceof RetriesExhaustedError)) throw error;
      this.stats.failedAfterRetries += batch.length;
      this.options.logger.error("batch failed after retries", { batch: label, records: batch.length, problem: error.message });
      for (const record of batch) await this.logFailure(record, label, error.reason, error.status, error.message);
      return false;
    }

    const outcome = classifyStatus(response.status);
    if (outcome === "success") {
      for (const record of batch) this.settled.add(record);
      this.stats.loaded += batch.length;
      // Pieces of a split batch are only interesting when debugging.
      const level = whole ? "info" : "debug";
      this.options.logger[level]("batch loaded", { batch: label, records: batch.length, status: response.status });
      return true;
    }
    if (outcome !== "reject") throw new FatalApiError(describeFatalStatus(response.status));

    const [only] = batch;
    if (batch.length === 1 && only) {
      this.stats.rejected += 1;
      this.options.logger.warn("record rejected by the API", {
        batch: label,
        patient_id: only.payload.patient_id,
        line: only.sourceLine,
        status: response.status,
      });
      await this.logFailure(only, label, "rejected_by_api", response.status, response.body);
      return true;
    }

    const middle = Math.ceil(batch.length / 2);
    this.options.logger.debug("batch rejected; splitting it to isolate the invalid record(s)", {
      batch: label,
      records: batch.length,
      status: response.status,
    });
    const firstHalf = await this.deliver(batch.slice(0, middle), batchName, offset, false);
    const secondHalf = await this.deliver(batch.slice(middle), batchName, offset + middle, false);
    return firstHalf && secondHalf;
  }

  /** POSTs one request, retrying transient failures; resolves with the first non-retryable response. */
  private async send(batch: readonly CleanRecord[], label: string): Promise<ApiResponse> {
    const { url, token, retry, requestTimeoutMs, limiter, logger, signal } = this.options;
    const body = JSON.stringify({ patients: batch.map((record) => record.payload) });
    // One key per logical request, reused on every retry, so the API can discard a duplicate if
    // an earlier attempt was processed but its response was lost (e.g. a 502 from a proxy).
    const idempotencyKey = randomUUID();
    const attempts = retry.maxRetries + 1;

    for (let attempt = 1; ; attempt += 1) {
      signal?.throwIfAborted();
      await limiter.acquire();
      this.stats.requests += 1;

      let problem: string;
      let reason: DeliveryFailure;
      let status: number | null = null;
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
            "idempotency-key": idempotencyKey,
            "user-agent": USER_AGENT,
          },
          body,
          redirect: "manual", // following a redirect would silently turn the POST into a GET
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        const responseBody = await readBody(response);
        if (classifyStatus(response.status) !== "retry") return { status: response.status, body: responseBody };
        status = response.status;
        problem = `HTTP ${response.status}`;
        reason = response.status === 408 ? "api_timeout" : "api_unavailable";
        retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
      } catch (error) {
        problem = describeRequestError(error, requestTimeoutMs); // connection failure or timeout
        reason = isTimeout(error) ? "api_timeout" : "network_error";
      }

      if (attempt >= attempts) throw new RetriesExhaustedError(`${problem} on all ${attempts} attempts`, reason, status);
      const delayMs = backoffDelayMs(retry, attempt, this.random, retryAfterMs);
      this.stats.retries += 1;
      logger.warn("request failed; retrying", {
        batch: label,
        attempt,
        max_attempts: attempts,
        problem,
        retry_in_ms: Math.round(delayMs),
      });
      await this.clock.sleep(delayMs, signal);
    }
  }

  /** `status` is the API's last HTTP status, or null if it never answered. */
  private async logFailure(
    record: CleanRecord,
    batch: string | null,
    reason: ApiFailureReason,
    status: number | null,
    detail: unknown,
  ): Promise<void> {
    this.settled.add(record);
    // A rejection keeps the API's own 4xx; every other reason has a fixed 5xx code.
    const statusCode = reason === "rejected_by_api" ? (status ?? 400) : FAILURE_STATUS_CODES[reason];
    await this.options.failures.append({
      stage: "api",
      reason,
      status_code: statusCode,
      retryable: isRetryable(statusCode),
      patient_id: record.payload.patient_id,
      source_lines: [record.sourceLine],
      http_status: status,
      detail,
      batch,
      record: record.payload,
      logged_at: new Date().toISOString(),
    });
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function describeRequestError(error: unknown, timeoutMs: number): string {
  if (isTimeout(error)) return `no response within ${timeoutMs} ms`;
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (typeof cause?.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
}

function describeFatalStatus(status: number): string {
  if (status === 401 || status === 403) return `SHC API rejected the credentials (HTTP ${status}); check SHC_API_TOKEN`;
  if (status >= 300 && status < 400) return `SHC API answered with a redirect (HTTP ${status}); check SHC_API_URL`;
  if (status === 404 || status === 405) return `SHC API endpoint not found (HTTP ${status}); check SHC_API_URL`;
  return `SHC API returned unexpected HTTP ${status}; stopping so it can be investigated`;
}
