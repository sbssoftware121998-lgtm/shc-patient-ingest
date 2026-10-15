import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractRows } from "../src/extract.ts";
import { transform } from "../src/transform.ts";
import type { Column, SourceRow } from "../src/types.ts";
import { SAMPLE_EXPECTED, TODAY } from "./helpers.ts";

function row(line: number, values: Partial<Record<Column, string>> = {}): SourceRow {
  return {
    line,
    values: {
      patient_id: "P-1",
      first_name: "Ann",
      last_name: "Lee",
      dob: "1980-01-01",
      email: "ann@example.com",
      phone: "555-0001",
      account_balance: "$1.00",
      last_modified: "2026-10-01T00:00:00Z",
      ...values,
    },
  };
}

const run = (rows: SourceRow[]) => transform(rows, { today: TODAY });

describe("transform", () => {
  it("turns the assignment sample into the expected records", async () => {
    const { rows } = await extractRows("data/patients.csv");
    const result = run(rows);
    assert.deepEqual(result.records.map((record) => record.payload), SAMPLE_EXPECTED);
    assert.deepEqual(result.rejected, []);
    assert.equal(result.supersededRows, 2);
    assert.deepEqual(result.dobFormats, { "YYYY-MM-DD": 3, "MM/DD/YYYY": 2, "DD-MM-YYYY": 2 });
  });

  it("keeps the most recently modified version, wherever it appears in the file", () => {
    const result = run([
      row(2, { email: "new@example.com", last_modified: "2026-10-03T00:00:00Z" }),
      row(3, { email: "old@example.com", last_modified: "2026-09-01T00:00:00Z" }),
    ]);
    assert.equal(result.records[0]?.payload.email, "new@example.com");
    assert.deepEqual(result.issues.map((issue) => [issue.code, issue.line]), [["duplicate_superseded", 3]]);
  });

  it("compares timestamps as instants, not as text", () => {
    const result = run([
      row(2, { email: "ist@example.com", last_modified: "2026-10-05T10:00:00+05:30" }), // 04:30 UTC
      row(3, { email: "utc@example.com", last_modified: "2026-10-05T06:00:00Z" }),
    ]);
    assert.equal(result.records[0]?.payload.email, "utc@example.com");
  });

  it("breaks a timestamp tie in favour of the later row, and flags it", () => {
    const result = run([row(2, { email: "first@example.com" }), row(3, { email: "second@example.com" })]);
    assert.equal(result.records[0]?.payload.email, "second@example.com");
    assert.ok(result.issues.some((issue) => issue.code === "duplicate_timestamp_tie"));
  });

  it("holds a patient back when the newest version is invalid, rather than loading an older one", () => {
    const result = run([
      row(2, { last_modified: "2026-09-01T00:00:00Z" }),
      row(3, { dob: "02/30/1985", last_modified: "2026-10-01T00:00:00Z" }),
    ]);
    assert.deepEqual(result.records, []);
    assert.equal(result.rejected[0]?.reason, "invalid_record");
    assert.deepEqual(result.rejected[0]?.rows.map((r) => r.line), [2, 3]);
    assert.match(result.rejected[0]?.errors.join(" ") ?? "", /older versions were not loaded in its place/);
  });

  it("holds a patient back when it cannot tell which version is current", () => {
    const result = run([row(2), row(3, { last_modified: "yesterday" })]);
    assert.deepEqual(result.records, []);
    assert.equal(result.rejected[0]?.reason, "unresolvable_duplicate");
  });

  it("lists every problem with a record, not just the first", () => {
    const result = run([row(2, { first_name: " ", dob: "13/01/1990", account_balance: "abc" })]);
    assert.deepEqual(result.rejected[0]?.errors, [
      "first_name is missing",
      "dob is not a real calendar date when read as MM/DD/YYYY",
      "account_balance is not a number",
    ]);
  });

  it("sends blank contact details and balances as null, never as empty strings or 0", () => {
    const result = run([row(2, { email: "", phone: "", account_balance: "" })]);
    const payload = result.records[0]?.payload;
    assert.equal(payload?.email, null);
    assert.equal(payload?.phone, null);
    assert.equal(payload?.account_balance, null);
    assert.deepEqual(result.issues.map((issue) => issue.code).sort(), ["missing_account_balance", "missing_email", "missing_phone"]);
  });

  it("drops an invalid email to null but still loads the patient", () => {
    const result = run([row(2, { email: "fiona.grant@" })]);
    assert.equal(result.records[0]?.payload.email, null);
    assert.equal(result.issues[0]?.code, "invalid_email_dropped");
  });

  it("flags non-dollar currencies without converting them", () => {
    const result = run([row(2, { account_balance: "€300.00" })]);
    assert.equal(result.records[0]?.payload.account_balance, 300);
    assert.equal(result.issues[0]?.code, "non_default_currency");
  });

  it("rejects rows without a patient_id", () => {
    const result = run([row(2, { patient_id: "" })]);
    assert.equal(result.rejected[0]?.reason, "missing_patient_id");
  });
});
