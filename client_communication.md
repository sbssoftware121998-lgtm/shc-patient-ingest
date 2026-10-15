**To:** IT Director, GlobalHealth Corp
**From:** Sunil Bhavlal Sarsande, Forward Deployed Engineer, SHC Technologies (sunilsarsande1998@gmail.com)
**Subject:** Patient data migration: ingestion container ready for your environment

Dear IT Director,

The job that migrates your legacy patient data into the SHC Platform is ready to run inside your infrastructure. Below is how to run it, what we found in the sample export, and one change on your side that would make future loads more reliable.

**Building and running the container**

It is a single container. It needs read access to the export, a writable output folder, and outbound HTTPS to the SHC API.

```bash
docker build -t shc-patient-ingest:1.0.0 .

# 1. Dry run: cleans and validates the export, sends nothing to SHC
docker run --rm -e SHC_DRY_RUN=true \
  -v /path/to/export:/app/data/input:ro -v /path/to/output:/data/output \
  shc-patient-ingest:1.0.0

# 2. Live run
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e SHC_API_TOKEN_FILE=/run/secrets/shc_token \
  -v /path/to/shc_token:/run/secrets/shc_token:ro \
  -v /path/to/export:/app/data/input:ro -v /path/to/output:/data/output \
  shc-patient-ingest:1.0.0
```

- The job always reads one file: `patients.csv` in the export folder you mount (that exact name). There is nothing to choose, so it can't pick up the wrong file.
- If the same export is run twice, the second run sends nothing and reports the first run's counts, so a file can't be loaded twice by accident. Please keep the output folder between runs, since it holds that record.
- The API token is read from a mounted secret file and is never stored in the image.
- The container runs as a non-root user and writes only to the output folder:
  - `ingest_report.json` lists every data-quality item for your team to review.
  - `validation_errors.json` lists records held back because their data needs correcting, and why.
  - `failed_records.json` lists records the SHC API refused or could not be reached for. Those caused by a network or API outage can be resent on their own: once your team has reviewed the file, copy it into the retry folder and run the job with the `failed` command. Each record that loads is removed from that file, and nothing is ever resent automatically.
- Both files contain patient data, so please keep that folder on access-controlled storage.
- Exit code 0 means everything loaded. Exit code 2 means some records need attention.

**What we found in the sample export (9 rows, 7 patients, all loaded)**

- **Shifted columns:** one balance (`1,250.00`) was written without quotes, so its comma split the field and pushed the rest of the row out of place. The job detects and repairs this pattern. Any row it cannot repair with certainty is set aside rather than guessed at.
- **Duplicates:** two patients appear twice. We keep the most recently modified version, wherever it sits in the file.
- **Dates of birth in three formats:** all are converted to YYYY-MM-DD. Slash dates are read as month/day/year and dashed dates as day-month-year, as your team described. One record (P-1005) has a date where day and month could be swapped, as in `03/04/1990`. We read it as month/day. It is flagged in the report for your confirmation.
- **Balances** with `$`, `€`, thousands separators and a negative value are loaded as plain numbers. P-1003's latest balance uses `€` where its previous version used `$` for the same amount. We loaded the amount without conversion; please confirm which currency is correct.
- **Missing contact details:** two patients have no email and two have no phone number. They are loaded with those fields empty rather than held back.

**One recommended change to the export**

Please have the export write all dates in ISO 8601 format (YYYY-MM-DD). Everything else in the file we can correct reliably on our side, but software cannot tell whether 03/04/1990 means March or April. Date of birth is one of the main fields used to match patients, so a misread could attach records to the wrong person. Fixing the format at the source removes that risk for every future load.

To keep patient details out of email, I have referred to records by ID only. The specifics are in the report on your servers. I'm happy to walk your team through a dry run on the full export, or to adapt anything to your deployment standards.

Best regards,
Sunil Bhavlal Sarsande
Forward Deployed Engineer, SHC Technologies
sunilsarsande1998@gmail.com
