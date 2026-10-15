import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RunReport, RunStatus } from "./pipeline.ts";

/**
 * The input files already processed, so the same export is not loaded twice by accident into the
 * same API. Entries are per API URL: a file loaded through Docker has not been loaded locally. A file is identified by a SHA-256 of its content, not by its name:
 * the input always has the same name, and a corrected or newer file is different content.
 * Delete this file (or run with --force) to process a file again.
 */
export const PROCESSED_FILES = "processed_files.json";

interface ProcessedBase {
  sha256: string;
  /** The API the file was loaded into. */
  api_url: string;
  size_bytes: number;
  processed_at: string;
  run_id: string;
  status: RunStatus;
}

/** A load of data/input/patients.csv. */
export interface ProcessedInput extends ProcessedBase {
  kind: "ingest";
  counts: {
    rows_read: number;
    patients_found: number;
    patients_valid: number;
    patients_loaded: number;
    held_back_by_validation: number;
    rejected_by_api: number;
    /** Valid patients the API never received (network errors, outage): resend with --retry. */
    not_delivered: number;
  };
}

export type ProcessedFile = ProcessedInput;

export interface Fingerprint {
  sha256: string;
  sizeBytes: number;
}

export async function fingerprint(path: string): Promise<Fingerprint> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  await pipeline(createReadStream(path), async (chunks: AsyncIterable<Buffer>) => {
    for await (const chunk of chunks) {
      sizeBytes += chunk.length;
      hash.update(chunk);
    }
  });
  return { sha256: hash.digest("hex"), sizeBytes };
}

/** The most recent load of this exact content into this API, if any. */
export async function findProcessed(outputDir: string, sha256: string, apiUrl: string): Promise<ProcessedFile | undefined> {
  return (await readLedger(outputDir)).findLast((entry) => entry.sha256 === sha256 && entry.api_url === apiUrl);
}

export async function recordProcessed(outputDir: string, input: Fingerprint, report: RunReport, apiUrl: string): Promise<void> {
  const { counts } = report;
  await append(outputDir, {
    kind: "ingest",
    ...base(input, report, apiUrl),
    counts: {
      rows_read: counts.rows_read,
      patients_found: counts.patients_found,
      patients_valid: counts.patients_valid,
      patients_loaded: counts.patients_loaded,
      held_back_by_validation: counts.rows_rejected + counts.patients_rejected,
      rejected_by_api: counts.patients_rejected_by_api,
      not_delivered: counts.patients_failed_after_retries + counts.patients_not_attempted,
    },
  });
}

function base(input: Fingerprint, report: RunReport, apiUrl: string): ProcessedBase {
  return {
    sha256: input.sha256,
    api_url: apiUrl,
    size_bytes: input.sizeBytes,
    processed_at: report.finished_at ?? new Date().toISOString(),
    run_id: report.run_id,
    status: report.status,
  };
}

async function append(outputDir: string, entry: ProcessedFile): Promise<void> {
  const entries = await readLedger(outputDir);
  entries.push(entry);
  // Write beside and rename over, so a crash never leaves a half-written ledger.
  const path = join(outputDir, PROCESSED_FILES);
  await writeFile(`${path}.tmp`, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  await rename(`${path}.tmp`, path);
}

async function readLedger(outputDir: string): Promise<ProcessedFile[]> {
  let text: string;
  try {
    text = await readFile(join(outputDir, PROCESSED_FILES), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) throw new Error(`${PROCESSED_FILES} must contain a JSON array`);
  // Older entries have no kind (all loads); entries of other kinds are ignored.
  return (entries as Array<Omit<ProcessedFile, "kind"> & { kind?: string }>)
    .map((entry) => ({ ...entry, kind: entry.kind ?? "ingest" }))
    .filter((entry): entry is ProcessedFile => entry.kind === "ingest");
}
