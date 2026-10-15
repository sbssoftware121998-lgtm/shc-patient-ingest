/**
 * Pure field parsers. Each returns a normalized value or throws FieldError. Error messages
 * name the problem but never echo the value, so they are safe to log; the raw values are
 * kept alongside them in failed_records.json.
 */

export class FieldError extends Error {
  override name = "FieldError";
}

/** Trims and collapses internal whitespace; an empty cell becomes null. Case is preserved. */
export function cleanText(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  return text === "" ? null : text;
}

// ---------------------------------------------------------------------------------------
// Dates of birth
// ---------------------------------------------------------------------------------------

export type DateFormat = "YYYY-MM-DD" | "MM/DD/YYYY" | "DD-MM-YYYY";

export interface ParsedDate {
  iso: string;
  format: DateFormat;
  /** True when swapping day and month would also give a valid (different) date, e.g. 07/04/1988. */
  ambiguous: boolean;
}

type DatePart = "year" | "month" | "day";

/**
 * The layouts GlobalHealth's export uses. The layout is decided by the shape of the value
 * (separator + where the 4-digit year sits), never by trying formats until one happens to
 * parse: that approach reads 04/05/1990 one way and 25/05/1990 another, silently.
 */
const DATE_LAYOUTS: ReadonlyArray<{ format: DateFormat; pattern: RegExp; order: readonly DatePart[] }> = [
  { format: "YYYY-MM-DD", pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: ["year", "month", "day"] },
  { format: "MM/DD/YYYY", pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ["month", "day", "year"] },
  { format: "DD-MM-YYYY", pattern: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ["day", "month", "year"] },
];

export const EARLIEST_PLAUSIBLE_DOB = "1900-01-01";

/**
 * Normalizes a date of birth to YYYY-MM-DD.
 * @param today ISO date used to reject future dates of birth.
 */
export function parseDob(raw: string, today: string): ParsedDate {
  const text = raw.trim();
  for (const { format, pattern, order } of DATE_LAYOUTS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const parts: Record<DatePart, number> = { year: 0, month: 0, day: 0 };
    order.forEach((part, index) => {
      parts[part] = Number(match[index + 1]);
    });
    const { year, month, day } = parts;

    // Not falling back to the other day/month order is deliberate: a slash date that is
    // invalid as MM/DD means this source doesn't follow the convention, so a person must check it.
    if (!isRealDate(year, month, day)) {
      throw new FieldError(`dob is not a real calendar date when read as ${format}`);
    }
    const iso = toIsoDate(year, month, day);
    if (iso > today) throw new FieldError("dob is in the future");
    if (iso < EARLIEST_PLAUSIBLE_DOB) throw new FieldError(`dob is before ${EARLIEST_PLAUSIBLE_DOB}`);

    const ambiguous = format !== "YYYY-MM-DD" && day <= 12 && day !== month;
    return { iso, format, ambiguous };
  }
  throw new FieldError("dob is not in a supported layout (YYYY-MM-DD, MM/DD/YYYY or DD-MM-YYYY)");
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day <= daysInMonth;
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------------------

export interface ParsedTimestamp {
  /** ISO 8601 in UTC, e.g. 2026-10-05T14:20:00Z. */
  iso: string;
  epochMs: number;
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parses an ISO 8601 timestamp. One without an offset is taken to be UTC (rather than the
 * host's local time zone, which would make results depend on where the container runs).
 */
export function parseTimestamp(raw: string): ParsedTimestamp {
  const match = ISO_TIMESTAMP.exec(raw.trim());
  if (!match) throw new FieldError("last_modified is not an ISO 8601 timestamp");

  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const second = Number(match[6] ?? 0);
  // JavaScript's Date quietly rolls 2026-02-30 over to March 2, so validate the calendar first.
  if (!isRealDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    throw new FieldError("last_modified is not a real date and time");
  }

  const fraction = (match[7] ?? "").slice(0, 4);
  const zone = (match[8] ?? "Z").toUpperCase();
  const offset = zone === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const epochMs = Date.parse(
    `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${fraction}${offset}`,
  );
  if (Number.isNaN(epochMs)) throw new FieldError("last_modified is not an ISO 8601 timestamp");

  return { iso: new Date(epochMs).toISOString().replace(".000Z", "Z"), epochMs };
}

// ---------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------

export interface ParsedMoney {
  amount: number;
  /** The currency symbol found in the value, if any (e.g. "$", "€"). */
  currencySymbol: string | null;
}

// sign? symbol? sign? digits symbol?  — \p{Sc} is any Unicode currency symbol.
const MONEY = /^([+-]?)\s*(\p{Sc}?)\s*([+-]?)\s*([\d.,]+)\s*(\p{Sc}?)$/u;
// Thousands separators must sit every three digits: "1,250.00" is fine, "12,50" is not.
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^\.\d+$/;

/**
 * Parses balances such as "$150.50", "€300.00", "1,250.00", "$-15.00", "-$15.00" or "(15.00)".
 * Anything we cannot read unambiguously is rejected rather than guessed.
 */
export function parseMoney(raw: string): ParsedMoney {
  let text = raw.trim();
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true; // accounting-style negative
    text = text.slice(1, -1).trim();
  }

  const match = MONEY.exec(text);
  if (!match) throw new FieldError("account_balance is not a number");
  const [, signBefore = "", leadingSymbol = "", signAfter = "", digits = "", trailingSymbol = ""] = match;
  if (signBefore && signAfter) throw new FieldError("account_balance has two signs");
  if (leadingSymbol && trailingSymbol) throw new FieldError("account_balance has two currency symbols");
  if (!AMOUNT.test(digits)) throw new FieldError("account_balance has malformed digit grouping");
  if ((signBefore || signAfter) === "-") {
    if (negative) throw new FieldError("account_balance has conflicting negative markers");
    negative = true;
  }

  const value = Number(digits.replaceAll(",", ""));
  return {
    amount: negative && value !== 0 ? -value : value, // avoid -0
    currencySymbol: leadingSymbol || trailingSymbol || null,
  };
}

// ---------------------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new FieldError("email is not a valid address");
  return email;
}
