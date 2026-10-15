# Test data

All names, contact details and balances are fictional.

| File | Data rows | Purpose |
|---|---|---|
| `input/patients.csv` | 144 | **The job's input**: the one file `npm run success` / `validation` read (and Docker). Starts as a copy of `patients_extended.csv`, so every command has something to show; copy any other export over it to load that instead. |
| `retry/failed_records.json` | 8 entries | **What `npm run failed` resends**, and removes from as records load. Starts as a copy of the demo file below. The job never fills it: in real use, review `output/failed_records.json` and copy it here. |
| `samples/failed_records.json` | 8 entries | Master copy of the demo failure file: one of each 5xx reason, two 400s that are kept, and one 504 the API refuses when resent. Copy it to `retry/` to run the demo again. |
| `patients.csv` | 9 | The sample from the assignment brief, unchanged. |
| `patients_extended.csv` | 144 | Hand-built test set: the brief's 9 rows plus 135 rows that each exercise one scenario. `tests/extended-dataset.e2e.test.ts` loads it into the mock API and asserts every outcome below. |

## Scenarios in `patients_extended.csv`

| Patient IDs | Scenario | Expected outcome |
|---|---|---|
| P-1001 – P-1007 | The brief's sample (unquoted `1,250.00`, mixed dates, `€`, duplicates, blanks) | Loaded; P-1001 and P-1003 keep their newest version |
| P-2001 – P-2050 | Clean records; balances as `"$1,686.85"`, `$23.45`, `46.90`, `"1,549.48"` | Loaded with no issues |
| P-2101 – P-2114 | Valid dates of birth: `12/31/1992`, `7/4/1988`, `05/05/1990`, `25-04-1975`, leap days `02/29/2000` and `29-02-1996`, the 1900-01-01 boundary, a newborn | Loaded; `7/4/1988`, `03/04/1990` and `03-04-1980` flagged `dob_ambiguous` (`05/05/1990` is not ambiguous) |
| P-2120 – P-2128 | Invalid dates of birth: `02/30/1985`, `13/01/1990` (no silent day/month swap), `31-04-1980`, `02/29/1999`, `1990/05/15`, `15.05.1990`, 2099, 1899, blank | Held back (`invalid_record`) |
| P-2201 – P-2213 | Balances: unquoted `1,250.00` and `$1,234,567.89` (row repaired), `$-15.00`, `-$20.00`, `(30.00)`, `€300.00`, `£75.25`, `" $ 45.00 "`, `.50`, `0`, blank, `100` | Loaded; `€`/`£` flagged `non_default_currency`; blank sent as `null` |
| P-2220 – P-2224 | Unreadable balances: `abc`, `"12,34"`, `1.2.3`, `N/A`, `--5.00` | Held back (`invalid_record`) |
| P-2225 | Unquoted `12,34`: extra comma that is not a thousands separator | Row rejected (`malformed_row`) |
| P-2301 – P-2310 | Contact details: blank email and/or phone, invalid emails `fiona.grant@` and `gavin lowe at example.com`, mixed-case email with spaces, padded phone, international phone | Loaded; blanks and invalid emails sent as `null` and flagged |
| P-2401 – P-2406 | Names: extra whitespace, `O'Brien`, `García-López`, `Zoë`, quoted `"Smith, Jr."`, the real surname `Null` | Loaded with names intact (whitespace collapsed) |
| P-2407 – P-2408 | Missing first or last name | Held back (`invalid_record`) |
| P-2501 – P-2505, P-2509 – P-2510 | Versions: newer row later / earlier in the file, three versions, identical timestamps, `+05:30` vs `Z` offsets, no offset (UTC assumed), space instead of `T` | Newest version loaded; P-2504 tie flagged and the later row kept |
| P-2506 | Newest version has an invalid date of birth | Held back; the older valid version is **not** loaded in its place |
| P-2507 | One version's `last_modified` is `yesterday` | Held back (`unresolvable_duplicate`): the current version can't be determined |
| P-2508 | `last_modified` of `2026-13-01T00:00:00Z` | Held back (`invalid_record`) |
| P-2601, blank ID, ` P-2602 ` | Too few fields, missing `patient_id`, ID with surrounding spaces; plus one blank line | Rows rejected / rows rejected / loaded as `P-2602`; the blank line is skipped |
| TMP-0042, GH-7781, p-2701 | Valid locally, but the SHC API only accepts IDs like `P-1234` | Refused by the API (HTTP 400), isolated by splitting the batch, logged with the API's error |

## Expected totals

- Rows: 144 read, 3 repaired, 3 rejected, 9 older versions superseded
- Patients: 130 found, 19 held back by validation, 111 sent, **108 loaded**, 3 refused by the API
- `validation_errors.json`: 22 entries (2 × 400 `malformed_row`, 1 × 404 `missing_patient_id`, 1 × 409 `unresolvable_duplicate`, 18 × 422 `invalid_record`)
- `failed_records.json`: 3 entries (3 × 400 `rejected_by_api`)
- `data_correction.csv`: 24 rows (the 22 records above; P-2506 and P-2507 have two versions each)
- Issues: 9 `duplicate_superseded`, 5 `missing_email`, 5 `missing_phone`, 4 `dob_ambiguous`, 3 `row_repaired`, 3 `non_default_currency`, 2 `invalid_email_dropped`, 1 `missing_account_balance`, 1 `duplicate_timestamp_tie`
- Date-of-birth layouts among the 111 valid patients: 96 `YYYY-MM-DD`, 9 `MM/DD/YYYY`, 6 `DD-MM-YYYY`
- Requests: 2 batches (100 + 11). The three refused records sit at positions 33 and 93 of batch 1 and position 11 of batch 2.
