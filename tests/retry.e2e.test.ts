import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { startMockApi, type MockApi } from "../mock-api/server.ts";
import { MemoryPatientStore } from "../mock-api/store.ts";
import { silentLogger } from "../src/logger.ts";
import { runPipeline } from "../src/pipeline.ts";
import { runRetry } from "../src/retry.ts";
import type { FailureEntry } from "../src/types.ts";
import { cleanRecord, fixedNow, tempDir, testSettings } from "./helpers.ts";

const readFailures = async (dir: string) =>
  JSON.parse(await readFile(join(dir, "failed_records.json"), "utf8")) as FailureEntry[];

function apiEntry(patientId: string, reason: FailureEntry["reason"], statusCode: number): FailureEntry {
  return {
    stage: "api",
    reason,
    status_code: statusCode,
    retryable: statusCode >= 500,
    patient_id: patientId,
    source_lines: [2],
    http_status: statusCode === 500 ? null : statusCode,
    detail: "earlier failure",
    batch: "batch 1/1",
    record: cleanRecord(patientId).payload,
    logged_at: "2026-10-13T12:00:00.000Z",
  };
}

/** A reviewed failure file at its own fixed place, and an empty output folder. */
async function reviewed(entries: FailureEntry[] | string) {
  const retryFile = join(await tempDir(), "failed_records.json");
  await writeFile(retryFile, typeof entries === "string" ? entries : JSON.stringify(entries));
  return { retryFile, outputDir: await tempDir() };
}

describe("--retry", () => {
  let api: MockApi | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it("loads the records a network outage kept out, once a person copies the reviewed file into place", async () => {
    const outputDir = await tempDir();
    // Port 9 refuses connections: every request fails with a network error.
    const down = await runPipeline(
      testSettings({ inputFile: "data/patients.csv", outputDir, apiUrl: "http://127.0.0.1:9/v1/patients", maxRetries: 1 }),
      { logger: silentLogger, now: fixedNow },
    );
    assert.equal(down.status, "completed_with_failures");
    const failures = await readFailures(outputDir);
    assert.deepEqual(new Set(failures.map((entry) => `${entry.reason} ${entry.status_code} ${entry.retryable}`)), new Set(["network_error 500 true"]));
    assert.equal(failures.length, 7);

    // The manual step: review output/failed_records.json, copy it to the retry location.
    const retryFile = join(await tempDir(), "failed_records.json");
    await copyFile(join(outputDir, "failed_records.json"), retryFile);

    const store = new MemoryPatientStore();
    api = await startMockApi({ token: "test-token", store });
    const report = await runRetry(testSettings({ retryFile, outputDir, apiUrl: `${api.url}/v1/patients` }), { logger: silentLogger, now: fixedNow });

    assert.equal(report.status, "completed");
    assert.deepEqual(report.counts, { entries_read: 7, retried: 7, loaded: 7, still_failing: 0, kept_not_retryable: 0 });
    assert.equal(store.patients.size, 7);
    assert.deepEqual(await readFailures(outputDir), []); // nothing is left to load
    assert.deepEqual(JSON.parse(await readFile(retryFile, "utf8")), [], "loaded records are removed from the failure file");
  });

  it("works on the demo file data/samples/failed_records.json: 5 load, 2 kept as 4xx, 1 refused when resent", async () => {
    const { outputDir } = await reviewed("[]");
    const retryFile = join(await tempDir(), "failed_records.json");
    await copyFile("data/samples/failed_records.json", retryFile);
    const store = new MemoryPatientStore();
    api = await startMockApi({ token: "test-token", store });
    const report = await runRetry(testSettings({ retryFile, outputDir, apiUrl: `${api.url}/v1/patients` }), { logger: silentLogger, now: fixedNow });

    assert.equal(report.status, "completed_with_failures");
    assert.deepEqual(report.counts, { entries_read: 8, retried: 6, loaded: 5, still_failing: 1, kept_not_retryable: 2 });
    assert.deepEqual([...store.patients.keys()].sort(), ["P-3001", "P-3002", "P-3003", "P-3004", "P-3005"]);
    assert.deepEqual(
      (await readFailures(outputDir)).map((entry) => `${entry.patient_id} ${entry.reason} ${entry.status_code}`),
      ["TMP-0042 rejected_by_api 400", "GH-7781 rejected_by_api 400", "X-0099 rejected_by_api 400"],
    );
  });

  it("keeps 4xx entries untouched and logs a retried record again if it still fails", async () => {
    const { retryFile, outputDir } = await reviewed([
      apiEntry("TMP-0001", "rejected_by_api", 400), // data problem: not resent
      apiEntry("P-3001", "network_error", 500), // fine now
      apiEntry("BAD-ID", "api_timeout", 504), // resent, but the API refuses its ID
    ]);
    const store = new MemoryPatientStore();
    api = await startMockApi({ token: "test-token", store });
    const report = await runRetry(testSettings({ retryFile, outputDir, apiUrl: `${api.url}/v1/patients` }), { logger: silentLogger, now: fixedNow });

    assert.equal(report.status, "completed_with_failures");
    assert.deepEqual(report.counts, { entries_read: 3, retried: 2, loaded: 1, still_failing: 1, kept_not_retryable: 1 });
    assert.deepEqual([...store.patients.keys()], ["P-3001"]);
    assert.deepEqual(
      (await readFailures(outputDir)).map((entry) => [entry.patient_id, entry.reason, entry.status_code, entry.logged_at === "2026-10-13T12:00:00.000Z"]),
      [["TMP-0001", "rejected_by_api", 400, true], ["BAD-ID", "rejected_by_api", 400, false]],
    );
  });

  it("removes loaded records from the failure file, so running it again resends only what still failed", async () => {
    const { retryFile, outputDir } = await reviewed([
      apiEntry("P-3001", "network_error", 500),
      apiEntry("BAD-ID", "api_timeout", 504), // refused when resent: becomes a 400
      apiEntry("TMP-0001", "rejected_by_api", 400),
    ]);
    api = await startMockApi({ token: "test-token" });
    const settings = testSettings({ retryFile, outputDir, apiUrl: `${api.url}/v1/patients` });
    await runRetry(settings, { logger: silentLogger, now: fixedNow });

    const ids = async (path: string) => (JSON.parse(await readFile(path, "utf8")) as FailureEntry[]).map((entry) => entry.patient_id);
    assert.deepEqual(await ids(retryFile), ["TMP-0001", "BAD-ID"]); // P-3001 loaded and was removed
    assert.deepEqual(await ids(join(outputDir, "failed_records.json")), ["TMP-0001", "BAD-ID"]);

    const again = await runRetry(settings, { logger: silentLogger, now: fixedNow });
    assert.equal(again.counts.retried, 0, "only 4xx records are left, so nothing is resent");
    assert.equal(api.statusCounts.get(200), 1);
  });

  it("keeps every record in the result when the retry itself is stopped", async () => {
    const { retryFile, outputDir } = await reviewed([apiEntry("P-3001", "network_error", 500)]);
    api = await startMockApi({ token: "the-real-token" });
    const report = await runRetry(
      testSettings({ retryFile, outputDir, apiUrl: `${api.url}/v1/patients`, apiToken: "wrong-token" }),
      { logger: silentLogger, now: fixedNow },
    );
    assert.equal(report.status, "aborted");
    assert.match(report.error ?? "", /HTTP 401/);
    assert.deepEqual((await readFailures(outputDir)).map((entry) => [entry.patient_id, entry.reason, entry.status_code]), [["P-3001", "not_attempted", 503]]);
  });

  it("explains the manual step when nothing has been put in data/retry/ yet", async () => {
    const retryFile = join(await tempDir(), "failed_records.json");
    const report = await runRetry(testSettings({ retryFile, outputDir: await tempDir() }), { logger: silentLogger, now: fixedNow });
    assert.equal(report.status, "aborted");
    assert.match(report.error ?? "", /retry file not found: .*Put the reviewed failed_records.json there, named exactly "failed_records.json"/);
  });
});
