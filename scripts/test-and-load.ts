/**
 * `npm test`: the whole local check in one command, with short, readable output.
 *
 *   1. runs the automated test suite (which never touches output/ or the real table);
 *   2. loads a real CSV end to end: creates the output files from scratch and stores the
 *      patients in the PostgreSQL table, creating the table if it does not exist;
 *   3. ends with the job's summary and the number of rows now in the table.
 *
 * Step 2 is always local: it starts its own mock SHC API for the run, on the PostgreSQL in
 * DATABASE_URL (.env). `npm run test:unit` runs only the test suite (for CI).
 *
 *   npm test                 # loads data/input/patients.csv (the job's one fixed input)
 *   npm test -- --force      # load it even if this exact file was already processed
 */
import { spawnSync } from "node:child_process";
import { startMockApi, type MockApi } from "../mock-api/server.ts";
import { DEFAULT_TABLE, PostgresPatientStore, describeDbError } from "../mock-api/store.ts";
import { ConfigError, loadSettings } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { runPipeline } from "../src/pipeline.ts";
import { detectInvocation, renderConfigError, renderRunSummary, renderStart } from "../src/summary.ts";

const DEMO_TOKEN = "local-demo-token";
const RULE = "═".repeat(78);

const how = detectInvocation();
const step = (n: number, title: string) => console.log(`\n${RULE}\n  STEP ${n} of 2 · ${title}\n${RULE}`);

process.exitCode = await main();

async function main(): Promise<number> {
  step(1, "Automated tests (they use temporary files only, never your output/ folder or table)");
  if (!runTestSuite()) {
    console.log("\n  The real load was skipped because the code is failing its tests. Fix them first.");
    console.log("  Full test output: npm run test:unit");
    return 1;
  }

  step(2, "Real load: CSV → mock SHC API → PostgreSQL, writing output/ from scratch");
  return await realLoad();
}

/** Runs the suite with a machine-readable reporter and prints one line per outcome, not per test. */
function runTestSuite(): boolean {
  console.log("  Running the test suite (about 10 seconds)…");
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "tests/**/*.test.ts"], { encoding: "utf8" });
  const output = `${run.stdout}${run.stderr}`;
  const count = (name: string) => Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(output)?.[1] ?? 0);
  const [passed, failed, skipped] = [count("pass"), count("fail"), count("skipped")];
  const seconds = (count("duration_ms") / 1000).toFixed(1);

  if (run.status === 0 && failed === 0) {
    console.log(`  ✓ All ${passed} tests passed in ${seconds} s${skipped ? ` (${skipped} skipped)` : ""}`);
    return true;
  }
  console.log(`  ✗ ${failed} of ${passed + failed} tests failed:`);
  for (const [, name] of output.matchAll(/^\s*not ok \d+ - (.*)$/gm)) console.log(`      - ${name}`);
  return false;
}

async function realLoad(): Promise<number> {
  const env = {
    // Local demo defaults, so this works even without a .env file. Real values in .env win.
    SHC_API_TOKEN: DEMO_TOKEN,
    SHC_ALLOW_INSECURE_HTTP: "true",
    SHC_LOG_FORMAT: "pretty",
    ...process.env,
  };

  let api: MockApi | undefined;
  let store: PostgresPatientStore | undefined;
  try {
    const target = await startLocalApi(env);
    if ("error" in target) {
      console.log(`\n  ✗ ${target.error}`);
      for (const line of target.fix) console.log(`    ${line}`);
      return 1;
    }
    ({ api, store } = target);

    let settings;
    try {
      const force = process.argv.slice(2).includes("--force");
      settings = loadSettings({ ...env, SHC_API_URL: target.url, ...(force && { SHC_FORCE: "true" }) });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      process.stderr.write(renderConfigError(error.message, how));
      return 1;
    }
    const logger = createLogger(settings.logLevel, undefined, "pretty");
    process.stdout.write(`\n${renderStart("ingest", settings, how)}`);
    const report = await runPipeline(settings, { logger });
    const jobExitCode = { completed: 0, already_processed: 0, completed_with_failures: 2, aborted: 1, interrupted: 130 }[report.status];
    process.stdout.write(await renderRunSummary(report, settings, jobExitCode, how));

    const rows = await target.store.count();
    console.log(`  Database : table ${target.table} now holds ${rows} patient(s)\n`);
    // Records needing attention are an expected result of a load, not a failed test run.
    return report.status === "aborted" || report.status === "interrupted" ? 1 : 0;
  } finally {
    await api?.close();
    await store?.close();
  }
}

type Target =
  | { url: string; table: string; api: MockApi; store: PostgresPatientStore }
  | { error: string; fix: string[] };

/** Always the local setup: a mock API started for this run, on the PostgreSQL in DATABASE_URL. */
async function startLocalApi(env: NodeJS.ProcessEnv): Promise<Target> {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) return { error: "DATABASE_URL is not set, so there is nowhere to store patients.", fix: ["Set it in .env (see .env.example)."] };
  const table = env.MOCK_DB_TABLE || DEFAULT_TABLE;
  const where = new URL(databaseUrl);
  console.log(`  Starting a local mock SHC API on PostgreSQL database "${where.pathname.slice(1)}" (${where.host})…`);
  let store: PostgresPatientStore;
  try {
    store = await PostgresPatientStore.connect(databaseUrl, table, (line) => console.log(`  ${line}`));
  } catch (error) {
    return {
      error: `Cannot connect to PostgreSQL at ${where.host}: ${describeDbError(error)}`,
      fix: ["Check that your local PostgreSQL is running and that DATABASE_URL in .env is right, then run npm test again."],
    };
  }
  if (store.createdDatabase) console.log(`  ✓ Database "${where.pathname.slice(1)}" did not exist, so it was created`);
  console.log(
    store.createdTable
      ? `  ✓ Table ${table} did not exist, so it was created`
      : `  ✓ Table ${table} exists (${await store.count()} patient(s) before this run)`,
  );
  const api = await startMockApi({ token: env.SHC_API_TOKEN ?? DEMO_TOKEN, store });
  return { url: `${api.url}/v1/patients`, table, api, store };
}
