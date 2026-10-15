import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CsvError, parse } from "csv-parse";
import { FieldError, parseMoney } from "./normalize.ts";
import { REQUIRED_COLUMNS, errorMessage, type Column, type Issue, type Rejection, type SourceRow } from "./types.ts";

/** The input file as a whole cannot be processed (missing, wrong encoding, unusable header...). */
export class InputError extends Error {
  override name = "InputError";
}

export interface ExtractResult {
  rows: SourceRow[];
  rejected: Rejection[];
  issues: Issue[];
  /** Non-blank data rows in the file, including the ones that were rejected. */
  rowsRead: number;
}

interface ParsedRecord {
  record: string[];
  info: { lines: number };
  raw: string;
}

/**
 * The input must exist under exactly its expected name. macOS and Windows match file names
 * ignoring case, so "Patients.CSV" would otherwise be read in place of "patients.csv"; a
 * person should rename it knowingly instead.
 */
export async function checkInputFile(path: string, label = "input file", contents = "the export"): Promise<void> {
  const folder = dirname(path);
  const name = basename(path);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    throw new InputError(`${label} not found: the folder ${folder} does not exist. Create it and put ${contents} there as ${name}`);
  }
  if (names.includes(name)) return;
  const sameIgnoringCase = names.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (sameIgnoringCase) {
    throw new InputError(`${label} not found: ${path}. Found "${sameIgnoringCase}" instead: rename it to exactly "${name}"`);
  }
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const others = names.filter((candidate) => candidate.toLowerCase().endsWith(extension));
  throw new InputError(
    `${label} not found: ${path}. Put ${contents} there, named exactly "${name}"` +
      (others.length > 0 ? ` (that folder has: ${others.join(", ")})` : ""),
  );
}

/**
 * Streams the CSV export into trimmed rows keyed by column. A row that is structurally
 * broken becomes a rejection (with its line number and raw text) instead of stopping the
 * run; only problems that make the rest of the file unreadable are fatal.
 */
export async function extractRows(path: string, encoding = "utf-8"): Promise<ExtractResult> {
  const result: ExtractResult = { rows: [], rejected: [], issues: [], rowsRead: 0 };
  let header: string[] | undefined;
  let lastLine = 0;
  let unclosedQuote = false;

  const parser = parse({
    bom: true,
    info: true,
    raw: true,
    relax_column_count: true, // rows with the wrong field count are repaired or rejected below
    relax_quotes: true,
    skip_empty_lines: true,
    skip_records_with_error: true,
    on_skip: (error, raw) => {
      if (error?.code === "CSV_QUOTE_NOT_CLOSED") {
        unclosedQuote = true;
        return;
      }
      result.rowsRead += 1;
      result.rejected.push({
        reason: "malformed_row",
        patientId: null,
        errors: [`CSV syntax error: ${error?.message ?? "unknown"}`],
        rows: [{ line: lastLine + 1, raw: raw?.trimEnd() ?? "" }],
      });
    },
  });

  // When the consumer below throws, pipeline() can reject with its own AbortError instead,
  // so remember the original error to report the real cause.
  let consumerError: unknown;
  try {
    await pipeline(createReadStream(path), decodeText(encoding), parser, async (records: AsyncIterable<ParsedRecord>) => {
      try {
        for await (const { record, info, raw } of records) {
          lastLine = info.lines;
          if (!header) {
            header = readHeader(record);
            continue;
          }
          if (record.every((cell) => cell.trim() === "")) continue;
          result.rowsRead += 1;
          addRow(result, header, record, info.lines, raw);
        }
      } catch (error) {
        consumerError = error;
        throw error;
      }
    });
  } catch (error) {
    throw toInputError(consumerError ?? error, path, encoding);
  }

  if (!header) throw new InputError("input file is empty");
  if (unclosedQuote) {
    // Everything after an unbalanced quote is swallowed into one field, so skipping it would
    // silently drop every following patient.
    throw new InputError(
      `a quoted field starting after line ${lastLine} is never closed, so the rest of the file cannot be read reliably; fix the export and re-run`,
    );
  }
  return result;
}

function readHeader(cells: string[]): string[] {
  const header = cells.map((cell) => cell.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) throw new InputError(`input is missing required column(s): ${missing.join(", ")}`);
  const duplicated = header.filter((name, index) => name !== "" && header.indexOf(name) !== index);
  if (duplicated.length > 0) {
    throw new InputError(`input has duplicate column(s): ${[...new Set(duplicated)].join(", ")}`);
  }
  return header;
}

function addRow(result: ExtractResult, header: string[], cells: string[], line: number, raw: string): void {
  let aligned: string[];
  try {
    aligned = alignToHeader(cells, header);
  } catch (error) {
    result.rejected.push({
      reason: "malformed_row",
      patientId: cells[header.indexOf("patient_id")]?.trim() || null,
      errors: [errorMessage(error)],
      rows: [{ line, raw: raw.trimEnd() }],
    });
    return;
  }

  const values = Object.fromEntries(
    REQUIRED_COLUMNS.map((column) => [column, (aligned[header.indexOf(column)] ?? "").trim()]),
  ) as Record<Column, string>;

  if (aligned !== cells) {
    result.issues.push({
      code: "row_repaired",
      line,
      patientId: values.patient_id || null,
      detail: `account_balance had an unquoted thousands separator that split it across ${cells.length - header.length + 1} fields; re-joined as "${values.account_balance}"`,
    });
  }
  result.rows.push({ line, values });
}

/**
 * The export does not quote numbers, so a balance like 1,250.00 arrives split across two
 * fields and every later column shifts right. account_balance is the only column whose
 * values legitimately contain commas, so when a row has too many fields we re-join the
 * surplus into that column, but only if the result is a well-formed amount. Anything else
 * is rejected rather than guessed at.
 *
 * Returns the original array when no repair was needed.
 */
export function alignToHeader(cells: string[], header: string[]): string[] {
  const surplus = cells.length - header.length;
  if (surplus === 0) return cells;
  if (surplus < 0) throw new FieldError(`row has ${cells.length} fields but the header has ${header.length}`);

  const at = header.indexOf("account_balance");
  const joined = cells
    .slice(at, at + surplus + 1)
    .map((cell) => cell.trim())
    .join(",");
  try {
    parseMoney(joined); // only accepts commas that are correctly placed thousands separators
  } catch {
    throw new FieldError(
      `row has ${cells.length} fields but the header has ${header.length}, and the extra commas are not thousands separators in account_balance`,
    );
  }
  return [...cells.slice(0, at), joined, ...cells.slice(at + surplus + 1)];
}

/** Decodes bytes with any WHATWG encoding (utf-8, windows-1252, ...) and fails on invalid input instead of inserting replacement characters. */
function decodeText(encoding: string): Transform {
  const decoder = new TextDecoder(encoding, { fatal: true });
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        callback(null, decoder.decode(chunk, { stream: true }));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        callback(null, decoder.decode());
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

function toInputError(error: unknown, path: string, encoding: string): Error {
  if (error instanceof InputError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return new InputError(`input file not found: ${path}`);
  if (code === "EACCES" || code === "EISDIR") return new InputError(`input file cannot be read (${code}): ${path}`);
  if (code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
    return new InputError(`input is not valid ${encoding}; set SHC_INPUT_ENCODING to the export's encoding (e.g. windows-1252)`);
  }
  if (error instanceof CsvError) return new InputError(`input could not be parsed as CSV: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}
