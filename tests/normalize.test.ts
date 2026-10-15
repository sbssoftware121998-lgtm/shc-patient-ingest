import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FieldError, cleanText, normalizeEmail, parseDob, parseMoney, parseTimestamp } from "../src/normalize.ts";
import { TODAY } from "./helpers.ts";

describe("parseDob", () => {
  const valid: Array<[raw: string, iso: string, format: string, ambiguous: boolean]> = [
    ["1980-05-15", "1980-05-15", "YYYY-MM-DD", false],
    ["12/31/1992", "1992-12-31", "MM/DD/YYYY", false],
    ["07/04/1988", "1988-07-04", "MM/DD/YYYY", true],
    ["7/4/1988", "1988-07-04", "MM/DD/YYYY", true],
    ["05/05/1990", "1990-05-05", "MM/DD/YYYY", false],
    ["25-04-1975", "1975-04-25", "DD-MM-YYYY", false],
    ["03-04-1980", "1980-04-03", "DD-MM-YYYY", true],
    ["02/29/2000", "2000-02-29", "MM/DD/YYYY", false],
    ["29-02-1996", "1996-02-29", "DD-MM-YYYY", false],
    ["1900-01-01", "1900-01-01", "YYYY-MM-DD", false],
    [" 1980-05-15 ", "1980-05-15", "YYYY-MM-DD", false],
  ];
  for (const [raw, iso, format, ambiguous] of valid) {
    it(`reads ${JSON.stringify(raw)} as ${iso}`, () => {
      assert.deepEqual(parseDob(raw, TODAY), { iso, format, ambiguous });
    });
  }

  it("gives the same answer for one date written two ways (P-1003 in the sample)", () => {
    assert.equal(parseDob("25-04-1975", TODAY).iso, parseDob("04/25/1975", TODAY).iso);
  });

  const invalid: Array<[raw: string, message: RegExp]> = [
    ["02/30/1985", /not a real calendar date when read as MM\/DD\/YYYY/],
    ["13/01/1990", /not a real calendar date when read as MM\/DD\/YYYY/], // no silent day/month swap
    ["31-04-1980", /not a real calendar date when read as DD-MM-YYYY/],
    ["02/29/1999", /not a real calendar date/],
    ["1990/05/15", /not in a supported layout/],
    ["15.05.1990", /not in a supported layout/],
    ["May 5 1990", /not in a supported layout/],
    ["2099-01-01", /in the future/],
    ["1899-12-31", /before 1900-01-01/],
  ];
  for (const [raw, message] of invalid) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.throws(() => parseDob(raw, TODAY), message);
    });
  }

  it("keeps the value out of its error message, so errors are safe to log", () => {
    assert.throws(
      () => parseDob("02/30/1985", TODAY),
      (error: Error) => error instanceof FieldError && !error.message.includes("1985"),
    );
  });
});

describe("parseMoney", () => {
  const valid: Array<[raw: string, amount: number, symbol: string | null]> = [
    ["$150.50", 150.5, "$"],
    ["0.00", 0, null],
    ["1,250.00", 1250, null],
    ["$1,234,567.89", 1234567.89, "$"],
    ["€300.00", 300, "€"],
    ["£75.25", 75.25, "£"],
    ["15.00 €", 15, "€"],
    ["$-15.00", -15, "$"],
    ["-$20.00", -20, "$"],
    ["(30.00)", -30, null],
    [" $ 45.00 ", 45, "$"],
    [".50", 0.5, null],
    ["100", 100, null],
    ["-0.00", 0, null], // no negative zero
  ];
  for (const [raw, amount, currencySymbol] of valid) {
    it(`reads ${JSON.stringify(raw)} as ${amount}`, () => {
      assert.deepEqual(parseMoney(raw), { amount, currencySymbol });
    });
  }

  for (const raw of ["abc", "12,34", "1,2345.00", "1.2.3", "N/A", "--5.00", "(-5.00)", "$€5.00", "$", "NaN", "Infinity", ""]) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.throws(() => parseMoney(raw), FieldError);
    });
  }
});

describe("parseTimestamp", () => {
  it("converts offsets to UTC", () => {
    assert.equal(parseTimestamp("2026-10-05T10:00:00+05:30").iso, "2026-10-05T04:30:00Z");
    assert.equal(parseTimestamp("2026-10-05T10:00:00+0530").iso, "2026-10-05T04:30:00Z");
    assert.equal(parseTimestamp("2026-10-05T14:20:00Z").iso, "2026-10-05T14:20:00Z");
  });

  it("assumes UTC when there is no offset, and accepts a space instead of T", () => {
    assert.equal(parseTimestamp("2026-10-07T09:30:00").iso, "2026-10-07T09:30:00Z");
    assert.equal(parseTimestamp("2026-10-08 10:00:00").iso, "2026-10-08T10:00:00Z");
  });

  it("keeps milliseconds", () => {
    assert.equal(parseTimestamp("2026-10-05T14:20:00.123Z").iso, "2026-10-05T14:20:00.123Z");
  });

  for (const raw of ["2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-05T24:00:00Z", "yesterday", "10/05/2026 14:20", "2026-10-05"]) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.throws(() => parseTimestamp(raw), FieldError);
    });
  }
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    assert.equal(normalizeEmail(" Helen.Major@Example.COM "), "helen.major@example.com");
  });

  for (const raw of ["fiona.grant@", "gavin lowe at example.com", "@example.com", "a@b"]) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.throws(() => normalizeEmail(raw), FieldError);
    });
  }
});

describe("cleanText", () => {
  it("collapses whitespace but keeps case and punctuation", () => {
    assert.equal(cleanText("  Mary   Ann "), "Mary Ann");
    assert.equal(cleanText("O'Brien"), "O'Brien");
    assert.equal(cleanText("García-López"), "García-López");
  });

  it("returns null only for blank cells, so a surname like Null survives", () => {
    assert.equal(cleanText("   "), null);
    assert.equal(cleanText("Null"), "Null");
  });
});
