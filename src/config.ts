import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOG_FORMATS, LOG_LEVELS, type LogLevel } from "./logger.ts";

/** The SHC API accepts at most this many records per request. */
export const API_MAX_BATCH_SIZE = 100;
export const DEFAULT_API_URL = "https://api.mock-shc.com/v1/patients";

/**
 * The one file the job reads: always this location and exactly this name, so there is never a
 * question of which export was loaded. It is relative to the application folder (the project
 * locally, /app in the container, where docker-compose mounts ./data/input). To load another
 * export, or a corrected data_correction.csv, copy it here as patients.csv.
 */
export const INPUT_FILE_NAME = "patients.csv";
export const INPUT_DIR = fileURLToPath(new URL("../data/input/", import.meta.url));
export const INPUT_FILE = `${INPUT_DIR}${INPUT_FILE_NAME}`;

/**
 * The one file --retry reads, by the same rule: always this location, exactly this name. The job
 * never puts anything here itself. A person reviews output/failed_records.json and copies it here,
 * and that copy is the decision to resend.
 */
export const RETRY_FILE_NAME = "failed_records.json";
export const RETRY_DIR = fileURLToPath(new URL("../data/retry/", import.meta.url));
export const RETRY_FILE = `${RETRY_DIR}${RETRY_FILE_NAME}`;

export interface Settings {
  inputFile: string;
  /** What --retry reads: always RETRY_FILE (tests point it elsewhere). */
  retryFile: string;
  inputEncoding: string;
  outputDir: string;
  apiUrl: string;
  /** Null only in a dry run. */
  apiToken: string | null;
  batchSize: number;
  rateLimitPerSecond: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  requestTimeoutMs: number;
  maxConsecutiveFailedBatches: number;
  dryRun: boolean;
  /** Process the input even if the same content was processed before. */
  force: boolean;
  logLevel: LogLevel;
  /** auto: pretty when writing to a terminal, json otherwise. */
  logFormat: (typeof LOG_FORMATS)[number];
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Env = Record<string, string | undefined>;

/**
 * Reads all configuration from environment variables so the same image runs unchanged in
 * every environment, and secrets never end up in the image. Invalid values fail fast at
 * startup with a message naming the variable.
 */
export function loadSettings(env: Env = process.env): Settings {
  if (env.SHC_INPUT_FILE?.trim()) {
    throw new ConfigError(
      `SHC_INPUT_FILE is not supported: the input is always data/input/${INPUT_FILE_NAME}. Remove SHC_INPUT_FILE (e.g. from .env) and copy the export there`,
    );
  }
  const dryRun = readBoolean(env, "SHC_DRY_RUN", false);
  const apiToken = readToken(env);
  if (!apiToken && !dryRun) {
    throw new ConfigError("SHC_API_TOKEN or SHC_API_TOKEN_FILE is required (or set SHC_DRY_RUN=true)");
  }
  const backoffBaseMs = readInt(env, "SHC_BACKOFF_BASE_MS", 1000, 1, 60_000);
  const backoffMaxMs = readInt(env, "SHC_BACKOFF_MAX_MS", 30_000, 1, 600_000);
  if (backoffMaxMs < backoffBaseMs) throw new ConfigError("SHC_BACKOFF_MAX_MS must be >= SHC_BACKOFF_BASE_MS");

  return {
    inputFile: INPUT_FILE,
    retryFile: RETRY_FILE,
    inputEncoding: readEncoding(env),
    outputDir: readString(env, "SHC_OUTPUT_DIR", "output"),
    apiUrl: readApiUrl(env, readBoolean(env, "SHC_ALLOW_INSECURE_HTTP", false)),
    apiToken,
    batchSize: readInt(env, "SHC_BATCH_SIZE", API_MAX_BATCH_SIZE, 1, API_MAX_BATCH_SIZE),
    rateLimitPerSecond: readInt(env, "SHC_RATE_LIMIT_PER_SECOND", 5, 1, 1000),
    maxRetries: readInt(env, "SHC_MAX_RETRIES", 5, 0, 20),
    backoffBaseMs,
    backoffMaxMs,
    requestTimeoutMs: readInt(env, "SHC_REQUEST_TIMEOUT_MS", 30_000, 100, 600_000),
    maxConsecutiveFailedBatches: readInt(env, "SHC_MAX_CONSECUTIVE_FAILED_BATCHES", 3, 1, 1_000_000),
    dryRun,
    force: readBoolean(env, "SHC_FORCE", false),
    logLevel: readLogLevel(env),
    logFormat: readLogFormat(env),
  };
}

/** Settings that are safe to log: the token is redacted. */
export function describeSettings(settings: Settings): Record<string, unknown> {
  const { apiToken, ...rest } = settings;
  return { ...rest, apiToken: apiToken ? "[redacted]" : null };
}

function readString(env: Env, name: string, fallback: string): string {
  return env[name]?.trim() || fallback;
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["true", "1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

function readToken(env: Env): string | null {
  const inline = env.SHC_API_TOKEN?.trim();
  const file = env.SHC_API_TOKEN_FILE?.trim();
  if (inline && file) throw new ConfigError("set SHC_API_TOKEN or SHC_API_TOKEN_FILE, not both");
  if (!file) return inline || null;

  let token: string;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new ConfigError(`SHC_API_TOKEN_FILE cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!token) throw new ConfigError("SHC_API_TOKEN_FILE is empty");
  return token;
}

function readApiUrl(env: Env, allowInsecureHttp: boolean): string {
  const raw = readString(env, "SHC_API_URL", DEFAULT_API_URL);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`SHC_API_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    throw new ConfigError(
      "SHC_API_URL uses plain http; patient data must be sent over https (SHC_ALLOW_INSECURE_HTTP=true is for local testing only)",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`SHC_API_URL must be an https URL, got "${url.protocol}"`);
  }
  return url.toString();
}

function readEncoding(env: Env): string {
  const label = readString(env, "SHC_INPUT_ENCODING", "utf-8");
  try {
    return new TextDecoder(label).encoding;
  } catch {
    throw new ConfigError(`SHC_INPUT_ENCODING "${label}" is not a supported encoding`);
  }
}

function readLogFormat(env: Env): Settings["logFormat"] {
  const raw = readString(env, "SHC_LOG_FORMAT", "auto").toLowerCase();
  const format = LOG_FORMATS.find((candidate) => candidate === raw);
  if (!format) throw new ConfigError(`SHC_LOG_FORMAT must be one of ${LOG_FORMATS.join(", ")}`);
  return format;
}

function readLogLevel(env: Env): LogLevel {
  const raw = readString(env, "SHC_LOG_LEVEL", "info").toLowerCase();
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (!level) throw new ConfigError(`SHC_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  return level;
}
