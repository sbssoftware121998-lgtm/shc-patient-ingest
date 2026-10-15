import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { csvCell } from "../src/error-csv.ts";
import { extractRows } from "../src/extract.ts";
import { silentLogger } from "../src/logger.ts";
import { runPipeline, type RunReport } from "../src/pipeline.ts";
import type { FailureEntry } from "../src/types.ts";
import { fixedNow, tempDir, testSettings } from "./helpers.ts";

const validate = async (inputFile: string, outputDir: string) =>
  runPipeline(testSettings({ inputFile, outputDir, dryRun: true, apiToken: null }), { logger: silentLogger, now: fixedNow });

describe("data_correction.csv", () => {
  let outputDir: string;
  let csvPath: string;
  let report: RunReport;

  before(async () => {
    outputDir = await tempDir();
    report = await validate("data/patients_extended.csv", outputDir);
    csvPath = join(outputDir, "data_correction.csv");
  });

  it("is written by a validation-only run, one row per source row of each held-back record", async () => {
    assert.equal(report.outputs.data_correction_csv, "data_correction.csv");
    const invalid = JSON.parse(await readFile(join(outputDir, "validation_errors.json"), "utf8")) as FailureEntry[];
    const { rows, rejected } = await extractRows(csvPath);
    const sourceRows = invalid.reduce((sum, entry) => sum + (entry.source_rows?.length ?? 0), 0);
    assert.equal(rows.length + rejected.length, sourceRows);
    assert.equal(rejected.length, 0, "every row of the error file must be readable by the ingest");
  });

  it("keeps the export's columns and values, then explains each error", async () => {
    const text = await readFile(csvPath, "utf8");
    const [header] = text.replace(/^\uFEFF/, "").split("\n");
    assert.equal(
      header,
      "patient_id,first_name,last_name,dob,email,phone,account_balance,last_modified,error_status_code,error_reason,errors,input_line,input_row",
    );
    const { rows } = await extractRows(csvPath);
    const faye = rows.find((row) => row.values.patient_id === "P-2506" && row.values.dob === "02/30/1984");
    assert.ok(faye, "the invalid newest version of P-2506 is in the file with its original values");
    assert.match(text, /P-2225,,,,,,,,400,malformed_row,.*,114,"P-2225,Xena,Park/); // unsplittable row: raw text kept
  });

  it("can be corrected and loaded again: fixed rows pass, the rest are reported again", async () => {
    const text = await readFile(csvPath, "utf8");
    // Fix P-2506's newest version (02/30 is not a date).
    const fixedPath = join(await tempDir(), "fixed.csv");
    await writeFile(fixedPath, text.replace("P-2506,Faye,Lowe,02/30/1984", "P-2506,Faye,Lowe,02/28/1984"));

    const rerunDir = await tempDir();
    const rerun = await validate(fixedPath, rerunDir);
    const cleaned = JSON.parse(await readFile(join(rerunDir, "cleaned_records.json"), "utf8")) as Array<{ patient_id: string; email: string }>;
    assert.deepEqual(cleaned.map((record) => [record.patient_id, record.email]), [["P-2506", "faye.lowe.new@example.com"]]);
    assert.equal(rerun.counts.patients_valid, 1);
  });

  it("is removed when a later run has no validation errors, so it is never stale", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "data_correction.csv"), "stale");
    await validate("data/patients.csv", dir);
    await assert.rejects(readFile(join(dir, "data_correction.csv")), { code: "ENOENT" });
  });

  it("quotes cells only when needed", () => {
    assert.equal(csvCell("plain"), "plain");
    assert.equal(csvCell("1,250.00"), '"1,250.00"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell(" padded"), '" padded"');
  });
});
