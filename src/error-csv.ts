import { rm, writeFile } from "node:fs/promises";
import { REQUIRED_COLUMNS, type FailureEntry } from "./types.ts";

/** Columns appended after the export's own columns. The ingest ignores them on re-import. */
export const ERROR_COLUMNS = ["error_status_code", "error_reason", "errors", "input_line", "input_row"] as const;

/**
 * Writes the records held back by validation as a CSV in the export's own layout, so they can be
 * corrected in a spreadsheet and loaded straight back in (copy output/data_correction.csv over data/input/patients.csv):
 *  - one row per source row, so a patient with several versions gets them all and deduplication
 *    works again on re-import;
 *  - the error columns at the end say what is wrong; they can be left in place;
 *  - a row that could not be split into columns (malformed_row) has only its patient_id filled
 *    in and its original text in input_row, to be re-typed into the columns.
 * With no validation errors, any stale file from an earlier run is removed.
 */
export async function writeErrorCsv(path: string, entries: readonly FailureEntry[]): Promise<void> {
  if (entries.length === 0) {
    await rm(path, { force: true });
    return;
  }
  const lines = [[...REQUIRED_COLUMNS, ...ERROR_COLUMNS].join(",")];
  for (const entry of entries) {
    for (const row of entry.source_rows ?? []) {
      // An unsplittable row still gets its patient_id (when known), so it is easy to find.
      const values = REQUIRED_COLUMNS.map((column) =>
        row.values ? (row.values[column] ?? "") : column === "patient_id" ? (entry.patient_id ?? "") : "",
      );
      const errors = [String(entry.status_code), entry.reason, (entry.errors ?? []).join("; "), String(row.line), row.raw ?? ""];
      lines.push([...values, ...errors].map(csvCell).join(","));
    }
  }
  // The byte-order mark makes Excel read the file as UTF-8 (names like García-López); the ingest skips it.
  await writeFile(path, `\uFEFF${lines.join("\n")}\n`, "utf8");
}

export function csvCell(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
