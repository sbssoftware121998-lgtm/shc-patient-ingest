import assert from "node:assert/strict";
import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { startMockApi, type MockApi } from "../mock-api/server.ts";
import { MemoryPatientStore } from "../mock-api/store.ts";
import { checkInputFile, InputError } from "../src/extract.ts";
import { silentLogger } from "../src/logger.ts";
import { runPipeline } from "../src/pipeline.ts";
import { renderRunSummary } from "../src/summary.ts";
import { fixedNow, tempDir, testSettings } from "./helpers.ts";

describe("an input that was already processed", () => {
  let api: MockApi | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  async function setup() {
    const store = new MemoryPatientStore();
    api = await startMockApi({ token: "test-token", store });
    const inputDir = await tempDir();
    const inputFile = join(inputDir, "patients.csv");
    await copyFile("data/patients.csv", inputFile);
    const settings = testSettings({ inputFile, outputDir: await tempDir(), apiUrl: `${api.url}/v1/patients` });
    const run = (overrides = {}) => runPipeline({ ...settings, ...overrides }, { logger: silentLogger, now: fixedNow });
    return { store, settings, inputFile, run };
  }

  it("is not loaded twice: the earlier run's counts are reported and output/ is left as it was", async () => {
    const { settings, run } = await setup();
    const first = await run();
    assert.equal(first.status, "completed");
    const reportBefore = await readFile(join(settings.outputDir, "ingest_report.json"), "utf8");
    const modifiedBefore = (await stat(join(settings.outputDir, "failed_records.json"))).mtimeMs;

    const second = await run();
    assert.equal(second.status, "already_processed");
    assert.equal(second.previous_run?.run_id, first.run_id);
    assert.deepEqual(second.previous_run?.counts, {
      rows_read: 9,
      patients_found: 7,
      patients_valid: 7,
      patients_loaded: 7,
      held_back_by_validation: 0,
      rejected_by_api: 0,
      not_delivered: 0,
    });
    assert.equal(api?.statusCounts.get(200), 1, "nothing was sent the second time");
    assert.equal(await readFile(join(settings.outputDir, "ingest_report.json"), "utf8"), reportBefore);
    assert.equal((await stat(join(settings.outputDir, "failed_records.json"))).mtimeMs, modifiedBefore);

    const text = await renderRunSummary(second, settings, 0, { cwd: settings.outputDir, command: (command, force) => `npm run ${command}${force ? " -- --force" : ""}` });
    assert.match(text, /Already processed/);
    assert.match(text, /9 rows read · 7 patients found · 7 valid · 7 loaded/);
    assert.match(text, /npm run success -- --force/);
  });

  it("is processed again when its content changes, or with --force", async () => {
    const { inputFile, run } = await setup();
    await run();
    await writeFile(inputFile, `${await readFile(inputFile, "utf8")}P-1008,New,Patient,1990-01-01,,,$1.00,2026-10-07T00:00:00Z\n`);
    const changed = await run();
    assert.equal(changed.status, "completed");
    assert.equal(changed.counts.patients_loaded, 8);

    assert.equal((await run()).status, "already_processed");
    assert.equal((await run({ force: true })).status, "completed");
  });

  it("does not count a validation-only run as processed", async () => {
    const { run } = await setup();
    await run({ dryRun: true, apiToken: null });
    assert.equal((await run()).status, "completed");
  });
});

describe("checkInputFile", () => {
  it("accepts the exact name only", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "Patients.CSV"), "x");
    await writeFile(join(dir, "export_october.csv"), "x");
    await assert.rejects(checkInputFile(join(dir, "patients.csv")), (error: Error) => {
      assert.ok(error instanceof InputError);
      assert.match(error.message, /Found "Patients.CSV" instead: rename it to exactly "patients.csv"/);
      return true;
    });
    await writeFile(join(dir, "patients.csv"), "x");
    if ((await readdir(dir)).includes("patients.csv")) await checkInputFile(join(dir, "patients.csv"));
  });

  it("lists the CSV files that are there when the input is missing", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "export_october.csv"), "x");
    await assert.rejects(checkInputFile(join(dir, "patients.csv")), /input file not found: .*\(that folder has: export_october\.csv\)/);
  });
});
