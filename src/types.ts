/** Columns the legacy export must contain. Extra columns are tolerated and ignored. */
export const REQUIRED_COLUMNS = [
  "patient_id",
  "first_name",
  "last_name",
  "dob",
  "email",
  "phone",
  "account_balance",
  "last_modified",
] as const;

export type Column = (typeof REQUIRED_COLUMNS)[number];

/** A data row that passed structural checks: trimmed cell values keyed by column. */
export interface SourceRow {
  /** 1-based line number in the input file, so every outcome can be traced back to the export. */
  line: number;
  values: Record<Column, string>;
}

/** A patient exactly as sent to the SHC API (field names follow the legacy export). */
export interface PatientPayload {
  patient_id: string;
  first_name: string;
  last_name: string;
  /** ISO 8601 calendar date (YYYY-MM-DD). */
  dob: string;
  email: string | null;
  phone: string | null;
  account_balance: number | null;
  /** ISO 8601 timestamp in UTC. */
  last_modified: string;
}

export interface CleanRecord {
  payload: PatientPayload;
  sourceLine: number;
}

/** Something we repaired, assumed or want a person to confirm. The record was still loaded. */
export interface Issue {
  code: IssueCode;
  line: number;
  patientId: string | null;
  detail: string;
}

export type IssueCode =
  | "row_repaired"
  | "duplicate_superseded"
  | "duplicate_timestamp_tie"
  | "dob_ambiguous"
  | "missing_email"
  | "missing_phone"
  | "missing_account_balance"
  | "invalid_email_dropped"
  | "non_default_currency";

/** A row or patient we refused to send, with every reason we found. */
export interface Rejection {
  reason: "malformed_row" | "missing_patient_id" | "invalid_record" | "unresolvable_duplicate";
  patientId: string | null;
  errors: string[];
  /** Parsed values for rows we could map to columns, otherwise the raw line as it appears in the file. */
  rows: Array<{ line: number; values?: Record<string, string>; raw?: string }>;
}

/** Why the SHC API stage could not deliver a valid record. */
export type ApiFailureReason = "rejected_by_api" | "network_error" | "api_unavailable" | "api_timeout" | "not_attempted";

export type FailureReason = Rejection["reason"] | ApiFailureReason;

/**
 * The status_code written for each failure, modelled on HTTP status classes:
 *  - 4xx: the data itself is wrong. Sending it again gives the same error, so it must be
 *    corrected in the export and the job re-run.
 *  - 5xx: the data is fine but could not be delivered. It is safe to resend unchanged (--retry).
 * rejected_by_api has no fixed code: it carries the API's own 4xx status.
 */
export const FAILURE_STATUS_CODES: Record<Exclude<FailureReason, "rejected_by_api">, number> = {
  malformed_row: 400, // the CSV row's structure is broken (wrong number of fields, syntax error)
  missing_patient_id: 404, // no patient_id, so the row cannot be matched to a patient
  unresolvable_duplicate: 409, // several versions of a patient and we cannot tell which is current
  invalid_record: 422, // a required field is missing or unreadable (name, dob, balance...)
  network_error: 500, // no HTTP response at all on the last attempt (connection refused/reset, DNS)
  api_unavailable: 503, // the API kept answering 429/5xx until retries ran out
  api_timeout: 504, // the API did not answer within SHC_REQUEST_TIMEOUT_MS on the last attempt
  not_attempted: 503, // never sent: the run stopped first (API down, bad token, shutdown)
};

/** A failure with a 5xx status_code can be resent as-is; a 4xx one needs its data fixed. */
export function isRetryable(statusCode: number): boolean {
  return statusCode >= 500;
}

/**
 * One record that was not loaded. Validation failures go to validation_errors.json, API-stage
 * failures to failed_records.json.
 */
export interface FailureEntry {
  stage: "validation" | "api";
  reason: FailureReason;
  /** See FAILURE_STATUS_CODES: 4xx = fix the data, 5xx = safe to retry. */
  status_code: number;
  retryable: boolean;
  patient_id: string | null;
  source_lines: number[];
  /** Validation failures: every problem found. */
  errors?: string[];
  /** Validation failures: the rows as read from the file. */
  source_rows?: Rejection["rows"];
  /** API failures: the last HTTP status the API returned (null if it never answered). */
  http_status?: number | null;
  /** API failures: the API's response body, or a message when retries ran out. */
  detail?: unknown;
  batch?: string | null;
  /** API failures: the payload that was (or would have been) sent; --retry resends it. */
  record?: PatientPayload;
  logged_at: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
