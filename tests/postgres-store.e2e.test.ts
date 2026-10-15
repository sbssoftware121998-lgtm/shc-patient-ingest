/**
 * Runs only when TEST_DATABASE_URL points at a PostgreSQL database, e.g.
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test
 * It uses its own uniquely named table and drops it afterwards, so it never touches real data.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { startMockApi, type MockApi } from "../mock-api/server.ts";
import { PostgresPatientStore } from "../mock-api/store.ts";
import { silentLogger } from "../src/logger.ts";
import { runPipeline } from "../src/pipeline.ts";
import { fixedNow, tempDir, testSettings } from "./helpers.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("PostgreSQL storage", { skip: databaseUrl ? false : "set TEST_DATABASE_URL to run", timeout: 60_000 }, () => {
  const table = `test_patients_${process.pid}_${Date.now()}`;
  let store: PostgresPatientStore;
  let api: MockApi;
  let sql: pg.Client;

  const load = async () =>
    runPipeline(
      testSettings({
        inputFile: "data/patients_extended.csv",
        outputDir: await tempDir(),
        apiUrl: `${api.url}/v1/patients`,
        rateLimitPerSecond: 50,
      }),
      { logger: silentLogger, now: fixedNow },
    );

  before(async () => {
    store = await PostgresPatientStore.connect(databaseUrl!, table);
    // Each load gets a fresh client-side limiter, so back-to-back loads could trip a 50/s API limit.
    api = await startMockApi({ token: "test-token", rateLimitPerSecond: 1000, store });
    sql = new pg.Client({ connectionString: databaseUrl });
    await sql.connect();
  });

  after(async () => {
    await api?.close();
    await store?.close();
    await sql?.query(`DROP TABLE IF EXISTS ${table}`);
    await sql?.end();
  });

  it("stores every loaded patient as a typed row", async () => {
    const report = await load();
    assert.equal(report.counts.patients_loaded, 108);

    const { rows } = await sql.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 108);

    const jane = await sql.query(
      `SELECT to_char(dob, 'YYYY-MM-DD') AS dob, email, phone, account_balance::text AS balance,
              to_char(last_modified AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS modified
       FROM ${table} WHERE patient_id = 'P-1002'`,
    );
    assert.deepEqual(jane.rows[0], { dob: "1992-12-31", email: null, phone: null, balance: "1250.00", modified: "2026-10-02 11:30:00" });
  });

  it("is safe to re-run: still exactly one row per patient", async () => {
    const ids = async () => (await sql.query(`SELECT patient_id FROM ${table} ORDER BY patient_id`)).rows.map((r) => r.patient_id);
    const firstRun = await ids();
    await load();
    assert.deepEqual(await ids(), firstRun);
    assert.equal(firstRun.length, 108);
  });

  it("recreates the table if it is dropped while the API is running", async () => {
    await sql.query(`DROP TABLE ${table}`);
    const report = await load();
    assert.equal(report.counts.patients_loaded, 108);
    const { rows } = await sql.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 108);
  });

  it("never lets an older version overwrite a newer one", async () => {
    const newer = { patient_id: "P-9001", first_name: "New", last_name: "Version", dob: "1980-01-01", email: null, phone: null, account_balance: 2, last_modified: "2026-10-02T00:00:00Z" };
    await store.upsert([newer]);
    await store.upsert([{ ...newer, first_name: "Old", account_balance: 1, last_modified: "2026-09-01T00:00:00Z" }]);
    const { rows } = await sql.query(`SELECT first_name, account_balance::float8 AS balance FROM ${table} WHERE patient_id = 'P-9001'`);
    assert.deepEqual(rows[0], { first_name: "New", balance: 2 });
  });
});
