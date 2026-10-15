import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Settings } from "./config.ts";
import { InputError, checkInputFile } from "./extract.ts";
import { JsonArrayFile } from "./failure-log.ts";
import type { PatientLoader } from "./load.ts";
import { FAILED_RECORDS_FILE, createLoader, describeStop, writeJson, type PipelineDeps, type RunStatus } from "./pipeline.ts";
import { isRetryable, type CleanRecord, type FailureEntry } from "./types.ts";

export const RETRY_REPORT_FILE = "retry_report.json";

export interface RetryReport {
  run_id: string;
  mode: "retry";
  status: RunStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /** The reviewed file that was resent, and updated: always data/retry/failed_records.json. */
  retry_file: string;
  counts: {
    entries_read: number;
    /** Entries with a 5xx status_code that were sent again. */
    retried: number;
    /** Retried and accepted by the API: removed from the failure file. */
    loaded: number;
    /** Retried and failed again: still in the failure file, with their latest status. */
    still_failing: number;
    /** 4xx entries carried over unchanged: their data must be fixed in the export. */
    kept_not_retryable: number;
  };
  api: { batches: number; requests: number; retries: number } | null;
}

/**
 * `failed`: resends every retryable (5xx) entry of the reviewed failure file,
 * data/retry/failed_records.json, using the payloads saved in it, so the CSV is not read again.
 * It only runs when a person asks for it: the job never copies anything into data/retry/ itself.
 *
 * Afterwards the file holds only what is still not loaded: each record that loads is removed,
 * a record that fails again stays with its new status, and 4xx entries are kept unchanged. So
 * running `failed` again only resends what still needs it, and nothing is sent twice. The same
 * list is written to output/failed_records.json.
 *
 * The new content is written beside each file and renamed over it at the end, so a crash during
 * the retry leaves the previous files intact.
 */
export async function runRetry(settings: Settings, deps: PipelineDeps): Promise<RetryReport> {
  const { logger } = deps;
  const now = deps.now ?? (() => new Date());
  const output = join(settings.outputDir, FAILED_RECORDS_FILE);
  const draftPath = `${output}.tmp`;
  const report: RetryReport = {
    run_id: randomUUID(),
    mode: "retry",
    status: "aborted",
    error: null,
    started_at: now().toISOString(),
    finished_at: null,
    retry_file: settings.retryFile,
    counts: { entries_read: 0, retried: 0, loaded: 0, still_failing: 0, kept_not_retryable: 0 },
    api: null,
  };

  let draft: JsonArrayFile | undefined;
  let loader: PatientLoader | undefined;
  let retried: CleanRecord[] = [];
  try {
    await checkInputFile(settings.retryFile, "retry file", "the reviewed failed_records.json");
    const entries = await readFailures(settings.retryFile);
    const keep = entries.filter((entry) => !canResend(entry));
    retried = entries.filter(canResend).map(toRecord);
    Object.assign(report.counts, { entries_read: entries.length, retried: retried.length, kept_not_retryable: keep.length });
    logger.info("retry started", {
      run_id: report.run_id,
      retry_file: resolve(settings.retryFile),
      entries: entries.length,
      retrying: retried.length,
      keeping_not_retryable: keep.length,
    });

    await mkdir(settings.outputDir, { recursive: true });
    draft = await JsonArrayFile.create(draftPath);
    for (const entry of keep) await draft.append(entry);
    if (retried.length > 0) {
      loader = createLoader(settings, deps, draft);
      await loader.load(retried);
    } else {
      logger.info("nothing to retry: no entry has a 5xx status_code");
    }
    report.status = draft.count > 0 ? "completed_with_failures" : "completed";
  } catch (error) {
    ({ status: report.status, error: report.error } = describeStop(error, deps));
  } finally {
    const stats = loader?.stats;
    if (stats) {
      report.api = { batches: stats.batches, requests: stats.requests, retries: stats.retries };
      report.counts.loaded = stats.loaded;
      report.counts.still_failing = stats.rejected + stats.failedAfterRetries + stats.notAttempted;
    }
    if (draft) {
      await draft.close();
      // Every retried record must be accounted for (loaded, or logged again) before the draft
      // may replace the output file; otherwise keep the old file and discard the draft.
      const accounted = report.counts.loaded + report.counts.still_failing === retried.length;
      if (accounted) {
        const retryDraft = `${settings.retryFile}.tmp`;
        await copyFile(draftPath, retryDraft);
        await rename(retryDraft, settings.retryFile); // loaded records are gone from the failure file
        await rename(draftPath, output);
      } else {
        await rm(draftPath, { force: true });
      }
    }
    report.finished_at = now().toISOString();
    await mkdir(settings.outputDir, { recursive: true });
    await writeJson(join(settings.outputDir, RETRY_REPORT_FILE), report);
    logger.info("retry finished", { status: report.status, ...report.counts });
  }
  return report;
}

async function readFailures(path: string): Promise<FailureEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new InputError(`${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch {
    throw new InputError(`${path} is not valid JSON`);
  }
  if (!Array.isArray(entries)) throw new InputError(`${path} must contain a JSON array`);
  return entries as FailureEntry[];
}

/** A 5xx entry with its payload saved can be resent unchanged. */
function canResend(entry: FailureEntry): boolean {
  return entry.stage === "api" && typeof entry.status_code === "number" && isRetryable(entry.status_code) && !!entry.record;
}

function toRecord(entry: FailureEntry): CleanRecord {
  return { payload: entry.record!, sourceLine: entry.source_lines[0] ?? 0 };
}
