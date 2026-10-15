import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPretty } from "../src/logger.ts";
import { silentLogger } from "../src/logger.ts";
import { runPipeline } from "../src/pipeline.ts";
import { displayPath, renderConfigError, renderRunSummary, type Invocation } from "../src/summary.ts";
import { fixedNow, tempDir, testSettings } from "./helpers.ts";

const npm: Invocation = { cwd: "/project", command: (command, force) => `npm run ${command}${force ? " -- --force" : ""}` };

describe("terminal messages", () => {
  it("formats a log line for a person", () => {
    const line = formatPretty(new Date(2026, 9, 14, 14, 20, 1), "warn", "record rejected by the API", {
      patient_id: "p-2701",
      status: 400,
      errors: ["dob is missing"],
    });
    assert.equal(line, '14:20:01  WARN   record rejected by the API  patient_id=p-2701 status=400 errors=["dob is missing"]');
  });

  it("shows paths as they would be typed", () => {
    assert.equal(displayPath("output/x.json", "/project"), "output/x.json");
    assert.equal(displayPath("/project/output/x.json", "/project"), "output/x.json");
    assert.equal(displayPath("/data/output/x.json", "/data/input"), "/data/output/x.json");
  });

  it("explains a missing token and how to fix it", () => {
    const text = renderConfigError("SHC_API_TOKEN or SHC_API_TOKEN_FILE is required (or set SHC_DRY_RUN=true)", npm);
    assert.match(text, /cp \.env\.example \.env/);
    assert.match(text, /Nothing was read or sent/);
  });

  it("after a run, says what failed and which commands to run next, retry first", async () => {
    const outputDir = await tempDir();
    // Port 9 refuses connections, so every valid patient ends up retryable.
    const settings = testSettings({ inputFile: "data/patients_extended.csv", outputDir, maxRetries: 0, maxConsecutiveFailedBatches: 5 });
    const report = await runPipeline(settings, { logger: silentLogger, now: fixedNow });
    const text = await renderRunSummary(report, settings, 2, { cwd: outputDir, command: npm.command });

    assert.match(text, /RESULT: Finished, but some records were not loaded {3}\(exit code 2\)/);
    assert.match(text, /✗ 22 held back by validation/);
    assert.match(text, /400 malformed_row ×2 · 404 missing_patient_id ×1 · 409 unresolvable_duplicate ×1 · 422 invalid_record ×18/);
    assert.match(text, /↻ 111 not delivered/);
    assert.match(text, /500 network_error ×111/);
    // Retrying is a manual, reviewed step with a fixed file location.
    assert.match(text, /1\. review the 111 undelivered record\(s\) in failed_records\.json/);
    assert.match(text, /2\. when you are sure they should be resent, copy that file to .*data\/retry\/failed_records\.json \(exactly that name\)/);
    assert.match(text, /3\. resend them: {2}npm run failed/);
    assert.match(text, /4\. correct the rows in data_correction\.csv and save it/);
    assert.match(text, /5\. copy it over .*patients_extended\.csv \(keep the original export somewhere else first\)/);
    assert.match(text, /6\. check it: {2}npm run validation {5}then load it: {2}npm run success$/m);
  });
});
