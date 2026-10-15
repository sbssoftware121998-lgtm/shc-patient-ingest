export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
/** json: one JSON object per line, for log pipelines. pretty: aligned text for a person at a terminal. */
export const LOG_FORMATS = ["auto", "json", "pretty"] as const;
export type LogFormat = Exclude<(typeof LOG_FORMATS)[number], "auto">;
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Logger for the client's log pipeline (json) or a person watching the run (pretty). Logs must
 * stay free of PHI: they carry counts, line numbers, patient IDs and HTTP statuses, never names,
 * dates of birth, contact details or balances (those only go to the files in the output directory).
 */
export function createLogger(
  minLevel: LogLevel,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  format: LogFormat = "json",
): Logger {
  const threshold = LOG_LEVELS.indexOf(minLevel);
  const at =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}): void => {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      if (format === "pretty" && SHOWN_BY_SUMMARY.has(message)) return;
      const time = new Date();
      write(
        format === "pretty"
          ? formatPretty(time, level, message, fields)
          : JSON.stringify({ time: time.toISOString(), level, message, ...fields }),
      );
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** In pretty mode the start banner and end-of-run summary already say this, more readably. */
const SHOWN_BY_SUMMARY = new Set(["run started", "run finished", "retry started", "retry finished"]);

/** e.g. `14:20:01  WARN   record rejected by the API  patient_id=p-2701 line=146 status=400` */
export function formatPretty(time: Date, level: LogLevel, message: string, fields: LogFields): string {
  const clock = time.toTimeString().slice(0, 8);
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${prettyValue(value)}`)
    .join(" ");
  return `${clock}  ${level.toUpperCase().padEnd(5)}  ${message}${details ? `  ${details}` : ""}`;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function prettyValue(value: unknown): string {
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  // {"400 malformed_row": 2} reads better as (400 malformed_row: 2)
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return `(${Object.entries(value).map(([key, inner]) => `${key}: ${prettyValue(inner)}`).join(", ")})`;
  }
  return JSON.stringify(value);
}
