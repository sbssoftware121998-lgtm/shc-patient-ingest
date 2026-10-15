/**
 * Local stand-in for the SHC Platform patients endpoint, used by the integration tests and
 * the docker-compose demo. It enforces the documented contract (bearer token, at most 100
 * records per request, at most 5 requests per second) and can inject transient 503s so the
 * client's retry logic gets exercised.
 *
 * Run it with `node mock-api/server.ts` (Node >= 22.18 runs TypeScript directly).
 * Environment: PORT (8080), MOCK_API_TOKEN, MOCK_FAILURE_RATE (0-1), MOCK_RATE_LIMIT_PER_SECOND,
 * DATABASE_URL (store patients in PostgreSQL instead of memory) and MOCK_DB_TABLE
 * (default global_health_client_patient_data_master).
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { DEFAULT_TABLE, MemoryPatientStore, PostgresPatientStore, describeDbError, type PatientStore } from "./store.ts";

export interface MockApiOptions {
  token: string;
  maxBatchSize?: number;
  rateLimitPerSecond?: number;
  /** Probability (0-1) that a request fails with a transient 503 before anything is stored. */
  failureRate?: number;
  random?: () => number;
  log?: (line: string) => void;
  /** Defaults to an in-memory store. */
  store?: PatientStore;
}

export interface MockApi {
  url: string;
  store: PatientStore;
  /** Number of responses per HTTP status. */
  statusCounts: Map<number, number>;
  close(): Promise<void>;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Shown after the status in the request log, e.g. "stored 100 patients". */
  note?: string;
}

// The platform's own rules. Deliberately stricter than the client (e.g. the ID format), so the
// client's handling of 400 responses can be demonstrated with data that looks fine locally.
const PATIENT_ID = /^P-\d{4,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function startMockApi(options: MockApiOptions, port = 0, host = "127.0.0.1"): Promise<MockApi> {
  const maxBatchSize = options.maxBatchSize ?? 100;
  const rateLimit = options.rateLimitPerSecond ?? 5;
  const failureRate = options.failureRate ?? 0;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const store = options.store ?? new MemoryPatientStore();
  const statusCounts = new Map<number, number>();
  const recentRequests: number[] = [];

  async function handle(request: IncomingMessage): Promise<Reply> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/healthz") {
      return { status: 200, body: { status: "ok", storage: store.storage, table: store.table } };
    }
    if (path !== "/v1/patients") return { status: 404, body: { error: "not_found" } };
    if (request.headers.authorization !== `Bearer ${options.token}`) return { status: 401, body: { error: "unauthorized" } };
    if (request.method === "GET") return { status: 200, body: { patients: await store.list() } };
    if (request.method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };

    // At most `rateLimit` accepted requests in any rolling second.
    const now = performance.now();
    while (recentRequests.length > 0 && now - recentRequests[0]! >= 1000) recentRequests.shift();
    if (recentRequests.length >= rateLimit) {
      return { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" }, note: "rate limit exceeded" };
    }
    recentRequests.push(now);

    if (random() < failureRate) {
      return { status: 503, body: { error: "service_unavailable" }, note: "injected failure (MOCK_FAILURE_RATE); the client retries" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(request));
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    const records = (payload as { patients?: unknown } | null)?.patients;
    if (!Array.isArray(records) || records.length === 0) {
      return { status: 400, body: { error: "expected a non-empty 'patients' array" } };
    }
    if (records.length > maxBatchSize) {
      return { status: 413, body: { error: `at most ${maxBatchSize} records per request` } };
    }

    const details = records.flatMap((record: unknown, index) =>
      validate(record).map((message) => ({ index, patient_id: (record as { patient_id?: unknown })?.patient_id, message })),
    );
    // Atomic: if anything is invalid, nothing from the request is stored.
    if (details.length > 0) {
      const ids = [...new Set(details.map((detail) => String(detail.patient_id)))];
      return { status: 400, body: { error: "validation_failed", details }, note: `rejected: invalid ${ids.join(", ")}; nothing stored` };
    }

    const ids = records.map((record: { patient_id?: unknown }) => record.patient_id);
    if (new Set(ids).size !== ids.length) return { status: 400, body: { error: "duplicate patient_id in request" } };

    try {
      await store.upsert(records as Array<Record<string, unknown>>);
    } catch (error) {
      log(`storage error: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 500, body: { error: "storage_failed" } }; // nothing stored; the client retries
    }
    return { status: 200, body: { accepted: records.length }, note: `stored ${records.length} patient(s)` };
  }

  const server = createServer((request, response) => {
    handle(request)
      .catch((): Reply => ({ status: 500, body: { error: "internal_error" } }))
      .then(({ status, body, headers, note }) => {
        statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
        if (request.url !== "/healthz") log(`${request.method} ${request.url} -> ${status}${note ? `  ${note}` : ""}`);
      });
  });

  // Reject (rather than crash the process) when the port is taken, so callers can explain it.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`,
    store,
    statusCounts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function validate(record: unknown): string[] {
  if (typeof record !== "object" || record === null) return ["record must be an object"];
  const r = record as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof r.patient_id !== "string" || !PATIENT_ID.test(r.patient_id)) problems.push("patient_id must look like P-1234");
  for (const field of ["first_name", "last_name"]) {
    if (typeof r[field] !== "string" || (r[field] as string).trim() === "") problems.push(`${field} is required`);
  }
  if (typeof r.dob !== "string" || !isIsoDate(r.dob)) problems.push("dob must be a YYYY-MM-DD date");
  if (r.email !== null && (typeof r.email !== "string" || !EMAIL.test(r.email))) problems.push("email must be null or a valid address");
  if (r.phone !== null && typeof r.phone !== "string") problems.push("phone must be null or a string");
  if (r.account_balance !== null && (typeof r.account_balance !== "number" || !Number.isFinite(r.account_balance))) {
    problems.push("account_balance must be null or a number");
  } else if (typeof r.account_balance === "number" && !hasAtMostTwoDecimals(r.account_balance)) {
    problems.push("account_balance must have at most 2 decimal places"); // stored as numeric(14, 2)
  }
  if (typeof r.last_modified !== "string" || Number.isNaN(Date.parse(r.last_modified))) {
    problems.push("last_modified must be an ISO 8601 timestamp");
  }
  return problems;
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6 && Math.abs(value) < 1e12;
}

function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  const memoryOnly = process.env.MOCK_STORAGE?.trim().toLowerCase() === "memory";
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const table = process.env.MOCK_DB_TABLE || DEFAULT_TABLE;
  const say = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  let store: PatientStore = new MemoryPatientStore();
  if (!memoryOnly && !databaseUrl) {
    console.error("cannot start: DATABASE_URL is not set, so there is nowhere to store patients.");
    console.error("  Set it in .env (see .env.example), or run without a database: MOCK_STORAGE=memory npm run mock-api");
    process.exit(1);
  }
  if (!memoryOnly && databaseUrl) {
    try {
      const postgres = await PostgresPatientStore.connect(databaseUrl, table, say);
      store = postgres;
      const where = new URL(databaseUrl);
      console.log(`storing patients in PostgreSQL table ${table} (database "${where.pathname.slice(1)}" on ${where.host})`);
      if (postgres.createdDatabase) console.log(`  database "${where.pathname.slice(1)}" did not exist, so it was created`);
      console.log(
        postgres.createdTable
          ? `  table ${table} did not exist, so it was created (empty)`
          : `  table ${table} already exists with ${await postgres.count()} patient(s)`,
      );
    } catch (error) {
      const where = new URL(databaseUrl).host;
      console.error(`cannot use PostgreSQL on ${where}: ${describeDbError(error)}`);
      console.error("  Check that PostgreSQL is running and that DATABASE_URL in .env (user, password, host, port, database) is right.");
      console.error("  To run without a database (patients kept in memory only): MOCK_STORAGE=memory npm run mock-api");
      process.exit(1);
    }
  } else {
    console.log("storing patients in memory (MOCK_STORAGE=memory): they are lost when this API stops.");
  }
  let api: MockApi;
  try {
    api = await startMockApi(
      {
        token: process.env.MOCK_API_TOKEN ?? "local-demo-token",
        failureRate: Number(process.env.MOCK_FAILURE_RATE ?? 0),
        rateLimitPerSecond: Number(process.env.MOCK_RATE_LIMIT_PER_SECOND ?? 5),
        log: say,
        store,
      },
      port,
      process.env.HOST ?? "0.0.0.0",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    console.error(`cannot start: port ${port} is already in use.`);
    console.error("  Run either the local setup or Docker, not both. If the Docker one is running, stop it: npm run docker:down");
    await store.close();
    process.exit(1);
  }
  console.log(`mock SHC API listening on ${api.url}/v1/patients`);
  console.log("  Waiting for the ingestion job to send patients (Ctrl+C to stop)");
  const stop = () => void api.close().then(() => store.close()).then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
