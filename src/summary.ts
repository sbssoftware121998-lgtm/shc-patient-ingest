/**
 * Plain-language messages for a person running the job at a terminal: what is about to happen,
 * what happened, and the exact commands to run next. Only used with the pretty log format; log
 * pipelines get the JSON report files instead. Like the logs, nothing here contains PHI.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Settings } from "./config.ts";
import {
  FAILED_RECORDS_FILE,
  REPORT_FILE,
  DATA_CORRECTION_CSV,
  VALIDATION_ERRORS_FILE,
  type RunReport,
  type RunStatus,
} from "./pipeline.ts";
import { PROCESSED_FILES, type ProcessedInput } from "./processed-files.ts";
import type { Command } from "./cli.ts";
import { RETRY_REPORT_FILE, type RetryReport } from "./retry.ts";
import type { FailureEntry } from "./types.ts";

/** How the job was started, so hints show commands that can be pasted as they are. */
export interface Invocation {
  cwd: string;
  /** e.g. command("failed") → "npm run failed"; command("success", true) → "npm run success -- --force" */
  command(command: Command | "help", force?: boolean): string;
  /** Inside a container: where a file is on the person's own machine, so they can open it. */
  onHost?(path: string): string;
}

export function detectInvocation(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Invocation {
  if (env.npm_lifecycle_event) {
    return { cwd, command: (command, force) => (command === "help" ? "npm run success -- --help" : `npm run ${command}${force ? " -- --force" : ""}`) };
  }
  const withWords = (base: string) => (command: Command | "help", force?: boolean) =>
    `${base} ${command === "help" ? "--help" : command}${force ? " --force" : ""}`;
  if (existsSync("/.dockerenv")) {
    // docker-compose.yml mounts ./output at /data/output (and ./data/input, ./data/retry under /app/data).
    return { cwd, command: withWords("docker compose run --rm ingest"), onHost: (path) => path.replace(/^\/data\/output\//, "output/") };
  }
  return { cwd, command: withWords("node dist/index.js") };
}

const RULE = "─".repeat(78);

export function renderStart(mode: "ingest" | "retry", settings: Settings, how: Invocation): string {
  const path = (p: string) => displayPath(p, how.cwd);
  const lines =
    mode === "retry"
      ? [
          "SHC patient ingestion: failed (resend the failed records)",
          `  Failure file : ${path(settings.retryFile)}  (always this file; the job never fills it)`,
          "  Resending    : its retryable (5xx) records; 4xx records are kept as they are",
          `  SHC API      : ${settings.apiUrl}`,
          "  Afterwards   : records that load are removed from the failure file",
        ]
      : [
          `SHC patient ingestion: ${settings.dryRun ? "validation (nothing will be sent)" : "success (load the data)"}`,
          `  Input file : ${path(settings.inputFile)}  (always this file)`,
          ...(settings.dryRun ? [] : [`  SHC API    : ${settings.apiUrl}`]),
          `  Output     : ${path(settings.outputDir)}/`,
          `  Steps      : 1. read and validate the CSV  2. ${
            settings.dryRun
              ? "write the data correction sheet"
              : `send the valid patients (≤${settings.batchSize} per request, ≤${settings.rateLimitPerSecond} requests/s)`
          }  3. write the reports`,
        ];
  return `${lines.join("\n")}\n\nProgress:\n`;
}

export async function renderRunSummary(report: RunReport, settings: Settings, exitCode: number, how: Invocation): Promise<string> {
  const path = (file: string) => displayPath(join(settings.outputDir, file), how.cwd);
  const editable = (file: string) => {
    const inside = path(file);
    const host = how.onHost?.(inside);
    return host && host !== inside ? `${host} on your machine (${inside} in the container)` : inside;
  };
  const counts = report.counts;
  const lines = [RULE, `  RESULT: ${headline(report.status, report.dry_run)}   (exit code ${exitCode})`, RULE];
  if (report.previous_run) return alreadyProcessed(lines, report.previous_run, report, settings, how);

  const invalid = await readEntries(join(settings.outputDir, VALIDATION_ERRORS_FILE));
  // A validation run doesn't touch failed_records.json, so don't report an older run's failures.
  const failed = report.dry_run ? [] : await readEntries(join(settings.outputDir, FAILED_RECORDS_FILE));
  const refused = failed.filter((entry) => !entry.retryable);
  const retryable = failed.filter((entry) => entry.retryable);

  if (report.error) lines.push(`  Reason   : ${report.error}`, `  Fix      : ${hintFor(report.error, settings, how)}`, "");
  if (counts.rows_read > 0) {
    lines.push(
      `  Input    : ${displayPath(report.input_file, how.cwd)}  (${counts.rows_read} rows read)`,
      report.dry_run
        ? `  Patients : ${counts.patients_found} found · ${counts.patients_valid} valid and ready to load · ${invalid.length} need correcting`
        : `  Patients : ${counts.patients_found} found · ${counts.patients_valid} valid · ${counts.patients_loaded} loaded into the SHC API`,
      "",
    );
  }

  if (invalid.length > 0) {
    lines.push(
      `  ✗ ${invalid.length} held back by validation: their data must be corrected`,
      `      ${groupByStatus(invalid)}`,
      `      Details         : ${path(VALIDATION_ERRORS_FILE)}`,
      `      Correction sheet: ${editable(DATA_CORRECTION_CSV)}`,
      "                        (same columns as the export; the last columns say what is wrong)",
    );
  } else if (report.dry_run && report.status === "completed") {
    lines.push("  ✓ Nothing to correct, so no data correction sheet was written.");
  }
  if (refused.length > 0) {
    lines.push(
      `  ✗ ${refused.length} refused by the SHC API: their data must be fixed`,
      `      ${groupByStatus(refused)}`,
      `      Details  : ${path(FAILED_RECORDS_FILE)} ("detail" holds the API's error, "source_lines" the rows in the export)`,
    );
  }
  if (retryable.length > 0) lines.push(...retryableBlock(retryable, path(FAILED_RECORDS_FILE), settings));
  if (invalid.length + failed.length === 0 && report.status === "completed" && !report.dry_run) lines.push("  ✓ Nothing to fix.");

  const steps: string[] = [];
  // Retry first: the next success run replaces failed_records.json.
  if (retryable.length > 0) steps.push(...manualRetrySteps(retryable.length, settings, how));
  if (invalid.length > 0) {
    steps.push(
      `correct the rows in ${editable(DATA_CORRECTION_CSV)} and save it`,
      `copy it over ${displayPath(report.input_file, how.cwd)} (keep the original export somewhere else first)`,
      `check it:  ${how.command("validation")}     then load it:  ${how.command("success")}`,
    );
  }
  if (refused.length > 0) steps.push(`correct the ${refused.length} API-refused patient(s) in the export (rows in "source_lines"), then load it again`);
  if (report.dry_run && invalid.length === 0 && report.status === "completed") steps.push(`load it:  ${how.command("success")}`);
  lines.push("", ...nextSteps(steps), `  Report   : ${path(REPORT_FILE)}`, RULE);
  return `\n${lines.join("\n")}\n`;
}

export async function renderRetrySummary(report: RetryReport, settings: Settings, exitCode: number, how: Invocation): Promise<string> {
  const file = displayPath(settings.retryFile, how.cwd);
  const counts = report.counts;

  const lines = [RULE, `  RESULT: ${retryHeadline(report)}   (exit code ${exitCode})`, RULE];
  if (report.error) lines.push(`  Reason   : ${report.error}`, `  Fix      : ${hintFor(report.error, settings, how)}`, "");
  if (counts.entries_read === 0 && report.error) {
    lines.push(`  ${file} was not changed.`, RULE);
    return `\n${lines.join("\n")}\n`;
  }
  const remaining = await readEntries(settings.retryFile);
  const retryable = remaining.filter((entry) => entry.retryable);
  lines.push(
    `  Read     : ${file}  (${counts.entries_read} records)`,
    `  Resent   : ${counts.retried} with a 5xx status_code · ${counts.loaded} loaded into the SHC API · ${counts.still_failing} still failing`,
    `  Kept     : ${counts.kept_not_retryable} with a 4xx status_code: their data must be fixed, so they were not resent`,
    `  Now      : ${file} lists only the ${remaining.length} record(s) still not in the SHC API${counts.loaded > 0 ? ` (the ${counts.loaded} loaded were removed)` : ""}`,
  );
  if (retryable.length > 0) lines.push("", ...retryableBlock(retryable, file, settings));
  const steps = retryable.length > 0 ? [`once the cause is fixed, resend them again:  ${how.command("failed")}`] : [];
  if (remaining.some((entry) => !entry.retryable)) {
    steps.push(`correct the 4xx records in the export (rows in "source_lines"), then load it:  ${how.command("success")}`);
  }
  lines.push("", ...nextSteps(steps), `  Report   : ${displayPath(join(settings.outputDir, RETRY_REPORT_FILE), how.cwd)}`, RULE);
  return `\n${lines.join("\n")}\n`;
}

/** A configuration or command-line error, explained, for a person at a terminal. */
export function renderConfigError(message: string, how: Invocation): string {
  let fix = `run ${how.command("help")} to see the commands`;
  if (/SHC_API_TOKEN/.test(message)) {
    fix = "for local runs, create your settings file from the example: cp .env.example .env\n" +
      "       (it sets SHC_API_TOKEN for the mock API). Otherwise set SHC_API_TOKEN or SHC_API_TOKEN_FILE.";
  } else if (/failed command does not take a file/.test(message)) {
    fix = `copy the reviewed failures to data/retry/failed_records.json, then run ${how.command("failed")}`;
  } else if (/SHC_INPUT_FILE|cannot be chosen on the command line/.test(message)) {
    fix = `the input is always data/input/patients.csv: copy your export there, then run ${how.command("success")}`;
  } else if (/plain http/.test(message)) {
    fix = "for the local mock API set SHC_ALLOW_INSECURE_HTTP=true (it is in .env.example). Real API URLs must be https.";
  }
  return `\n✗ Configuration error: ${message}\n  Fix: ${fix}\n  Nothing was read or sent.\n`;
}

/** Retrying is never automatic: a person reviews the failures and copies the file into place. */
function manualRetrySteps(count: number, settings: Settings, how: Invocation): string[] {
  const output = displayPath(join(settings.outputDir, FAILED_RECORDS_FILE), how.cwd);
  return [
    `review the ${count} undelivered record(s) in ${how.onHost?.(output) ?? output} and fix the cause (API down, network...)`,
    `when you are sure they should be resent, copy that file to ${displayPath(settings.retryFile, how.cwd)} (exactly that name)`,
    `resend them:  ${how.command("failed")}`,
  ];
}

/** The same content was processed before: show that run's counts instead of loading it again. */
function alreadyProcessed(
  lines: string[],
  previous: ProcessedInput,
  report: RunReport,
  settings: Settings,
  how: Invocation,
): string {
  const c = previous.counts;
  const when = new Date(previous.processed_at).toLocaleString();
  lines.push(
    `  Input    : ${displayPath(report.input_file, how.cwd)} has exactly the same content as the file loaded on ${when}`,
    "  Nothing was sent to the API again, and the files in output/ are still those of that run.",
    "",
    `  That run: ${c.rows_read} rows read · ${c.patients_found} patients found · ${c.patients_valid} valid · ${c.patients_loaded} loaded into the SHC API`,
    `            ${c.held_back_by_validation} held back by validation · ${c.rejected_by_api} refused by the API · ${c.not_delivered} not delivered`,
    "",
  );
  const steps: string[] = [];
  if (c.not_delivered > 0) steps.push(...manualRetrySteps(c.not_delivered, settings, how));
  steps.push(
    `to load new records, copy the export over ${displayPath(report.input_file, how.cwd)}, then:  ${how.command("success")}`,
    `to load this same file again anyway:  ${how.command("success", true)}`,
  );
  lines.push(...nextSteps(steps), `  Ledger   : ${displayPath(join(settings.outputDir, PROCESSED_FILES), how.cwd)}`, RULE);
  return `\n${lines.join("\n")}\n`;
}

function headline(status: RunStatus, dryRun: boolean): string {
  if (status === "already_processed") return "Already processed: this file was loaded before, so nothing was sent";
  if (dryRun && status === "completed") return "Validation passed: every patient is ready to load";
  if (dryRun && status === "completed_with_failures") return "Validation finished: some records need correcting (nothing was sent)";
  if (status === "completed") return "Success: every patient was loaded";
  if (status === "completed_with_failures") return "Finished, but some records were not loaded";
  if (status === "interrupted") return "Interrupted before the end";
  return "Stopped early";
}

function retryHeadline(report: RetryReport): string {
  if (report.status !== "aborted" && report.status !== "interrupted" && report.counts.retried === 0) {
    return report.counts.entries_read === 0
      ? "Nothing to resend: the failure file is empty"
      : "Nothing to resend: every record left needs its data fixed (4xx)";
  }
  if (report.status === "completed") return "Failed records resent: all of them are now loaded";
  if (report.status === "completed_with_failures") return "Failed records resent, but some are still not loaded";
  if (report.status === "interrupted") return "Resend interrupted";
  return "Resend stopped early";
}

function retryableBlock(entries: FailureEntry[], file: string, settings: Settings): string[] {
  const unreachable = entries.some((entry) => entry.reason === "network_error" || entry.reason === "api_timeout");
  return [
    `  ↻ ${entries.length} not delivered: their data is fine and safe to resend`,
    `      ${groupByStatus(entries)}`,
    `      Details  : ${file}`,
    ...(unreachable
      ? [`      Check    : is the SHC API reachable at ${settings.apiUrl}? (locally: npm run mock-api, or npm run docker:up)`]
      : []),
  ];
}

function nextSteps(steps: string[]): string[] {
  if (steps.length === 0) return [];
  return ["  Next steps:", ...steps.map((step, index) => `    ${index + 1}. ${step}`), ""];
}

function hintFor(error: string, settings: Settings, how: Invocation): string {
  if (/input file not found/.test(error)) {
    return `copy the export to ${displayPath(settings.inputFile, how.cwd)} (exactly that name), then:  ${how.command("success")}`;
  }
  if (/retry file not found/.test(error)) {
    return `review output/failed_records.json, then copy it to ${displayPath(settings.retryFile, how.cwd)} (exactly that name) and run:  ${how.command("failed")}`;
  }
  if (/credentials/.test(error)) return `check SHC_API_TOKEN (in .env for local runs); the records not sent are logged for ${how.command("failed")}`;
  if (/endpoint not found|redirect/.test(error)) return `check SHC_API_URL (now ${settings.apiUrl})`;
  if (/consecutive batches failed/.test(error)) {
    return `the SHC API at ${settings.apiUrl} looks down. Once it is back, review and resend the failures with ${how.command("failed")}`;
  }
  if (/aborted|shutdown/i.test(error)) return `the records not sent are in output/failed_records.json; resend them with ${how.command("failed")}`;
  if (/input|CSV|column|encoding|quoted field/i.test(error)) return "correct the input file as described, then run again";
  return "see the messages above; the job is safe to run again";
}

function groupByStatus(entries: FailureEntry[]): string {
  const groups = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.status_code} ${entry.reason}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key} ×${count}`).join(" · ");
}

async function readEntries(path: string): Promise<FailureEntry[]> {
  try {
    const entries: unknown = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(entries) ? (entries as FailureEntry[]) : [];
  } catch {
    return [];
  }
}

/** Relative to the working directory when inside it (as a person would type it), else absolute. */
export function displayPath(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}
