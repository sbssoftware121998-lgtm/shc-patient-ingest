import {
  FieldError,
  cleanText,
  normalizeEmail,
  parseDob,
  parseMoney,
  parseTimestamp,
  type DateFormat,
  type ParsedDate,
  type ParsedTimestamp,
} from "./normalize.ts";
import {
  errorMessage,
  type CleanRecord,
  type Issue,
  type IssueCode,
  type PatientPayload,
  type Rejection,
  type SourceRow,
} from "./types.ts";

/** Balances are assumed to be USD. Other currency symbols are loaded without conversion but flagged. */
export const DEFAULT_CURRENCY_SYMBOL = "$";

export interface TransformResult {
  records: CleanRecord[];
  rejected: Rejection[];
  issues: Issue[];
  distinctPatients: number;
  supersededRows: number;
  /** Source layout of each loaded date of birth. */
  dobFormats: Partial<Record<DateFormat, number>>;
}

/**
 * Turns raw rows into one clean record per patient:
 *  1. group rows by patient_id;
 *  2. keep the most recently modified version of each patient;
 *  3. normalize and validate that version. If it is invalid the patient is held back. We
 *     never fall back to an older version, because that would load stale data as current.
 */
export function transform(rows: readonly SourceRow[], options: { today: string }): TransformResult {
  const result: TransformResult = {
    records: [],
    rejected: [],
    issues: [],
    distinctPatients: 0,
    supersededRows: 0,
    dobFormats: {},
  };

  const versionsByPatient = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const patientId = row.values.patient_id;
    if (!patientId) {
      result.rejected.push({ reason: "missing_patient_id", patientId: null, errors: ["patient_id is missing"], rows: [row] });
      continue;
    }
    const versions = versionsByPatient.get(patientId);
    if (versions) versions.push(row);
    else versionsByPatient.set(patientId, [row]);
  }
  result.distinctPatients = versionsByPatient.size;

  for (const [patientId, versions] of versionsByPatient) {
    const selection = selectCurrentVersion(versions);
    if ("errors" in selection) {
      result.rejected.push({
        reason: versions.length > 1 ? "unresolvable_duplicate" : "invalid_record",
        patientId,
        errors: selection.errors,
        rows: versions,
      });
      continue;
    }

    const { current, lastModified, superseded, tie } = selection;
    const built = buildRecord(current, lastModified, options.today);
    if ("errors" in built) {
      const errors = [...built.errors];
      if (versions.length > 1) {
        errors.push(
          `this is the newest of ${versions.length} versions (line ${current.line}); older versions were not loaded in its place`,
        );
      }
      result.rejected.push({ reason: "invalid_record", patientId, errors, rows: versions });
      continue;
    }

    for (const old of superseded) {
      result.supersededRows += 1;
      result.issues.push({
        code: "duplicate_superseded",
        line: old.line,
        patientId,
        detail: `older version (last_modified ${old.values.last_modified}) replaced by line ${current.line} (last_modified ${lastModified.iso})`,
      });
    }
    if (tie) {
      result.issues.push({
        code: "duplicate_timestamp_tie",
        line: current.line,
        patientId,
        detail: `several versions share last_modified ${lastModified.iso}; kept the one that appears last in the file`,
      });
    }
    result.issues.push(...built.issues);
    result.dobFormats[built.dobFormat] = (result.dobFormats[built.dobFormat] ?? 0) + 1;
    result.records.push({ payload: built.payload, sourceLine: current.line });
  }

  return result;
}

type Selection =
  | { current: SourceRow; lastModified: ParsedTimestamp; superseded: SourceRow[]; tie: boolean }
  | { errors: string[] };

/**
 * Picks the most recently modified version of a patient; a tie goes to the row that appears
 * later in the file. If any version's last_modified is unreadable we cannot know which one is
 * current, so the patient is held back rather than risk loading a stale version.
 */
function selectCurrentVersion(versions: readonly SourceRow[]): Selection {
  const stamped: Array<{ row: SourceRow; timestamp: ParsedTimestamp }> = [];
  const errors: string[] = [];
  for (const row of versions) {
    try {
      if (!row.values.last_modified) throw new FieldError("last_modified is missing");
      stamped.push({ row, timestamp: parseTimestamp(row.values.last_modified) });
    } catch (error) {
      errors.push(versions.length > 1 ? `line ${row.line}: ${errorMessage(error)}` : errorMessage(error));
    }
  }
  if (errors.length > 0) {
    if (versions.length > 1) errors.push("cannot tell which version is current, so none of them were loaded");
    return { errors };
  }

  stamped.sort((a, b) => a.timestamp.epochMs - b.timestamp.epochMs || a.row.line - b.row.line);
  const latest = stamped[stamped.length - 1]!;
  const runnerUp = stamped[stamped.length - 2];
  return {
    current: latest.row,
    lastModified: latest.timestamp,
    superseded: stamped.slice(0, -1).map(({ row }) => row),
    tie: runnerUp !== undefined && runnerUp.timestamp.epochMs === latest.timestamp.epochMs,
  };
}

type BuildResult = { payload: PatientPayload; issues: Issue[]; dobFormat: DateFormat } | { errors: string[] };

/**
 * Validation policy:
 *  - names and dob are required, and a value we cannot read with certainty holds the patient back;
 *  - account_balance may be blank (sent as null, never 0), but an unreadable amount holds the
 *    patient back: guessing at money is worse than asking;
 *  - contact details are optional: blank becomes null, and an invalid email is dropped to null
 *    (flagged, with the original value kept in the report) rather than blocking the patient.
 */
function buildRecord(row: SourceRow, lastModified: ParsedTimestamp, today: string): BuildResult {
  const values = row.values;
  const errors: string[] = [];
  const issues: Issue[] = [];
  const note = (code: IssueCode, detail: string) =>
    issues.push({ code, line: row.line, patientId: values.patient_id, detail });

  const firstName = cleanText(values.first_name);
  if (!firstName) errors.push("first_name is missing");
  const lastName = cleanText(values.last_name);
  if (!lastName) errors.push("last_name is missing");

  let dob: ParsedDate | null = null;
  if (!values.dob) {
    errors.push("dob is missing");
  } else {
    try {
      dob = parseDob(values.dob, today);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  let balance: number | null = null;
  if (!values.account_balance) {
    note("missing_account_balance", "account_balance is blank; sent as null (not 0)");
  } else {
    try {
      const money = parseMoney(values.account_balance);
      balance = money.amount;
      if (money.currencySymbol && money.currencySymbol !== DEFAULT_CURRENCY_SYMBOL) {
        note(
          "non_default_currency",
          `"${values.account_balance}" is in ${money.currencySymbol}, not ${DEFAULT_CURRENCY_SYMBOL}; loaded as ${money.amount} with no currency conversion`,
        );
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  if (errors.length > 0 || !firstName || !lastName || !dob) return { errors };

  if (dob.ambiguous) {
    note(
      "dob_ambiguous",
      `"${values.dob}" read as ${dob.format} = ${dob.iso}; swapping day and month would also be a valid date`,
    );
  }

  let email: string | null = null;
  if (!values.email) {
    note("missing_email", "email is blank; sent as null");
  } else {
    try {
      email = normalizeEmail(values.email);
    } catch {
      note("invalid_email_dropped", `"${values.email}" is not a valid email address; sent as null`);
    }
  }

  const phone = cleanText(values.phone);
  if (!phone) note("missing_phone", "phone is blank; sent as null");

  return {
    payload: {
      patient_id: values.patient_id,
      first_name: firstName,
      last_name: lastName,
      dob: dob.iso,
      email,
      phone,
      account_balance: balance,
      last_modified: lastModified.iso,
    },
    issues,
    dobFormat: dob.format,
  };
}
