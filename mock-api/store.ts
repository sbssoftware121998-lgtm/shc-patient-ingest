/**
 * Where the mock SHC API keeps the patients it accepts: in memory (tests, quick demos) or in
 * PostgreSQL (set DATABASE_URL). Both behave the same way:
 *  - a save is all-or-nothing, like the API's handling of a request;
 *  - it is an upsert keyed on patient_id, so re-running the ingestion is safe;
 *  - an older version never overwrites a newer one (compared on last_modified).
 */
import pg from "pg";

export type PatientRow = Record<string, unknown>;

export interface PatientStore {
  /** Shown by GET /healthz, so callers can tell where patients end up. */
  readonly storage: "memory" | "postgresql";
  readonly table: string | null;
  upsert(patients: PatientRow[]): Promise<void>;
  list(): Promise<PatientRow[]>;
  close(): Promise<void>;
}

export class MemoryPatientStore implements PatientStore {
  readonly storage = "memory";
  readonly table = null;
  readonly patients = new Map<string, PatientRow>();

  async upsert(patients: PatientRow[]): Promise<void> {
    for (const patient of patients) {
      const id = String(patient.patient_id);
      const existing = this.patients.get(id);
      if (!existing || Date.parse(String(existing.last_modified)) <= Date.parse(String(patient.last_modified))) {
        this.patients.set(id, patient);
      }
    }
  }

  async list(): Promise<PatientRow[]> {
    return [...this.patients.values()];
  }

  async close(): Promise<void> {}
}

export const DEFAULT_TABLE = "global_health_client_patient_data_master";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export class PostgresPatientStore implements PatientStore {
  readonly storage = "postgresql";
  readonly table: string;
  /** True when connect() had to create the database / the table. */
  createdDatabase = false;
  createdTable = false;
  private readonly pool: pg.Pool;
  private readonly log: (line: string) => void;

  private constructor(pool: pg.Pool, table: string, log: (line: string) => void) {
    this.pool = pool;
    this.table = table;
    this.log = log;
  }

  /** Connects and creates the table if it does not exist yet. */
  static async connect(
    connectionString: string,
    table = DEFAULT_TABLE,
    log: (line: string) => void = () => {},
  ): Promise<PostgresPatientStore> {
    // The table name is interpolated into SQL, so only plain lower-case identifiers are allowed.
    if (!IDENTIFIER.test(table)) throw new Error(`invalid table name "${table}"`);
    const createdDatabase = await createDatabaseIfMissing(connectionString);
    const pool = new pg.Pool({ connectionString, max: 5 });
    const store = new PostgresPatientStore(pool, table, log);
    store.createdDatabase = createdDatabase;
    try {
      const existing = await pool.query<{ found: boolean }>("SELECT to_regclass($1) IS NOT NULL AS found", [table]);
      await pool.query(createTableSql(table));
      store.createdTable = !existing.rows[0]?.found;
    } catch (error) {
      await pool.end();
      throw error;
    }
    return store;
  }

  async count(): Promise<number> {
    const result = await this.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${this.table}`);
    return result.rows[0]?.n ?? 0;
  }

  async upsert(patients: PatientRow[]): Promise<void> {
    // One statement for the whole request, so it is stored completely or not at all.
    await this.query(
      `INSERT INTO ${this.table} AS t
         (patient_id, first_name, last_name, dob, email, phone, account_balance, last_modified)
       SELECT patient_id, first_name, last_name, dob, email, phone, account_balance, last_modified
       FROM jsonb_to_recordset($1::jsonb) AS p(
         patient_id text, first_name text, last_name text, dob date, email text, phone text,
         account_balance numeric, last_modified timestamptz)
       ON CONFLICT (patient_id) DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         dob = EXCLUDED.dob,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         account_balance = EXCLUDED.account_balance,
         last_modified = EXCLUDED.last_modified,
         updated_at = now()
       WHERE t.last_modified <= EXCLUDED.last_modified`,
      [JSON.stringify(patients)],
    );
  }

  async list(): Promise<PatientRow[]> {
    // Returned in the same shape the API accepts.
    const result = await this.query<PatientRow>(
      `SELECT patient_id, first_name, last_name, to_char(dob, 'YYYY-MM-DD') AS dob, email, phone,
              account_balance::float8 AS account_balance,
              to_char(last_modified AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_modified
       FROM ${this.table}
       ORDER BY patient_id`,
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * The table is created at startup, but someone may drop it while the API is running (e.g. to
   * start over in pgAdmin). Rather than failing every request until a restart, recreate it once.
   */
  private async query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    try {
      return await this.pool.query<R>(text, values);
    } catch (error) {
      if ((error as { code?: unknown }).code !== UNDEFINED_TABLE) throw error;
      this.log(`table ${this.table} was missing (dropped?), so it was created again`);
      await this.pool.query(createTableSql(this.table));
      return await this.pool.query<R>(text, values);
    }
  }
}

/** Creates the database named in the URL when it does not exist yet. Returns true if it did. */
async function createDatabaseIfMissing(connectionString: string): Promise<boolean> {
  const probe = new pg.Client({ connectionString });
  try {
    await probe.connect();
    return false;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "3D000") throw error; // anything but "database does not exist"
  } finally {
    await probe.end().catch(() => {});
  }
  const url = new URL(connectionString);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!IDENTIFIER.test(name)) throw new Error(`database "${name}" does not exist (and its name is not a plain identifier, so it was not created)`);
  url.pathname = "/postgres"; // the maintenance database every server has
  const admin = new pg.Client({ connectionString: url.toString() });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end().catch(() => {});
  }
  return true;
}

/** A readable reason a connection failed; a refused connection has an empty message but a code. */
export function describeDbError(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code === "ECONNREFUSED") return "connection refused (ECONNREFUSED): nothing is listening there, so PostgreSQL is probably not running";
  if (code === "ENOTFOUND") return "host not found (ENOTFOUND)";
  if (code === "28P01") return "wrong user name or password";
  if (code === "3D000") return `database does not exist (${String(message)})`;
  return String(message || code || error);
}

/** PostgreSQL's SQLSTATE for "relation does not exist". */
const UNDEFINED_TABLE = "42P01";

export function createTableSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  patient_id      text PRIMARY KEY,
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  dob             date NOT NULL,
  email           text,
  phone           text,
  account_balance numeric(14, 2),
  last_modified   timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
)`;
}
