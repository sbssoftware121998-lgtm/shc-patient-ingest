import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InputError, extractRows } from "../src/extract.ts";
import { HEADER, tempDir, writeCsv } from "./helpers.ts";

const ROW = "P-1001,John,Doe,1980-05-15,john@example.com,555-0100,$10.00,2026-10-01T00:00:00Z";

describe("extractRows", () => {
  it("re-joins an unquoted thousands separator (P-1002 in the sample)", async () => {
    const result = await extractRows("data/patients.csv");
    const row = result.rows.find((r) => r.values.patient_id === "P-1002");
    assert.equal(row?.values.account_balance, "1,250.00");
    assert.equal(row?.values.last_modified, "2026-10-02T11:30:00Z");
    assert.deepEqual(result.issues.map((issue) => [issue.code, issue.line]), [["row_repaired", 3]]);
    assert.equal(result.rowsRead, 9);
    assert.equal(result.rejected.length, 0);
  });

  it("re-joins balances split across more than two fields", async () => {
    const dir = await tempDir();
    const path = await writeCsv(dir, [HEADER, "P-1,A,B,1980-01-01,a@b.co,555,$1,234,567.89,2026-10-01T00:00:00Z"]);
    const { rows } = await extractRows(path);
    assert.equal(rows[0]?.values.account_balance, "$1,234,567.89");
  });

  it("rejects a row whose extra comma is not a thousands separator, with its raw text", async () => {
    const dir = await tempDir();
    const broken = "P-2,A,B,1980-01-01,a@b.co,555,12,34,2026-10-01T00:00:00Z";
    const path = await writeCsv(dir, [HEADER, broken, ROW]);
    const result = await extractRows(path);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rejected, [
      {
        reason: "malformed_row",
        patientId: "P-2",
        errors: ["row has 9 fields but the header has 8, and the extra commas are not thousands separators in account_balance"],
        rows: [{ line: 2, raw: broken }],
      },
    ]);
  });

  it("rejects rows with too few fields and keeps going", async () => {
    const dir = await tempDir();
    const path = await writeCsv(dir, [HEADER, "P-3,Short,Row", ROW]);
    const result = await extractRows(path);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rejected[0]?.errors[0], "row has 3 fields but the header has 8");
  });

  it("skips blank lines and reports real line numbers", async () => {
    const dir = await tempDir();
    const path = await writeCsv(dir, [HEADER, "", ROW, ",,,,,,,"]);
    const result = await extractRows(path);
    assert.deepEqual(result.rows.map((row) => row.line), [3]);
    assert.equal(result.rowsRead, 1);
  });

  it("handles a byte-order mark, Windows line endings and quoted commas", async () => {
    const dir = await tempDir();
    const path = join(dir, "excel.csv");
    await writeFile(path, `﻿${HEADER}\r\nP-4,Robert,"Smith, Jr.",1961-05-20,,,"2,450.75",2026-10-01T00:00:00Z\r\n`);
    const { rows } = await extractRows(path);
    assert.equal(rows[0]?.values.patient_id, "P-4");
    assert.equal(rows[0]?.values.last_name, "Smith, Jr.");
    assert.equal(rows[0]?.values.account_balance, "2,450.75");
  });

  it("maps columns by name, so order changes and extra columns are harmless", async () => {
    const dir = await tempDir();
    const path = await writeCsv(dir, [
      "last_modified,notes,patient_id,first_name,last_name,dob,email,phone,account_balance",
      "2026-10-01T00:00:00Z,VIP,P-5,Ann,Lee,1980-01-01,ann@example.com,555,1,000.00",
    ]);
    const { rows } = await extractRows(path);
    assert.equal(rows[0]?.values.patient_id, "P-5");
    assert.equal(rows[0]?.values.account_balance, "1,000.00");
  });

  it("decodes a windows-1252 export when told to", async () => {
    const dir = await tempDir();
    const path = join(dir, "legacy.csv");
    // 0x80 is the euro sign in windows-1252 (and an invalid byte in UTF-8).
    await writeFile(path, Buffer.concat([Buffer.from(`${HEADER}\nP-6,A,B,1980-01-01,,,`), Buffer.from([0x80]), Buffer.from("300.00,2026-10-01T00:00:00Z\n")]));
    const { rows } = await extractRows(path, "windows-1252");
    assert.equal(rows[0]?.values.account_balance, "€300.00");
    await assert.rejects(extractRows(path, "utf-8"), (error: Error) => error instanceof InputError && /not valid utf-8/.test(error.message));
  });

  it("stops when a quote is never closed, instead of silently swallowing the rest of the file", async () => {
    const dir = await tempDir();
    const path = await writeCsv(dir, [HEADER, ROW, 'P-7,"Unclosed,B,1980-01-01,,,$1.00,2026-10-01T00:00:00Z', ROW]);
    await assert.rejects(extractRows(path), (error: Error) => error instanceof InputError && /starting after line 2 is never closed/.test(error.message));
  });

  it("requires the expected columns", async () => {
    const dir = await tempDir();
    const path = await writeCsv(dir, ["patient_id,first_name,last_name,email,phone,account_balance,last_modified", ROW]);
    await assert.rejects(extractRows(path), /missing required column\(s\): dob/);
  });

  it("reports a missing file clearly", async () => {
    await assert.rejects(extractRows("data/does-not-exist.csv"), /input file not found/);
  });
});
