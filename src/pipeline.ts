import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Clock } from "./clock.ts";
import type { Settings } from "./config.ts";
import { InputError, checkInputFile, extractRows, type ExtractResult } from "./extract.ts";
import { writeErrorCsv } from "./error-csv.ts";
import { JsonArrayFile } from "./failure-log.ts";
import { ApiUnavailableError, FatalApiError, PatientLoader, type LoadStats } from "./load.ts";
import type { Logger } from "./logger.ts";
import { findProcessed, fingerprint, recordProcessed, type ProcessedInput } from "./processed-files.ts";
import type { DateFormat } from "./normalize.ts";
import { SlidingWindowRateLimiter } from "./rate-limiter.ts";
import { transform, type TransformResult } from "./transform.ts";
import {
  FAILURE_STATUS_CODES,
  errorMessage,
  isRetryable,
  type FailureEntry,
  type IssueCode,
  type Rejection,
} from "./types.ts";

/** Records the SHC API refused or could not be reached for (stage "api"). */
export const FAILED_RECORDS_FILE = "failed_records.json";
/** Records held back before sending because the source data is wrong (stage "validation"). */
export const VALIDATION_ERRORS_FILE = "validation_errors.json";
/** The same records as a CSV in the export's layout: the data correction sheet, to fix and load again. */
export const DATA_CORRECTION_CSV = "data_correction.csv";
export const REPORT_FILE = "ingest_report.json";
export const CLEANED_RECORDS_FILE = "cleaned_records.json";

/**
 * We pace requests over a 1.1 s window rather than exactly 1 s. Requests leave at the allowed
 * rate, but network jitter can bunch them together on arrival, and the API counts arrivals.
 * Without headroom, testing at the exact limit produced occasional 429s (each costing a 1 s
 * Retry-After); 10% less throughput avoids them.
 */
const RATE_LIMIT_WINDOW_MS = 1100;

export type RunStatus = "completed" | "completed_with_failures" | "already_processed" | "aborted" | "interrupted";

export interface RunReport {
  run_id: string;
  status: RunStatus;
  error: string | null;
  dry_run: boolean;
  started_at: string;
  finished_at: string | null;
  input_file: string;
  counts: {
    rows_read: number;
    rows_repaired: number;
    rows_rejected: number;
    duplicate_rows_superseded: number;
    patients_found: number;
    patients_rejected: number;
    patients_valid: number;
    patients_loaded: number;
    patients_rejected_by_api: number;
    patients_failed_after_retries: number;
    patients_not_attempted: number;
  };
  api: { batches: number; requests: number; retries: number } | null;
  dob_formats: Partial<Record<DateFormat, number>>;
  issue_counts: Partial<Record<IssueCode, number>>;
  issues: Array<{ code: IssueCode; line: number; patient_id: string | null; detail: string }>;
  /** Set when status is already_processed: the earlier run of this exact file. */
  previous_run: ProcessedInput | null;
  outputs: {
    failed_records: string;
    validation_errors: string;
    data_correction_csv: string | null;
    cleaned_records: string | null;
  };
}

export interface PipelineDeps {
  logger: Logger;
  /** Aborting (e.g. on SIGTERM) stops the load after the in-flight request; the report is still written. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  now?: () => Date;
}

/**
 * Extract → transform → load, then write ingest_report.json. Every record that is not loaded
 * is logged with its reason and status_code: validation_errors.json if its data is wrong,
 * failed_records.json if the API refused it or it could not be delivered.
 */
export async function runPipeline(settings: Settings, deps: PipelineDeps): Promise<RunReport> {
  const { logger } = deps;
  const now = deps.now ?? (() => new Date());
  const report = createReport(settings, now());

  // Checked before anything in output/ is touched, so a skipped run leaves the earlier results as they are.
  const input = await fingerprint(settings.inputFile).catch(() => undefined); // an unreadable file is reported below
  if (input && !settings.dryRun && !settings.force) {
    const previous = await findProcessed(settings.outputDir, input.sha256, settings.apiUrl);
    if (previous) {
      report.status = "already_processed";
      report.previous_run = previous;
      report.finished_at = now().toISOString();
      logger.info("input already processed; nothing was sent", {
        processed_at: previous.processed_at,
        run_id: previous.run_id,
        ...previous.counts,
      });
      return report;
    }
  }

  await mkdir(settings.outputDir, { recursive: true });
  const invalid = await JsonArrayFile.create(join(settings.outputDir, VALIDATION_ERRORS_FILE));
  const failures = await JsonArrayFile.create(join(settings.outputDir, FAILED_RECORDS_FILE));
  let loader: PatientLoader | undefined;

  try {
    logger.info("run started", {
      run_id: report.run_id,
      input_file: resolve(settings.inputFile),
      output_dir: resolve(settings.outputDir),
      dry_run: settings.dryRun,
    });

    await checkInputFile(settings.inputFile);
    const extracted = await extractRows(settings.inputFile, settings.inputEncoding);
    const transformed = transform(extracted.rows, { today: report.started_at.slice(0, 10) });
    const rejections = [...extracted.rejected, ...transformed.rejected];
    const invalidEntries = rejections.map((rejection) => toFailureEntry(rejection, now()));
    // One line per record only at debug level: the details are in validation_errors.json/.csv.
    for (const entry of invalidEntries) {
      logger.debug("record held back by validation", {
        status_code: entry.status_code,
        reason: entry.reason,
        patient_id: entry.patient_id,
        lines: entry.source_lines,
        errors: entry.errors,
      });
      await invalid.append(entry);
    }
    await writeErrorCsv(join(settings.outputDir, DATA_CORRECTION_CSV), invalidEntries);
    if (invalidEntries.length > 0) {
      report.outputs.data_correction_csv = DATA_CORRECTION_CSV;
      logger.warn("records held back by validation", {
        records: invalidEntries.length,
        by_status: countBy(invalidEntries, (entry) => `${entry.status_code} ${entry.reason}`),
        details: VALIDATION_ERRORS_FILE,
      });
    }
    recordCleaning(report, extracted, transformed);
    logger.info("data cleaned", {
      rows_read: report.counts.rows_read,
      patients_valid: report.counts.patients_valid,
      held_back: rejections.length,
      issue_counts: report.issue_counts,
    });

    if (settings.dryRun) {
      await writeJson(
        join(settings.outputDir, CLEANED_RECORDS_FILE),
        transformed.records.map((record) => record.payload),
      );
      report.outputs.cleaned_records = CLEANED_RECORDS_FILE;
      logger.info("dry run: nothing was sent to the SHC API");
    } else {
      // Only a validation-only run writes this; don't leave an older one looking current.
      await rm(join(settings.outputDir, CLEANED_RECORDS_FILE), { force: true });
      loader = createLoader(settings, deps, failures);
      await loader.load(transformed.records);
    }
    report.status = failures.count + invalid.count > 0 ? "completed_with_failures" : "completed";
  } catch (error) {
    ({ status: report.status, error: report.error } = describeStop(error, deps));
  } finally {
    if (loader) recordLoad(report, loader.stats);
    await invalid.close();
    await failures.close();
    report.finished_at = now().toISOString();
    await writeJson(join(settings.outputDir, REPORT_FILE), report);
    if (input && !settings.dryRun && isFinished(report.status)) await recordProcessed(settings.outputDir, input, report, settings.apiUrl);
    logger.info("run finished", {
      status: report.status,
      ...report.counts,
      validation_errors: invalid.count,
      failed_records: failures.count,
    });
  }
  return report;
}

/** A run that went through the whole file. Stopped runs are not recorded, so they can simply be re-run. */
function isFinished(status: RunStatus): boolean {
  return status === "completed" || status === "completed_with_failures";
}

/** A loader configured from the settings, logging what it cannot deliver to `failures`. */
export function createLoader(
  settings: Settings,
  deps: PipelineDeps,
  failures: { append(entry: FailureEntry): Promise<void> },
): PatientLoader {
  if (!settings.apiToken) throw new Error("an API token is required outside a dry run");
  return new PatientLoader({
    url: settings.apiUrl,
    token: settings.apiToken,
    batchSize: settings.batchSize,
    retry: { maxRetries: settings.maxRetries, baseDelayMs: settings.backoffBaseMs, maxDelayMs: settings.backoffMaxMs },
    requestTimeoutMs: settings.requestTimeoutMs,
    maxConsecutiveFailedBatches: settings.maxConsecutiveFailedBatches,
    limiter: new SlidingWindowRateLimiter(settings.rateLimitPerSecond, RATE_LIMIT_WINDOW_MS, deps.clock),
    failures,
    logger: deps.logger,
    ...(deps.fetch && { fetch: deps.fetch }),
    ...(deps.clock && { clock: deps.clock }),
    ...(deps.random && { random: deps.random }),
    ...(deps.signal && { signal: deps.signal }),
  });
}

/** Logs why a run stopped early and returns the status to report. */
export function describeStop(error: unknown, deps: PipelineDeps): { status: RunStatus; error: string } {
  const message = errorMessage(error);
  const expected =
    deps.signal?.aborted ||
    error instanceof InputError ||
    error instanceof FatalApiError ||
    error instanceof ApiUnavailableError;
  if (expected) deps.logger.error("run stopped", { error: message });
  else deps.logger.error("run failed with an unexpected error", { error: message, stack: (error as Error).stack });
  return { status: deps.signal?.aborted ? "interrupted" : "aborted", error: message };
}

function createReport(settings: Settings, startedAt: Date): RunReport {
  return {
    run_id: randomUUID(),
    status: "aborted",
    error: null,
    dry_run: settings.dryRun,
    started_at: startedAt.toISOString(),
    finished_at: null,
    input_file: settings.inputFile,
    counts: {
      rows_read: 0,
      rows_repaired: 0,
      rows_rejected: 0,
      duplicate_rows_superseded: 0,
      patients_found: 0,
      patients_rejected: 0,
      patients_valid: 0,
      patients_loaded: 0,
      patients_rejected_by_api: 0,
      patients_failed_after_retries: 0,
      patients_not_attempted: 0,
    },
    api: null,
    dob_formats: {},
    issue_counts: {},
    issues: [],
    previous_run: null,
    outputs: {
      failed_records: FAILED_RECORDS_FILE,
      validation_errors: VALIDATION_ERRORS_FILE,
      data_correction_csv: null,
      cleaned_records: null,
    },
  };
}

function recordCleaning(report: RunReport, extracted: ExtractResult, transformed: TransformResult): void {
  const rejections = [...extracted.rejected, ...transformed.rejected];
  const rowLevel = (rejection: Rejection) => rejection.reason === "malformed_row" || rejection.reason === "missing_patient_id";
  const issues = [...extracted.issues, ...transformed.issues].sort((a, b) => a.line - b.line);

  Object.assign(report.counts, {
    rows_read: extracted.rowsRead,
    rows_repaired: extracted.issues.filter((issue) => issue.code === "row_repaired").length,
    rows_rejected: rejections.filter(rowLevel).length,
    duplicate_rows_superseded: transformed.supersededRows,
    patients_found: transformed.distinctPatients,
    patients_rejected: rejections.filter((rejection) => !rowLevel(rejection)).length,
    patients_valid: transformed.records.length,
    patients_not_attempted: transformed.records.length,
  });
  report.dob_formats = transformed.dobFormats;
  for (const issue of issues) report.issue_counts[issue.code] = (report.issue_counts[issue.code] ?? 0) + 1;
  report.issues = issues.map(({ code, line, patientId, detail }) => ({ code, line, patient_id: patientId, detail }));
}

function recordLoad(report: RunReport, stats: LoadStats): void {
  report.api = { batches: stats.batches, requests: stats.requests, retries: stats.retries };
  report.counts.patients_loaded = stats.loaded;
  report.counts.patients_rejected_by_api = stats.rejected;
  report.counts.patients_failed_after_retries = stats.failedAfterRetries;
  report.counts.patients_not_attempted = stats.notAttempted;
}

function toFailureEntry(rejection: Rejection, at: Date): FailureEntry {
  const statusCode = FAILURE_STATUS_CODES[rejection.reason];
  return {
    stage: "validation",
    reason: rejection.reason,
    status_code: statusCode,
    retryable: isRetryable(statusCode),
    patient_id: rejection.patientId,
    source_lines: rejection.rows.map((row) => row.line),
    errors: rejection.errors,
    source_rows: rejection.rows,
    logged_at: at.toISOString(),
  };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
