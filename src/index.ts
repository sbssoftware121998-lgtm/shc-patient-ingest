import { USAGE, parseCli, type Cli } from "./cli.ts";
import { ConfigError, describeSettings, loadSettings, type Settings } from "./config.ts";
import { createLogger, type LogFormat } from "./logger.ts";
import { runPipeline, type RunStatus } from "./pipeline.ts";
import { runRetry } from "./retry.ts";
import { detectInvocation, renderConfigError, renderRetrySummary, renderRunSummary, renderStart } from "./summary.ts";

/**
 * 0   everything was loaded (or a dry run found nothing to fix), or this exact file was already processed
 * 2   the run finished, but some records were not loaded: see validation_errors.json and failed_records.json
 * 1   the run stopped early (bad configuration or input, API unreachable or refusing us)
 * 130 interrupted by SIGTERM/SIGINT
 */
const EXIT_CODES: Record<RunStatus, number> = {
  completed: 0,
  completed_with_failures: 2,
  already_processed: 0,
  aborted: 1,
  interrupted: 130,
};

async function main(): Promise<number> {
  const how = detectInvocation();
  let cli: Cli;
  let settings: Settings;
  try {
    cli = parseCli(process.argv.slice(2));
    if (cli.mode === "help") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    settings = loadSettings({ ...process.env, ...cli.env });
    if (cli.mode === "retry" && settings.dryRun) throw new ConfigError("--retry cannot be combined with SHC_DRY_RUN=true");
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (resolveFormat(process.env.SHC_LOG_FORMAT) === "pretty") process.stderr.write(renderConfigError(error.message, how));
    else logStartupError(`configuration error: ${error.message}`);
    return 1;
  }

  const format = resolveFormat(settings.logFormat);
  const logger = createLogger(settings.logLevel, undefined, format);
  if (format === "pretty") {
    // A person is watching: say what is about to happen; the full settings are only needed when debugging.
    process.stdout.write(renderStart(cli.mode, settings, how));
    logger.debug("configuration loaded", { mode: cli.mode, ...describeSettings(settings) });
  } else {
    logger.info("configuration loaded", { mode: cli.mode, ...describeSettings(settings) });
  }

  // As PID 1 in a container, Node gets no default SIGTERM handling, so `docker stop` would hang
  // until SIGKILL. Instead, stop after the in-flight request and still write the report.
  const shutdown = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    logger.warn("shutdown requested; stopping after the in-flight request", { signal });
    shutdown.abort();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  const deps = { logger, signal: shutdown.signal };
  if (cli.mode === "retry") {
    const report = await runRetry(settings, deps);
    const code = EXIT_CODES[report.status];
    if (format === "pretty") process.stdout.write(await renderRetrySummary(report, settings, code, how));
    return code;
  }
  const report = await runPipeline(settings, deps);
  const code = EXIT_CODES[report.status];
  if (format === "pretty") process.stdout.write(await renderRunSummary(report, settings, code, how));
  return code;
}

/** auto (the default): readable text at a terminal, JSON lines when the output is collected. */
function resolveFormat(setting: string | undefined): LogFormat {
  const value = setting?.trim().toLowerCase();
  if (value === "json" || value === "pretty") return value;
  return process.stdout.isTTY ? "pretty" : "json";
}

function logStartupError(message: string): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: "error", message })}\n`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    logStartupError(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
