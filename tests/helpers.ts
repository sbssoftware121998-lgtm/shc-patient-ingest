import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../src/clock.ts";
import type { Settings } from "../src/config.ts";
import type { CleanRecord, PatientPayload } from "../src/types.ts";

export const HEADER = "patient_id,first_name,last_name,dob,email,phone,account_balance,last_modified";
export const TODAY = "2026-10-13";
export const fixedNow = () => new Date(`${TODAY}T12:00:00Z`);

/** What the assignment's 9-row sample must turn into. */
export const SAMPLE_EXPECTED: PatientPayload[] = [
  { patient_id: "P-1001", first_name: "John", last_name: "Doe", dob: "1980-05-15", email: "john.doe@newemail.com", phone: "555-0100", account_balance: 0, last_modified: "2026-10-05T14:20:00Z" },
  { patient_id: "P-1002", first_name: "Jane", last_name: "Smith", dob: "1992-12-31", email: null, phone: null, account_balance: 1250, last_modified: "2026-10-02T11:30:00Z" },
  { patient_id: "P-1003", first_name: "Alice", last_name: "Jones", dob: "1975-04-25", email: "alice.j@email.com", phone: "555-0102", account_balance: 300, last_modified: "2026-10-03T09:15:00Z" },
  { patient_id: "P-1004", first_name: "Bob", last_name: "Brown", dob: "1960-11-02", email: "bob.b@email.com", phone: "555-0103", account_balance: 2450.75, last_modified: "2026-10-01T10:00:00Z" },
  { patient_id: "P-1005", first_name: "Charlie", last_name: "Davis", dob: "1988-07-04", email: null, phone: "555-0104", account_balance: 0, last_modified: "2026-10-01T10:00:00Z" },
  { patient_id: "P-1006", first_name: "Diana", last_name: "Prince", dob: "1985-08-20", email: "diana.p@email.com", phone: null, account_balance: 45.5, last_modified: "2026-09-15T08:00:00Z" },
  { patient_id: "P-1007", first_name: "Evan", last_name: "Wright", dob: "1999-08-15", email: "evan.w@email.com", phone: "555-0105", account_balance: -15, last_modified: "2026-10-06T16:45:00Z" },
];

/** A clock that only moves when the code under test sleeps (or the test advances it). */
export class FakeClock implements Clock {
  current = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }
}

/** Deterministic pseudo-random numbers (mulberry32). */
export function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shc-ingest-test-"));
}

export async function writeCsv(dir: string, lines: string[], name = "input.csv"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

export function testSettings(overrides: Partial<Settings>): Settings {
  return {
    inputFile: "data/patients.csv",
    retryFile: "data/retry/failed_records.json",
    inputEncoding: "utf-8",
    outputDir: "output",
    apiUrl: "http://127.0.0.1:9/v1/patients",
    apiToken: "test-token",
    batchSize: 100,
    rateLimitPerSecond: 5,
    maxRetries: 5,
    backoffBaseMs: 1,
    backoffMaxMs: 20,
    requestTimeoutMs: 5000,
    maxConsecutiveFailedBatches: 3,
    dryRun: false,
    force: false,
    logLevel: "error",
    logFormat: "json",
    ...overrides,
  };
}

export function cleanRecord(patientId: string, sourceLine = 2): CleanRecord {
  return {
    payload: {
      patient_id: patientId,
      first_name: "Test",
      last_name: "Patient",
      dob: "1980-01-01",
      email: null,
      phone: null,
      account_balance: 0,
      last_modified: "2026-10-01T00:00:00Z",
    },
    sourceLine,
  };
}

export function json(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface FetchCall {
  ids: string[];
  headers: Headers;
  init: RequestInit;
  call: number;
}

/** A fetch stand-in that records every request; the handler may also throw to simulate network errors. */
export function fakeFetch(handler: (request: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { patients: Array<{ patient_id: string }> };
    const request = { ids: body.patients.map((p) => p.patient_id), headers: new Headers(init.headers), init, call: calls.length + 1 };
    calls.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}
