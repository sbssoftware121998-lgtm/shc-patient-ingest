# GlobalHealth → SHC patient ingestion

A run-to-completion job that extracts GlobalHealth Corp's legacy patient CSV export, cleans it,
and loads it into the SHC Platform API (`POST /v1/patients`). It is written in TypeScript on
Node.js 22 and packaged as a container that runs inside GlobalHealth's own infrastructure.

```
patients.csv ─► extract ──────────► transform ─────────────► load ─────────────────► SHC API
                repair or reject     keep newest version      ≤100 records/request
                broken rows          normalize + validate     ≤5 requests/second
                                                              retry 429/5xx, isolate 400s
      │                     │                                  │
      └─► validation_errors.json (4xx: fix the data)   failed_records.json (API refused, or 5xx: failed)
                                   + ingest_report.json (counts and data-quality issues)
```

### How a run works, step by step

1. **Read the command line and configuration** (`index.ts`, `cli.ts`, `config.ts`). The input is always
   **`data/input/patients.csv`**: that exact location and name, never chosen on the command line. Everything else is read
   from environment variables and validated. A bad value stops the job before it touches any data (exit code 1).
2. **Skip what's already done** (`processed-files.ts`). Fingerprint the file (SHA-256 of its content). If that exact
   content was processed before, report that run's counts and stop without sending anything or touching `output/`.
3. **Extract** (`extract.ts`). Check the file exists under exactly that name, then stream the CSV, check the header, and turn each row into trimmed values keyed by column.
   Rows split by an unquoted `1,250.00` are repaired; rows that are still broken are rejected (400).
4. **Transform** (`transform.ts`, `normalize.ts`). Group rows by `patient_id`, keep the version with the newest
   `last_modified`, then normalize and validate it: dates to `YYYY-MM-DD`, balances to numbers, emails lower-cased, blanks
   to `null`. A patient that fails is held back (404/409/422) and written to `validation_errors.json`.
5. **Load** (`load.ts`). Send the valid patients in batches of ≤100, at ≤5 requests/second (`rate-limiter.ts`). 429/5xx
   and network errors are retried with exponential backoff. A 400 batch is split in half until the bad record is found.
   Whatever can't be delivered goes to `failed_records.json`.
6. **Report** (`pipeline.ts`). Write `ingest_report.json` and exit with `0` (all loaded), `2` (finished, some records not
   loaded) or `1` (stopped early).
7. **Retry later, by hand** (`retry.ts`). Nothing is retried automatically. A person reviews `output/failed_records.json`
   and copies it to the one fixed retry location, **`data/retry/failed_records.json`**. Then `failed` resends only its
   5xx entries, using the payloads saved there. Records that load are removed from that file, and what's still not
   loaded is also written to `output/failed_records.json`.

## How to run and test

There are two ways to run the job locally. Both use the **mock SHC API** in `mock-api/`, which stands in for the real
endpoint and stores the patients it receives in the PostgreSQL table **`global_health_client_patient_data_master`**
(created automatically if it doesn't exist, even if it's dropped while the API runs). Each run creates the `output/`
files from scratch, so you can delete them, and the table, at any time.

> **Quickest check: `npm test`.** In one command, with short output, it:
>
> 1. runs the 164 automated tests (they use temporary folders only);
> 2. does a real load: it creates the `output/` files from scratch and stores the patients in
>    `global_health_client_patient_data_master`, creating the table if it doesn't exist;
> 3. ends with the run summary and the number of rows now in the table.
>
> It is always local: it starts its own mock API for the run, on the PostgreSQL in `DATABASE_URL` (`.env`), and loads
> `data/input/patients.csv`.
> `npm run test:unit` runs only the test suite, with the full per-test output (for CI).

### The three commands

| Scenario | Local | Docker |
|---|---|---|
| Start once | `npm run mock-api` | `npm run docker:up` |
| Success | `npm run success` | `npm run docker:success` |
| Validation | `npm run validation` | `npm run docker:validation` |
| Failed | `npm run failed` | `npm run docker:failed` |

- **Success** loads `data/input/patients.csv`. On the same file again, it inserts nothing and says *Already processed*.
- **Validation** checks the file, sends nothing, and writes the correction sheet `output/data_correction.csv`.
- **Failed** resends the 5xx records in `data/retry/failed_records.json` and removes from it each record that loads.

Use **either** the Local column **or** the Docker column, not both at once (both use port 8080):

- **Local** stores patients in your local PostgreSQL, set by `DATABASE_URL` in `.env` (e.g. `localhost:5432`, database
  `shc_demo`; the database and table are created if missing). Run `npm run mock-api` in its own terminal and leave it
  running; stop it with Ctrl+C.
- **Docker** uses its own PostgreSQL container (`localhost:5433`, database `shc`). `npm run docker:down` stops it.

*Already processed* is tracked per setup: a file loaded through Docker can still be loaded locally, and the other way
round.

**Ready for a demo.** `data/input/patients.csv` starts as the 144-row test set, so every command has something to show:

1. `npm run success` loads 108 patients, holds back 22 with validation problems (400/404/409/422), and 3 are refused by
   the API (400). Run it again: *Already processed*.
2. `npm run validation` gives the same 22, written as `output/data_correction.csv`.
3. `npm run failed` resends the demo failure file. 6 of its 8 records are 5xx and resent: 5 load and are removed from the
   file, 1 is refused by the API (bad ID) and stays. The 2 records with 400 aren't resent. Run it again: *Nothing to
   resend*.

To repeat the demo: `cp data/samples/failed_records.json data/retry/failed_records.json` restores the failure file, and
deleting `output/processed_files.json` lets `success` load again. For a run where everything loads, use the brief's
9-row sample: `cp data/patients.csv data/input/patients.csv`, then `npm run success`.

**Rules that never change:**

- The input is always `data/input/patients.csv`. To load another export, copy it there with exactly that name.
- Retrying is always a manual step. `failed` reads only `data/retry/failed_records.json`, and the job never fills that
  file itself. After a real run, review `output/failed_records.json`, then copy it there.

| | Option A: without Docker | Option B: with Docker |
|---|---|---|
| Needs | Node.js ≥ 22.18, a local PostgreSQL (e.g. Postgres.app) | Docker (or Colima on a Mac) |
| PostgreSQL | your local server, `localhost:5432`, database `shc_demo` | a container, `localhost:5433`, database `shc` |
| Good for | development and running the test suite | running exactly what gets deployed |

Run every command from the project folder. Don't run Option A's mock API and Option B at the same time: both use port 8080.

### Option A: without Docker

**1. One-time setup**

1. Start PostgreSQL. In Postgres.app, open the app and click **Start** (or **Initialize** the first time).
   pgAdmin and the job can only connect while it's running.
2. Create the database `shc_demo`, either in pgAdmin (right-click **Databases** → **Create** → **Database…**, name
   `shc_demo`) or in a terminal:
   ```bash
   export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"   # Postgres.app's psql
   psql -d postgres -c "CREATE DATABASE shc_demo"
   ```
3. Install, build and create your local settings file:
   ```bash
   npm ci
   npm run build
   cp .env.example .env
   ```
4. In `.env`, uncomment `DATABASE_URL` and put in your PostgreSQL user. With Postgres.app that's your macOS username
   (`whoami`), with no password:
   ```
   DATABASE_URL=postgres://<your-mac-username>@localhost:5432/shc_demo
   ```

**2. Run the automated tests**

```bash
npm test                                                                    # tests, then a real load into PostgreSQL
npm run test:unit                                                           # only the 164 tests, full output
TEST_DATABASE_URL=postgres://<your-mac-username>@localhost:5432/shc_demo npm run test:unit   # + 4 PostgreSQL tests
```

The automated tests use temporary folders and their own temporary table (dropped afterwards). Only the second step of
`npm test` writes to `output/` and `global_health_client_patient_data_master`.

**3. Run the script (two terminals)**

Terminal 1 starts the mock SHC API and leaves it running. It says where patients are stored and whether it had to
create the table, then logs each request with what it did (`-> 200  stored 100 patient(s)`, `-> 400  rejected: …`):

```
storing patients in PostgreSQL table global_health_client_patient_data_master (database "shc_demo" on localhost:5432)
  table global_health_client_patient_data_master did not exist, so it was created (empty)
mock SHC API listening on http://127.0.0.1:8080/v1/patients
```

If it says `storing patients in memory` instead, `DATABASE_URL` isn't set in `.env`.

```bash
npm run mock-api
```

Terminal 2 runs the ingestion script. **The input is always `data/input/patients.csv`**: that exact folder and name
(`Patients.CSV` or `data/patients.csv` won't do). To load another export, copy it there first:

```bash
cp data/patients.csv data/input/patients.csv     # e.g. the brief's 9-row sample (the 144-row test set is there now)
npm run success; echo "exit code: $?"            # load it
npm run validation                               # check it only, send nothing
npm run success -- --force                       # load it again even though it was already processed
npm run failed                                   # resend the 5xx records in data/retry/failed_records.json
npm run success -- --help
```

The older flag spellings still work: `npm run ingest -- --validate` (or `--dry-run`) is `validation`, and
`npm run ingest -- --retry` is `failed`. `--force` only applies to `success`.

**Already processed?** Each finished load records the file's SHA-256 fingerprint in `output/processed_files.json`. If you
run the job again on exactly the same content, it doesn't send anything or touch `output/`. Instead it prints:

```
  RESULT: Already processed: this file was loaded before, so nothing was sent   (exit code 0)
  Input    : data/input/patients.csv has exactly the same content as the file loaded on 10/15/2026, 7:34:34 PM
  Nothing was sent to the API again, and the files in output/ are still those of that run.

  That run: 144 rows read · 130 patients found · 111 valid · 108 loaded into the SHC API
            22 held back by validation · 3 refused by the API · 0 not delivered

  Next steps:
    1. to load new records, copy the export over data/input/patients.csv, then:  npm run success
    2. to load this same file again anyway:  npm run success -- --force

  Ledger   : output/processed_files.json
```

Any change to the file (a corrected row, a newer export) makes it new content, so it's processed. `validation` runs and
stopped runs aren't recorded. Delete `output/processed_files.json` (or all of `output/`) to start fresh.

`npm run ingest` runs the TypeScript source directly. `npm start` does the same from the compiled `dist/` and rebuilds
it first, so it can't run stale code.

**What you see in the terminal.** The job says what it's about to do, logs its progress in readable lines, and ends
with a summary: the result, what was held back and why (grouped by status code), and **the exact commands to run
next**. For example:

```
──────────────────────────────────────────────────────────────────────────────
  RESULT: Finished, but some records were not loaded   (exit code 2)
──────────────────────────────────────────────────────────────────────────────
  Input    : data/input/patients.csv  (144 rows read)
  Patients : 130 found · 111 valid · 108 loaded into the SHC API

  ✗ 22 held back by validation: their data must be corrected
      400 malformed_row ×2 · 404 missing_patient_id ×1 · 409 unresolvable_duplicate ×1 · 422 invalid_record ×18
      Details         : output/validation_errors.json
      Correction sheet: output/data_correction.csv
                        (same columns as the export; the last columns say what is wrong)
  ✗ 3 refused by the SHC API: their data must be fixed
      400 rejected_by_api ×3
      Details  : output/failed_records.json ("detail" holds the API's error, "source_lines" the rows in the export)

  Next steps:
    1. correct the rows in output/data_correction.csv and save it
    2. copy it over data/input/patients.csv (keep the original export somewhere else first)
    3. check it:  npm run validation     then load it:  npm run success
    4. correct the 3 API-refused patient(s) in the export (rows in "source_lines"), then load it again

  Report   : output/ingest_report.json
──────────────────────────────────────────────────────────────────────────────
```

Configuration problems are explained the same way. A missing `.env`, for example, prints
`✗ Configuration error: SHC_API_TOKEN … is required` and `Fix: … cp .env.example .env`. The readable format is used
when the output goes to a terminal. When it's piped or collected (CI, production), logs stay JSON lines for log
systems. `SHC_LOG_FORMAT=pretty|json` forces one or the other.

Stop the mock API with Ctrl+C when you're done.

### Option B: with Docker

**1. One-time setup.** If Docker isn't installed on your Mac, Colima is a lightweight, command-line option:

```bash
brew install colima docker docker-compose docker-buildx
mkdir -p ~/.docker && echo '{"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]}' > ~/.docker/config.json
```

**2. Start Docker, PostgreSQL and the mock API.** Do this each session. They keep running, so pgAdmin can connect.

```bash
colima start --cpu 2 --memory 2
docker compose up -d --wait --build postgres mock-api
```

**3. Run the script** as often as you like. Each run builds the image if needed, runs the job once, and removes the
job's container.

The input is the same fixed file, **`data/input/patients.csv`**. `docker-compose.yml` mounts `./data/input` read-only
at the same place inside the container, so copy the export there first:

```bash
docker compose run --rm --build ingest success; echo "exit code: $?"   # load data/input/patients.csv
docker compose run --rm ingest validation                               # check only, send nothing
docker compose run --rm ingest success --force                          # load again although already processed
docker compose run --rm ingest failed                                   # resend the 5xx records in data/retry/failed_records.json
```

Inside the container, `./output` is `/data/output`. The end-of-run summary shows both paths. Local and Docker runs share
`output/processed_files.json`, so a file loaded one way is recognised the other way too.

To build and check just the production image:

```bash
docker build -t shc-patient-ingest:1.0.0 .
docker run --rm shc-patient-ingest:1.0.0     # no token set: prints a configuration error, exit code 1
```

**4. Clean up**

```bash
docker compose down         # stop everything; the data is kept
docker compose down -v      # stop everything and delete the database
colima stop                 # shut down the Docker VM
```

On Linux, `output/` must be writable by UID 1000 (the container user).

### Checking the results

| What | Where | 9-row sample | 144-row set |
|---|---|---|---|
| Exit code | `echo $?` | `0`: everything loaded | `2`: finished, some records need attention |
| Loaded patients | `global_health_client_patient_data_master` | 7 rows | 108 rows |
| Data to fix (4xx) | `output/validation_errors.json` | `[]` | 22 entries |
| Refused by / undeliverable to the API | `output/failed_records.json` | `[]` | 3 entries (400 `rejected_by_api`) |
| Run summary | `output/ingest_report.json` | `"status": "completed"` | `"status": "completed_with_failures"` |

Patients are upserted, so re-running doesn't duplicate them. Each full run rewrites the files in `output/`.
The expected result for every row of the 144-row set is listed in [`data/README.md`](data/README.md).

### Failure logs and status codes

Every record that was not loaded is one entry in one of two files, written as the run goes (each file is valid JSON at
every point). Each entry has a **`status_code`**, modelled on HTTP status classes, that says what to do next:

- **4xx: the data is wrong.** Sending it again gives the same error. Correct the rows at `source_lines` in the export
  and run the job again.
- **5xx: the data is fine but couldn't be delivered.** It's safe to resend as-is: `failed`.

| File | `status_code` | `reason` | Meaning | What to do |
|---|---|---|---|---|
| `validation_errors.json` | **400** | `malformed_row` | The CSV row's structure is broken: wrong number of fields that can't be repaired, or a CSV syntax error. | Fix the row, re-run |
| | **404** | `missing_patient_id` | The row has no `patient_id`, so it can't be matched to a patient. | Fix the row, re-run |
| | **409** | `unresolvable_duplicate` | A patient appears several times and a `last_modified` is unreadable, so we can't tell which version is current. | Fix the timestamps, re-run |
| | **422** | `invalid_record` | A required value is missing or unreadable: name, date of birth, balance, or the newest version's timestamp. | Fix the value, re-run |
| `failed_records.json` | **400 / 409 / 413 / 422** | `rejected_by_api` | The SHC API refused this record; `status_code` is the API's own status and `detail` its error. | Fix the data, re-run |
| | **500** | `network_error` | No HTTP response on every attempt: connection refused or reset, DNS failure. | `failed` |
| | **503** | `api_unavailable` | The API kept answering 429 or 5xx until the retries ran out (`http_status` has the last one). | `failed` |
| | **504** | `api_timeout` | No answer within `SHC_REQUEST_TIMEOUT_MS`, or a 408, on the last attempt. | `failed` |
| | **503** | `not_attempted` | Never sent, because the run stopped first: API down for 3 batches in a row, bad token or URL, or shutdown. | Fix the cause if any, then `failed` |

**Why two files?** They're acted on by different people, in different ways. Data owners fix what's in
`validation_errors.json` in the export and re-run. Operations resends what's in `failed_records.json` once the API or
network is healthy. `failed` only reads the reviewed copy in `data/retry/`. It removes the records that load from that
copy and writes the same list to `output/failed_records.json`. The brief asks for API 400s to be logged to
`failed_records.json`, and they are.

**Fixing validation errors with the CSV.** Every run with validation errors (including `validation`, which sends
nothing) also writes `output/data_correction.csv`. It holds one row per problem row, in the export's own columns,
followed by `error_status_code`, `error_reason`, `errors` (what to fix), `input_line` and `input_row`.

1. Open it in a spreadsheet and correct the values. A duplicated patient has all its versions in the file, so fix the
   one that's wrong. A `malformed_row` (400) couldn't be split into columns: only `patient_id` is filled in, and the
   original text is in `input_row`, so type its values into the columns. The error columns can stay: the job ignores
   columns it doesn't need.
2. Keep the original export somewhere else, then copy the corrected file over the input:
   `cp output/data_correction.csv data/input/patients.csv`.
3. Check it without sending anything: `npm run validation`.
4. Load it: `npm run success`. The fixed rows are loaded, and `data_correction.csv` is rewritten with only the rows
   that are still wrong, so you can repeat until it's gone.

A full run replaces `output/failed_records.json`, so copy it to `data/retry/` and run `failed` first if it still has 5xx
entries.

**Retrying is a manual, reviewed step, with the same fixed-file rule as the input.**

1. After a run, **review** `output/failed_records.json`: what failed, and why. Fix the cause (API down, network,
   credentials).
2. When you're sure the records should be resent, **copy** the file to `data/retry/failed_records.json`: exactly that
   location and name. The job never puts anything there itself, so this copy is the go-ahead.
   `failed` takes no file argument.
3. **Run** `npm run failed` (Docker: `docker compose run --rm ingest failed`).

`failed` doesn't read the CSV. It takes every entry with a 5xx `status_code` and resends the saved `record` payloads
(same batching, rate limit and backoff). Afterwards **`data/retry/failed_records.json` is updated in place**, and the same
list is written to `output/failed_records.json`:

- an entry that loads is **gone** from it;
- an entry that fails again stays, with its new `reason` and `status_code`;
- 4xx entries are carried over unchanged and are never resent.

So the retry file always lists exactly the records still not in the API. Running `failed` again resends only what still
needs it, and when only 4xx entries are left it reports *Nothing to resend*. Both files are written beside the old ones
and renamed over them at the end, so an interrupted retry never loses entries. A summary goes to `retry_report.json`,
and the exit code means the same as for a full run. Because the job writes to it, the retry folder must be writable
(by UID 1000 in the container). To repeat the demo, restore the original file:
`cp data/samples/failed_records.json data/retry/failed_records.json`.

| Field | Meaning |
|---|---|
| `stage` | `validation`: held back before sending. `api`: refused by, or undeliverable to, the SHC API. |
| `reason`, `status_code` | See the table above |
| `retryable` | `true` when `status_code` is 5xx |
| `patient_id` | null if the row had none |
| `source_lines` | Where the record is in the input file. A duplicated patient lists every version's line. |
| `errors` | Validation failures: every problem found |
| `source_rows` | Validation failures: the rows exactly as read from the file |
| `http_status`, `detail`, `batch`, `record` | API failures: the API's last HTTP status (null if it never answered), its response (or why it couldn't be reached), which batch, and the payload, which `failed` resends |
| `logged_at` | When it was recorded |

Useful commands (macOS ships `jq`):

```bash
jq -r 'group_by(.status_code)[] | "\(.[0].status_code)  \(.[0].reason)  ×\(length)"' output/validation_errors.json output/failed_records.json
jq '[.[] | select(.retryable)] | length' output/failed_records.json             # how many `failed` would resend
jq -r '.[] | [.status_code, .patient_id, (.source_lines|tostring), (.errors|join("; "))] | @tsv' output/validation_errors.json
jq '.[] | select(.patient_id == "P-2506")' output/validation_errors.json        # one record in full
```

### No rows in PostgreSQL?

The ingestion job never writes to PostgreSQL itself: it sends patients to the API, and the **mock API** stores them.
Work through these checks in order:

1. **Are you looking at the right server?** Docker's PostgreSQL is `localhost:5433`, database `shc` (user `shc`). Port
   5432 is a PostgreSQL installed on your Mac (Postgres.app), which only gets data in Option A.
2. **Is the mock API storing to PostgreSQL?** On startup it prints `storing patients in PostgreSQL table …`. If it
   says `storing patients in memory`, `DATABASE_URL` isn't set (Option A: set it in `.env`). Check with
   `docker compose logs mock-api | grep storing`.
3. **Did you run the job, or only the tests?** `npm run test:unit` never writes to the database. `npm test` and
   `npm run ingest` do. If the summary says **Already processed**, nothing was sent this time: use `--force`.
4. **Did the job actually send anything?** The summary's `Patients` line shows how many were loaded. If the job
   printed a `Configuration error` instead (e.g. no `.env`, so no `SHC_API_TOKEN`), it stopped before sending.
5. **Was the table dropped?** The mock API recreates it on startup or on the next request (it logs
   `table … was missing (dropped?), so it was created again`), so just re-run the job.
6. **Check from a terminal:**
   `docker compose exec postgres psql -U shc -d shc -c "SELECT count(*) FROM global_health_client_patient_data_master"`.

### Viewing the patient table in pgAdmin

**1. Make sure PostgreSQL is running.** For Option A, Postgres.app must show **Running**. For Option B, run
`colima start`, then `docker compose up -d postgres`. If nothing is running, pgAdmin shows no databases.

**2. Register the server** (one time per option): right-click **Servers** → **Register** → **Server…**

| Field | Option A (local PostgreSQL) | Option B (Docker) |
|---|---|---|
| General → Name | `SHC local` | `SHC docker` |
| Connection → Host name/address | `localhost` | `localhost` |
| Connection → Port | `5432` | `5433` |
| Connection → Maintenance database | `shc_demo` | `shc` |
| Connection → Username | your macOS username | `shc` |
| Connection → Password | *(empty)* | `local-demo-password` |

**3. Browse the table:** expand **Servers** → *your server* → **Databases** → `shc_demo` (or `shc`) → **Schemas** →
**public** → **Tables**, right-click **`global_health_client_patient_data_master`** → **View/Edit Data** → **All Rows**.
The table appears after the first run. If pgAdmin was already open, right-click **Tables** → **Refresh**.

**4. Run your own queries:** select the database, then **Tools** → **Query Tool**:

```sql
SELECT count(*) FROM global_health_client_patient_data_master;

SELECT patient_id, first_name, last_name, dob, email, phone, account_balance, last_modified, updated_at
FROM global_health_client_patient_data_master
ORDER BY patient_id;

-- examples of cleaned records: repaired balance, newest duplicate kept, ambiguous date
SELECT * FROM global_health_client_patient_data_master WHERE patient_id IN ('P-1002', 'P-1001', 'P-1005');
```

**5. To start from an empty table**, run `TRUNCATE global_health_client_patient_data_master;` in the Query Tool.
For Option B, `docker compose down -v` also deletes the database.

The same queries work from a terminal:

```bash
psql -d shc_demo -c "SELECT count(*) FROM global_health_client_patient_data_master"                        # Option A
docker compose exec postgres psql -U shc -d shc -c "SELECT count(*) FROM global_health_client_patient_data_master"   # Option B
```

### Production

On GlobalHealth's hosts, do a dry run first (`-e SHC_DRY_RUN=true`): it cleans and validates
everything, writes `cleaned_records.json` for review, and sends nothing.

```bash
docker build -t shc-patient-ingest:1.0.0 .
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e SHC_API_TOKEN_FILE=/run/secrets/shc_token \
  -v /secure/shc_token:/run/secrets/shc_token:ro \
  -v /exports/globalhealth:/app/data/input:ro \
  -v /exports/shc-output:/data/output \
  shc-patient-ingest:1.0.0       # reads /exports/globalhealth/patients.csv (always that name)
```

To resend failures after an outage, review `/exports/shc-output/failed_records.json` and copy it to a folder of its own,
e.g. `/exports/shc-retry/failed_records.json`. Then run the same command with `-v /exports/shc-retry:/app/data/retry`
and `failed` after the image name. The retry folder must be **writable by UID 1000** (not `:ro`), because the job
removes each record that loads from that file, so the same failures are never sent twice. Keep `/exports/shc-output`
between runs: its `processed_files.json` is what stops the same export from being loaded twice.

## Configuration

The input is always `data/input/patients.csv` (in the container: `/app/data/input/patients.csv`; mount the export folder
there). The command comes from the command line: `success` (the default), `validation` or `failed`, plus `--force`
with `success` (see `--help`).
Everything else comes from environment variables. Invalid values stop the job at startup with a message naming the variable.

| Variable | Default | Notes |
|---|---|---|
| `SHC_API_TOKEN` / `SHC_API_TOKEN_FILE` | required | Bearer token, or a path to a mounted secret holding it (preferred; env vars show up in `docker inspect`). Not needed for dry runs. |
| `SHC_API_URL` | `https://api.mock-shc.com/v1/patients` | Must be `https`… |
| `SHC_ALLOW_INSECURE_HTTP` | `false` | …unless this is set. It exists only for the local mock. |
| `SHC_INPUT_ENCODING` | `utf-8` | e.g. `windows-1252` for older exports. Invalid bytes stop the run instead of corrupting text. |
| `SHC_OUTPUT_DIR` | `/data/output` | Locally: `output` |
| `SHC_BATCH_SIZE` | `100` | 1–100 (the API maximum) |
| `SHC_RATE_LIMIT_PER_SECOND` | `5` | |
| `SHC_MAX_RETRIES` | `5` | Retries per request after the first attempt |
| `SHC_BACKOFF_BASE_MS` / `SHC_BACKOFF_MAX_MS` | `1000` / `30000` | |
| `SHC_REQUEST_TIMEOUT_MS` | `30000` | |
| `SHC_MAX_CONSECUTIVE_FAILED_BATCHES` | `3` | Stop when the API looks down instead of retrying every remaining batch |
| `SHC_DRY_RUN` | `false` | |
| `SHC_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SHC_LOG_FORMAT` | `auto` | `auto`: readable text plus a start banner and end-of-run summary at a terminal, JSON lines otherwise. `pretty` or `json` to force one. |

`NODE_EXTRA_CA_CERTS` adds a corporate CA bundle if outbound TLS is inspected.

## Outputs and exit codes

| File | Contents |
|---|---|
| `validation_errors.json` | Records held back because their data is wrong (4xx `status_code`): reason, every error found, source line numbers and the rows as read. |
| `failed_records.json` | Records the API refused (its 4xx) or that couldn't be delivered (5xx, retryable): reason, the API's response, and the payload. Both files are appended as the run goes and are valid JSON at every point, so a crash loses nothing. See [Failure logs and status codes](#failure-logs-and-status-codes). |
| `processed_files.json` | One entry per finished load: the input's SHA-256, when it ran, and its counts. A later run on identical content is skipped and reports these counts. Delete it to start fresh. |
| `retry_report.json` | `failed` runs only: how many entries were resent, loaded, still failing or kept. |
| `ingest_report.json` | Run status, counts, date-of-birth layouts found, and every data-quality issue (repaired rows, superseded duplicates, ambiguous dates, null-ed fields, non-USD symbols). |
| `data_correction.csv` | The rows held back by validation, in the export's own columns plus `error_status_code`, `error_reason`, `errors`, `input_line` and `input_row`. Correct the values and load the file again (see below). Removed when a run has no validation errors. |
| `cleaned_records.json` | `validation` and dry runs only: exactly what would be sent. |

Exit codes: `0` everything loaded · `2` finished, but some records need attention · `1` stopped early
(configuration, unreadable input, API refusing credentials or down) · `130` interrupted.

**PHI.** The output files contain patient data, so mount the output directory on access-controlled, encrypted storage.
Logs (JSON lines on stdout, or readable lines at a terminal) carry counts, line numbers, patient IDs and HTTP statuses only. They never contain names,
dates of birth, contact details or balances, so they are safe to ship to a central log system.

## Architecture decisions

- **Pure core, thin edges.** `extract.ts` reads the file, `transform.ts`/`normalize.ts` hold all cleaning rules
  as pure functions with no I/O, and `load.ts` talks HTTP. The loader takes an injectable `fetch` and clock, so retry,
  backoff and rate limiting are tested deterministically without waiting.
- **Minimal supply chain.** One runtime dependency (`csv-parse`). HTTP uses Node's built-in `fetch`, and tests use Node's
  built-in runner. Less to audit, scan and patch in a regulated environment.
- **Load, flag or hold back. Never guess silently.** Each patient is loaded as-is, loaded with a flagged
  change, or held back with every reason listed. Identity fields (names, date of birth) and money must be readable with
  certainty. Optional contact fields degrade to `null` (a bad email is dropped and flagged, not allowed to block the
  patient). A blank balance becomes `null`, never `0`.
- **Deduplicate before validating.** For each `patient_id`, keep the version with the latest `last_modified`
  (compared as UTC instants; a tie goes to the later row, flagged), then validate *that* version. If it is invalid the
  patient is held back. We never fall back to an older version, because that would load stale data as current. If any
  version's timestamp is unreadable, we can't know which is current, so the patient is held back too.
- **Repairing broken rows.** The export doesn't quote numbers, so `1,250.00` arrives as two fields and shifts the
  rest of the row. `account_balance` is the only column where commas are legitimate, so surplus fields are re-joined
  there, but only if the result is a correctly grouped amount. Otherwise the row is rejected. An unclosed quote stops
  the run, because it swallows every following row and skipping it would silently drop patients.
- **Batching and rate limiting.** Records go out in batches of ≤100, one request at a time: the API's 5 req/s limit is
  the bottleneck, so concurrency would add complexity and no throughput. A sliding-window limiter allows at most 5
  request starts in any rolling window, and it applies to every attempt, including retries and split batches. The window is
  1.1 s rather than 1 s: at exactly 1 s we measured occasional 429s from arrival-time jitter; with the headroom, none.
- **Error handling by status class.**

  | Response | Action |
  |---|---|
  | 2xx | Delivered |
  | 408, 429, 5xx, network error, timeout | Retry with exponential backoff and jitter (≈1 s, 2 s, 4 s… capped at 30 s; `Retry-After` honoured as a floor) |
  | 400, 409, 413, 422 | Split the batch in half and resend each half, recursively, until the offending records are isolated. They go to `failed_records.json` with the API's error and the run continues, so one bad record doesn't block 99 good ones. |
  | 401, 403, 404, 3xx, anything else | Stop: the integration is misconfigured and every request would fail the same way. Redirects are never followed, because a redirected POST silently becomes a GET. |

  If 3 consecutive batches exhaust their retries, the API is treated as down and the run stops, rather than grinding
  through every remaining batch. Whenever a run stops early, every valid record it didn't send is logged as
  `not_attempted` (503), so `failed` can finish the job once the cause is fixed.
- **Safe retries.** Each request carries an `Idempotency-Key` that is reused across its retries, so the API can discard a
  duplicate if an earlier attempt succeeded but its response was lost.
- **Graceful shutdown.** Node as PID 1 ignores SIGTERM by default, so `docker stop` would hang. On SIGTERM/SIGINT we
  finish the in-flight request, write the report and exit with 130.
- **Container.** The Dockerfile is multi-stage, so the compiler and dev dependencies never reach the runtime image. It uses a pinned base image,
  a numeric non-root user (Kubernetes `runAsNonRoot`-friendly), root-owned app files, and has npm/yarn removed. It works with
  `--read-only`, and an allow-list `.dockerignore` keeps data and `.env` files out of every image layer.

## Where the loaded data is stored

The ingestion job sends patients to the SHC API; storing them is the API's job. For local testing, the mock API
(`mock-api/`) stores them in memory, or in PostgreSQL when `DATABASE_URL` is set, in the table
`global_health_client_patient_data_master` (override with `MOCK_DB_TABLE`):

```sql
CREATE TABLE IF NOT EXISTS global_health_client_patient_data_master (
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
);
```

- Each API request is written with a single `INSERT … ON CONFLICT (patient_id) DO UPDATE` statement, so a batch is
  stored completely or not at all. A database error becomes a 500, which the job retries.
- Upserting on `patient_id` makes re-runs safe (still one row per patient). The update only applies when the incoming
  `last_modified` is not older than the stored one, so an older version never overwrites a newer one.
- Balances are stored with 2 decimal places; the mock API rejects amounts with more, rather than letting the
  database round them silently.

## Date parsing

The layout is decided by the **shape** of the value: the separator and where the 4-digit year sits. This follows the
formats GlobalHealth told us they use:

| Shape | Read as | Example |
|---|---|---|
| `YYYY-MM-DD` | ISO 8601 | `1980-05-15` → `1980-05-15` |
| `M/D/YYYY` (slashes) | US month/day | `12/31/1992` → `1992-12-31` |
| `D-M-YYYY` (dashes, year last) | day-month | `25-04-1975` → `1975-04-25` |

- **No format-guessing loop.** The common approach of "try formats until one parses" reads `04/05/1990` as April but
  `25/05/1990` as May, silently applying two conventions to one column.
- **Strict calendar check.** JavaScript's `Date` turns `02/30/1985` into March 2, so we validate day, month and
  leap year ourselves.
- **No fallback.** `13/01/1990` is invalid as MM/DD, so it is held back, not re-read as DD/MM. A slash date in day-first
  order means the convention doesn't hold for that source, so its other slash dates are suspect too. A person needs to look.
- **Ambiguity is flagged.** When the day is ≤ 12 and differs from the month (e.g. `07/04/1988`), both readings are real
  dates. We apply the convention and record `dob_ambiguous` in the report for the client to confirm.
- **Plausibility:** not in the future, not before 1900-01-01.
- **A useful cross-check.** P-1003 appears in the sample as `25-04-1975` and `04/25/1975`, and both normalize to `1975-04-25`.
- `last_modified` is ISO 8601. Offsets are converted to UTC, and a value without an offset is taken as UTC, not the
  container's local time.

## Tests

```bash
npm test             # the 164 tests (~10 s), then a real load with a readable summary (scripts/test-and-load.ts)
npm run test:unit    # only the tests, full output (+4 PostgreSQL tests when TEST_DATABASE_URL is set)
npm run typecheck
```

- **Unit:** every parser (dates, amounts, timestamps, emails); extraction (repairs, BOM/CRLF, windows-1252, invalid
  UTF-8, unclosed quotes, column order); dedupe and validation rules; rate limiter on a fake clock; retries, backoff,
  `Retry-After`, batch splitting, the circuit breaker, shutdown and fatal statuses via a fake `fetch`, and the
  `status_code` logged for each kind of failure; configuration and command-line options.
- **Fix-and-reload CSV** (`tests/error-csv.test.ts`): every held-back row is in `data_correction.csv` and readable by
  the job; a corrected row loads on the next run; the file is removed once nothing is wrong.
- **Fixed input and already-processed files** (`tests/cli.test.ts`, `tests/processed-files.test.ts`): no file can be
  given on the command line or via `SHC_INPUT_FILE`; a wrongly-cased name is rejected; the same content isn't loaded
  twice and output/ is left as it was; changed content or `--force` loads again; `validation` runs don't count.
- **Terminal messages** (`tests/summary.test.ts`): the readable log line, the end-of-run summary and its next steps,
  and the hint for a missing `.env`.
- **Retry** (`tests/retry.e2e.test.ts`): after the reviewed file is copied into place, an outage's network errors are
  loaded; the demo file `data/samples/failed_records.json` gives 5 loaded, 2 kept and 1 refused; 4xx entries are kept;
  a record that fails again is re-logged; loaded records are removed from the retry file, so a second run resends
  only what still failed; an interrupted retry keeps every entry; a missing retry file explains the manual step.
- **End-to-end** against the mock SHC API (`mock-api/server.ts`), which enforces auth, ≤100 records, 5 req/s with 429s
  and a stricter patient ID format, and injects 503s.
- **PostgreSQL** (`tests/postgres-store.e2e.test.ts`): runs only when `TEST_DATABASE_URL` is set. It loads the 144-row
  set into a temporary table (dropped afterwards), checks the typed columns, that a re-run leaves one row per patient,
  that the table is recreated if it's dropped while the API runs, and that an older version can't overwrite a newer one.
- **`data/patients_extended.csv`:** 144 hand-built rows, one scenario each, documented in
  [`data/README.md`](data/README.md). The test loads them at the real 5 req/s and asserts every outcome, including that
  the API never had to send a 429.

## Assumptions to confirm

- **Payload:** `{"patients": [...]}` with the export's field names, and `null` for missing values. `account_balance` is a JSON
  number, so `1250.00` serializes as `1250` (same value).
- **API semantics:** a 400 rejects the whole request (nothing stored), so resending halves is safe. POST upserts by
  `patient_id` and/or honours `Idempotency-Key`, so re-running the job after a partial failure is safe.
- **Currency:** balances are USD. Other currency symbols are loaded without conversion and flagged.
- **Date conventions:** slash dates are MM/DD/YYYY and dashed dates with a trailing year are DD-MM-YYYY, per the brief.

## Limitations and next steps

- The whole file is held in memory, because deduplication must see every version. That's fine into the millions of rows;
  beyond that, stage rows in SQLite.
- Literal placeholders such as `NULL` or `N/A` are treated as values. An `N/A` balance is held back; an `N/A` phone
  would pass through. We'll add rules once we've seen the full export.
- Outbound HTTP proxies aren't supported yet.
- The image has been built and run locally (Docker 29 on Colima): about 61 MB, runs as UID 1000, works with
  `--read-only --cap-drop ALL`, and a dry run on the 9-row sample gives the expected 7 patients. Before production, pin
  the base image by digest (`docker buildx imagetools inspect node:22.23.3-alpine3.24`) and scan it with the client's
  tooling.
