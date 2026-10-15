import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { startMockApi, type MockApi } from "../mock-api/server.ts";
import { MemoryPatientStore } from "../mock-api/store.ts";
import { silentLogger } from "../src/logger.ts";
import { runPipeline } from "../src/pipeline.ts";
import { SAMPLE_EXPECTED, fixedNow, tempDir, testSettings } from "./helpers.ts";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

describe("pipeline against the mock SHC API", () => {
  let api: MockApi | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it("loads the assignment sample after riding out transient failures", async () => {
    let request = 0;
    const firstTwoFail = () => (++request <= 2 ? 0 : 1); // the mock fails a request when random() < failureRate
    const store = new MemoryPatientStore();
    api = await startMockApi({ token: "test-token", failureRate: 0.5, random: firstTwoFail, store });
    const outputDir = await tempDir();
    const report = await runPipeline(
      testSettings({ inputFile: "data/patients.csv", outputDir, apiUrl: `${api.url}/v1/patients` }),
      { logger: silentLogger, now: fixedNow },
    );

    assert.equal(report.status, "completed");
    assert.equal(report.counts.patients_loaded, 7);
    assert.deepEqual(report.api, { batches: 1, requests: 3, retries: 2 });
    assert.equal(api.statusCounts.get(503), 2);
    assert.deepEqual([...store.patients.values()], SAMPLE_EXPECTED);
    assert.deepEqual(await readJson(join(outputDir, "failed_records.json")), []);
    assert.deepEqual(await readJson(join(outputDir, "validation_errors.json")), []);
    assert.equal(((await readJson(join(outputDir, "ingest_report.json"))) as { status: string }).status, "completed");
  });

  it("sends nothing in a dry run and writes the cleaned records for review", async () => {
    api = await startMockApi({ token: "test-token" });
    const outputDir = await tempDir();
    const report = await runPipeline(
      testSettings({ inputFile: "data/patients.csv", outputDir, apiUrl: `${api.url}/v1/patients`, dryRun: true, apiToken: null }),
      { logger: silentLogger, now: fixedNow },
    );

    assert.equal(report.status, "completed");
    assert.equal(api.statusCounts.size, 0);
    assert.deepEqual(await readJson(join(outputDir, "cleaned_records.json")), SAMPLE_EXPECTED);
  });

  it("stops on bad credentials, logs the unsent records as retryable, and still writes the report", async () => {
    api = await startMockApi({ token: "the-real-token" });
    const outputDir = await tempDir();
    const report = await runPipeline(
      testSettings({ inputFile: "data/patients.csv", outputDir, apiUrl: `${api.url}/v1/patients`, apiToken: "wrong-token" }),
      { logger: silentLogger, now: fixedNow },
    );

    assert.equal(report.status, "aborted");
    assert.match(report.error ?? "", /HTTP 401/);
    assert.equal(api.statusCounts.get(401), 1);
    const failed = (await readJson(join(outputDir, "failed_records.json"))) as Array<{ reason: string; status_code: number }>;
    assert.deepEqual(failed.map((entry) => `${entry.reason} ${entry.status_code}`), Array(7).fill("not_attempted 503"));
    assert.equal(report.counts.patients_not_attempted, 7);
    assert.equal(((await readJson(join(outputDir, "ingest_report.json"))) as { status: string }).status, "aborted");
  });

  it("reports an unreadable input file as an aborted run", async () => {
    const outputDir = await tempDir();
    const report = await runPipeline(testSettings({ inputFile: "data/missing.csv", outputDir }), { logger: silentLogger, now: fixedNow });
    assert.equal(report.status, "aborted");
    assert.match(report.error ?? "", /input file not found/);
  });
});
