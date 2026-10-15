/**
 * Loads data/patients_extended.csv (144 rows, one scenario per row; see data/README.md) into
 * the mock SHC API at the real limit of 5 requests/second, with 20% of requests failing
 * transiently, and checks every documented outcome.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startMockApi, type MockApi } from "../mock-api/server.ts";
import { MemoryPatientStore } from "../mock-api/store.ts";
import { silentLogger } from "../src/logger.ts";
import { runPipeline, type RunReport } from "../src/pipeline.ts";
import { fixedNow, seededRandom, tempDir, testSettings } from "./helpers.ts";

interface FailureEntry {
  stage: string;
  reason: string;
  status_code: number;
  retryable: boolean;
  patient_id: string | null;
  source_lines: number[];
}

describe("extended dataset (data/patients_extended.csv)", { timeout: 60_000 }, () => {
  let api: MockApi;
  const store = new MemoryPatientStore();
  let report: RunReport;
  let failures: FailureEntry[];
  let invalid: FailureEntry[];

  before(async () => {
    api = await startMockApi({ token: "test-token", failureRate: 0.2, random: seededRandom(42), store });
    const outputDir = await tempDir();
    report = await runPipeline(
      testSettings({
        inputFile: "data/patients_extended.csv",
        outputDir,
        apiUrl: `${api.url}/v1/patients`,
        backoffBaseMs: 50,
        backoffMaxMs: 500,
      }),
      { logger: silentLogger, now: fixedNow },
    );
    failures = JSON.parse(await readFile(join(outputDir, "failed_records.json"), "utf8")) as FailureEntry[];
    invalid = JSON.parse(await readFile(join(outputDir, "validation_errors.json"), "utf8")) as FailureEntry[];
  });

  after(() => api.close());

  it("produces the documented totals", () => {
    assert.equal(report.status, "completed_with_failures");
    assert.deepEqual(report.counts, {
      rows_read: 144,
      rows_repaired: 3,
      rows_rejected: 3,
      duplicate_rows_superseded: 9,
      patients_found: 130,
      patients_rejected: 19,
      patients_valid: 111,
      patients_loaded: 108,
      patients_rejected_by_api: 3,
      patients_failed_after_retries: 0,
      patients_not_attempted: 0,
    });
    assert.deepEqual(report.issue_counts, {
      row_repaired: 3,
      duplicate_superseded: 9,
      duplicate_timestamp_tie: 1,
      dob_ambiguous: 4,
      missing_email: 5,
      missing_phone: 5,
      invalid_email_dropped: 2,
      missing_account_balance: 1,
      non_default_currency: 3,
    });
    assert.deepEqual(report.dob_formats, { "YYYY-MM-DD": 96, "MM/DD/YYYY": 9, "DD-MM-YYYY": 6 });
  });

  const summarize = (entries: FailureEntry[]) =>
    entries.map((entry) => `${entry.stage} ${entry.reason} ${entry.status_code} ${entry.retryable} ${entry.patient_id}`).sort();

  it("logs exactly the documented records to validation_errors.json, each with its status_code", () => {
    const validation = (reason: string, code: number, ids: Array<string | null>) =>
      ids.map((id) => `validation ${reason} ${code} false ${id}`);
    assert.deepEqual(
      summarize(invalid),
      [
        ...validation("malformed_row", 400, ["P-2225", "P-2601"]),
        ...validation("missing_patient_id", 404, [null]),
        ...validation("unresolvable_duplicate", 409, ["P-2507"]),
        ...validation("invalid_record", 422, [
          "P-2120", "P-2121", "P-2122", "P-2123", "P-2124", "P-2125", "P-2126", "P-2127", "P-2128",
          "P-2220", "P-2221", "P-2222", "P-2223", "P-2224",
          "P-2407", "P-2408", "P-2506", "P-2508",
        ]),
      ].sort(),
    );
  });

  it("logs exactly the records the API refused to failed_records.json, with the API's status", () => {
    assert.deepEqual(
      summarize(failures),
      ["api rejected_by_api 400 false TMP-0042", "api rejected_by_api 400 false GH-7781", "api rejected_by_api 400 false p-2701"].sort(),
    );
  });

  it("stores the 108 loaded patients and none of the held-back ones", () => {
    assert.equal(store.patients.size, 108);
    for (const id of ["P-2506", "P-2507", "P-2508", "P-2120", "P-2220", "TMP-0042"]) {
      assert.equal(store.patients.has(id), false, `${id} should not have been loaded`);
    }
  });

  it("stores the newest version of each duplicated patient", () => {
    const email = (id: string) => store.patients.get(id)?.email;
    assert.equal(email("P-1001"), "john.doe@newemail.com");
    assert.equal(email("P-2501"), "abel.grey.new@example.com"); // newest row comes later
    assert.equal(email("P-2502"), "beth.hart.new@example.com"); // newest row comes first
    assert.equal(email("P-2503"), "carl.ivers.v3@example.com"); // three versions
    assert.equal(email("P-2504"), "dana.jules.b@example.com"); // identical timestamps: later row
    assert.equal(email("P-2505"), "eric.kane.utc@example.com"); // 06:00Z is later than 10:00+05:30
    assert.equal(store.patients.get("P-2509")?.last_modified, "2026-10-07T09:30:00Z");
  });

  it("stores normalized values", () => {
    const patient = (id: string) => store.patients.get(id);
    assert.equal(patient("P-1002")?.account_balance, 1250);
    assert.equal(patient("P-2202")?.account_balance, 1234567.89);
    assert.equal(patient("P-2206")?.account_balance, -30);
    assert.equal(patient("P-2212")?.account_balance, null);
    assert.equal(patient("P-2104")?.dob, "1988-07-04");
    assert.equal(patient("P-2109")?.dob, "1980-04-03");
    assert.equal(patient("P-2111")?.dob, "1996-02-29");
    assert.equal(patient("P-2306")?.email, null);
    assert.equal(patient("P-2308")?.email, "helen.major@example.com");
    assert.equal(patient("P-2401")?.first_name, "Mary Ann");
    assert.equal(patient("P-2403")?.last_name, "García-López");
    assert.equal(patient("P-2405")?.last_name, "Smith, Jr.");
    assert.equal(patient("P-2406")?.last_name, "Null");
    assert.equal(patient("P-2602")?.patient_id, "P-2602");
  });

  it("stays within 5 requests/second: the API never had to send a 429", () => {
    assert.equal(report.api?.batches, 2);
    assert.equal(api.statusCounts.get(429) ?? 0, 0);
    assert.ok((report.api?.retries ?? 0) > 0, "the injected 503s should have caused retries");
  });
});
