import { parseArgs } from "node:util";
import { ConfigError, INPUT_FILE_NAME, RETRY_FILE_NAME } from "./config.ts";

const INPUT = `data/input/${INPUT_FILE_NAME}`;
const RETRY = `data/retry/${RETRY_FILE_NAME}`;

/** The three things the job does. The same words work with npm and Docker. */
export const COMMANDS = ["success", "validation", "failed"] as const;
export type Command = (typeof COMMANDS)[number];

export const USAGE = `Usage (npm run <command>, or docker compose run --rm ingest <command>):

  success      load ${INPUT} into the SHC API. A file that was already
               loaded is not loaded again: you get that run's counts instead
               (add --force to load it anyway). This is the default.
  validation   check ${INPUT} only, send nothing. Writes
               output/validation_errors.json and output/data_correction.csv,
               the sheet to correct and load again.
  failed       resend every 5xx record in ${RETRY}, and remove
               each one that loads from that file. Retrying is manual: review
               output/failed_records.json and copy it there first.

The input is always ${INPUT} (exactly that location and name). To load
another export, or a corrected data_correction.csv, copy it there as ${INPUT_FILE_NAME}.

Options:
  --force      with success: load the file even if it was already loaded
  -h, --help   show this help

Everything else is configured with environment variables (see README).`;

export interface Cli {
  mode: "ingest" | "retry" | "help";
  /** Environment overrides derived from the options, validated by loadSettings like any other. */
  env: Record<string, string>;
}

export function parseCli(args: readonly string[]): Cli {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        // Older spellings of the commands, still accepted.
        validate: { type: "boolean" },
        "dry-run": { type: "boolean" },
        retry: { type: "boolean" },
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && /--input|'-i'/.test((error as Error).message)) {
      throw fixedInputError();
    }
    throw new ConfigError(`${(error as Error).message} (run with --help for usage)`);
  }
  const { values, positionals } = parsed;
  if (values.help) return { mode: "help", env: {} };
  if (positionals.length > 1) throw new ConfigError(`give one command, got: ${positionals.join(" ")}`);

  const command = toCommand(positionals[0], values);
  if (values.force && command !== "success") throw new ConfigError(`--force only applies to success, not ${command}`);
  if (command === "failed") return { mode: "retry", env: {} };
  if (command === "validation") return { mode: "ingest", env: { SHC_DRY_RUN: "true" } };
  return { mode: "ingest", env: values.force ? { SHC_FORCE: "true" } : {} };
}

function toCommand(word: string | undefined, flags: { validate?: boolean; "dry-run"?: boolean; retry?: boolean }): Command {
  const fromFlags: Command[] = [
    ...(flags.validate || flags["dry-run"] ? (["validation"] as const) : []),
    ...(flags.retry ? (["failed"] as const) : []),
  ];
  if (word === undefined) {
    if (fromFlags.length > 1) throw new ConfigError("choose one command: success, validation or failed");
    return fromFlags[0] ?? "success";
  }
  const command = COMMANDS.find((candidate) => candidate === word.toLowerCase());
  if (!command) {
    if (/[./\\]/.test(word)) {
      throw word.endsWith(".json")
        ? new ConfigError(`the failed command does not take a file (got "${word}"): it always reads ${RETRY}. Review output/failed_records.json, copy it there, then run failed`)
        : fixedInputError(word);
    }
    throw new ConfigError(`unknown command "${word}": use success, validation or failed (run with --help for usage)`);
  }
  if (fromFlags.some((other) => other !== command)) throw new ConfigError("choose one command: success, validation or failed");
  return command;
}

function fixedInputError(given?: string): ConfigError {
  return new ConfigError(
    `the input file cannot be chosen on the command line${given ? ` (got "${given}")` : ""}: it is always ${INPUT}. ` +
      `Copy the export there as ${INPUT_FILE_NAME}, then run the command without a file name`,
  );
}
