// Client-side mirror of the importer validators for the manual forms (IMP-17 parity, decision D-P).
// The Go API (`apps/api/internal/importers/values.go`, `periods.go`) stays authoritative: these
// checks give the same messages before a request is sent, and server `details.fields` messages are
// still shown as returned. Numbers are sent as cleaned numeric strings (the API accepts them), so
// no float rounding happens in the browser.

export const DATE_HELP = "use YYYY-MM-DD, DD-MM-YYYY or DD-Mon-YYYY";
const DATE_FLOOR = "1990-01-01";

const RE_PLAIN = /^[0-9]+(\.[0-9]+)?$/;
const RE_INTL = /^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;
const RE_INDIAN = /^[1-9]\d?(,\d{2})+,\d{3}(\.\d+)?$/;
const RE_LEAD_ZERO = /^0+,\d+$/;
const RE_EUROPEAN = /^\d{1,3}(\.\d{3})+,\d+$/;
const RE_EXPONENT = /^[0-9]+(\.[0-9]+)?[eE][+-]?[0-9]+$/;

/** Result of one cell: a cleaned numeric string, `null` for an empty cell, or an error message. */
export type Cell = { ok: true; value: string | null } | { ok: false; message: string };

/** Same rules as `CleanNumber` in the API: a comma only as a thousands separator (D-P). */
export function cleanNumber(raw: string): Cell {
  let s = raw.trim();
  if (s === "") return { ok: true, value: null };
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1).trim();
  }
  let out: string;
  if (RE_PLAIN.test(s)) out = s;
  else if (RE_INTL.test(s) || RE_INDIAN.test(s)) out = s.replaceAll(",", "");
  else if (s.includes(",")) {
    const hint = RE_EUROPEAN.test(s) || RE_LEAD_ZERO.test(s) ? " (looks like a decimal comma)" : "";
    return {
      ok: false,
      message: `"${raw}" is ambiguous${hint}: a comma is only accepted as a thousands separator (1,234.56 or 1,23,456.78); write the decimal point as '.'`,
    };
  } else if (RE_EXPONENT.test(s)) {
    return {
      ok: false,
      message: `"${raw}": exponent notation not accepted; write the number in full (for example 100000)`,
    };
  } else return { ok: false, message: `"${raw}" is not a number` };
  return { ok: true, value: neg ? `-${out}` : out };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function makeDate(raw: string, y: number, m: number, d: number): Cell {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== m || t.getUTCDate() !== d) {
    return { ok: false, message: `"${raw}" is not a real calendar date` };
  }
  const iso = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
  if (iso < DATE_FLOOR) {
    return {
      ok: false,
      message: `"${raw}" is before ${DATE_FLOOR}, the earliest accepted date`,
    };
  }
  return { ok: true, value: iso };
}

/** Accepts YYYY-MM-DD, DD-MM-YYYY and DD-Mon-YYYY; `MM-DD-YYYY` is rejected. Returns ISO text. */
export function parseDate(raw: string): Cell {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };
  let g = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (g) return makeDate(raw, Number(g[1]), Number(g[2]), Number(g[3]));
  g = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (g) {
    const d = Number(g[1]);
    const m = Number(g[2]);
    if (m > 12 && d <= 12) {
      return {
        ok: false,
        message: `"${raw}" looks like MM-DD-YYYY, which is not accepted; ${DATE_HELP}`,
      };
    }
    return makeDate(raw, Number(g[3]), m, d);
  }
  g = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (g) {
    const mon = MONTHS[(g[2] ?? "").toLowerCase()];
    if (mon === undefined) {
      return { ok: false, message: `"${raw}" has an unknown month name; ${DATE_HELP}` };
    }
    return makeDate(raw, Number(g[3]), mon, Number(g[1]));
  }
  return { ok: false, message: `"${raw}" is not a recognised date; ${DATE_HELP}` };
}

/** Today's date in IST as `YYYY-MM-DD` (market dates are IST). */
export function todayIst(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export type FieldErrors = Record<string, string>;

function isQuarterEnd(iso: string): boolean {
  const md = iso.slice(5);
  return md === "03-31" || md === "06-30" || md === "09-30" || md === "12-31";
}

function requiredDate(
  field: string,
  raw: string,
  errs: FieldErrors,
  today: string,
  opts: { future: boolean } = { future: true },
): string | null {
  if (raw.trim() === "") {
    errs[field] = `${field} is required`;
    return null;
  }
  const d = parseDate(raw);
  if (!d.ok) {
    errs[field] = d.message;
    return null;
  }
  if (d.value !== null && opts.future && d.value > today) {
    errs[field] = `${d.value} is in the future`;
    return null;
  }
  return d.value;
}

export const RESULT_FIELDS = [
  "revenue",
  "ebitda",
  "operating_income",
  "other_income",
  "interest",
  "depreciation",
  "pbt",
  "tax",
  "net_profit",
  "eps",
] as const;
export type ResultField = (typeof RESULT_FIELDS)[number];

const MAX_REVENUE_CRORE = 1e7;
const MAX_ABS_EPS = 1e5;

export interface ResultsInput {
  basis: string;
  periodType: string;
  periodEnd: string;
  values: Record<ResultField, string>;
}
export interface ResultsBody {
  basis: "consolidated" | "standalone";
  period_type: "Q" | "A";
  period_end: string;
  values: Record<string, string | null>;
}

/** Same rules as `ValidatePeriod` and `checkMetric`. Keys of `errors` are form field names. */
export function validateResults(
  input: ResultsInput,
  today: string,
): { errors: FieldErrors; body: ResultsBody | null } {
  const errors: FieldErrors = {};
  if (input.basis !== "consolidated" && input.basis !== "standalone") {
    errors.basis = "basis is required (consolidated or standalone)";
  }
  if (input.periodType !== "Q" && input.periodType !== "A") {
    errors.period_type = "period_type is required (Q or A)";
  }
  const end = requiredDate("period_end", input.periodEnd, errors, today);
  if (end && input.periodType === "Q" && !isQuarterEnd(end)) {
    errors.period_end = `${end} is not a calendar quarter end (31 Mar, 30 Jun, 30 Sep or 31 Dec)`;
  }
  const values: Record<string, string | null> = {};
  let any = false;
  for (const key of RESULT_FIELDS) {
    const c = cleanNumber(input.values[key]);
    if (!c.ok) {
      errors[key] = c.message;
      continue;
    }
    values[key] = c.value;
    if (c.value === null) continue;
    any = true;
    const n = Number(c.value);
    if (key === "revenue" && n >= MAX_REVENUE_CRORE) {
      errors[key] = `revenue ${n} is not below 1e7 crore; check the units (INR crore, not INR)`;
    }
    if (key === "eps" && Math.abs(n) > MAX_ABS_EPS) {
      errors[key] = `eps ${n} is outside +/-100000; EPS is in INR per share`;
    }
  }
  if (!any && RESULT_FIELDS.every((k) => input.values[k].trim() === "")) {
    errors.values = "Enter at least one value.";
  }
  if (Object.keys(errors).length > 0 || end === null) return { errors, body: null };
  return {
    errors,
    body: {
      basis: input.basis as ResultsBody["basis"],
      period_type: input.periodType as ResultsBody["period_type"],
      period_end: end,
      values,
    },
  };
}

export const HOLDING_FIELDS = [
  "promoter",
  "fii",
  "dii",
  "mf",
  "insurance",
  "govt",
  "public",
  "pledged_of_promoter",
] as const;
export type HoldingField = (typeof HOLDING_FIELDS)[number];

export interface ShareholdingInput {
  quarterEnd: string;
  filedOn: string;
  count: string;
  pct: Record<HoldingField, string>;
}

/** Same rules as `ValidateShareholding` (percent 0-100, sums, whole share count). */
export function validateShareholding(
  input: ShareholdingInput,
  today: string,
): { errors: FieldErrors; body: Record<string, string | null> | null } {
  const errors: FieldErrors = {};
  const quarter = requiredDate("quarter_end", input.quarterEnd, errors, today);
  if (quarter && !isQuarterEnd(quarter)) {
    errors.quarter_end = `${quarter} is not a calendar quarter end (31 Mar, 30 Jun, 30 Sep or 31 Dec)`;
  }
  const nums: Partial<Record<HoldingField, number>> = {};
  const body: Record<string, string | null> = {};
  for (const f of HOLDING_FIELDS) {
    const c = cleanNumber(input.pct[f]);
    if (!c.ok) {
      errors[f] = c.message;
      continue;
    }
    body[f] = c.value;
    if (c.value === null) continue;
    const n = Number(c.value);
    if (n < 0 || n > 100) {
      errors[f] = `${f} must be between 0 and 100 (a percent number)`;
    } else nums[f] = n;
  }
  const count = cleanNumber(input.count);
  if (!count.ok) errors.shareholders_count = count.message;
  else if (count.value !== null) {
    const whole = count.value.includes(".") ? count.value.replace(/\.0+$/, "") : count.value;
    if (/\.\d/.test(whole)) errors.shareholders_count = `"${input.count}" must be a whole number`;
    else if (Number(whole) < 0 || Number(whole) > 2147483647) {
      errors.shareholders_count = "shareholders_count must be a whole number of 0 or more";
    } else body.shareholders_count = whole;
  } else body.shareholders_count = null;
  let filed: string | null = null;
  if (input.filedOn.trim() !== "") {
    const d = parseDate(input.filedOn);
    if (!d.ok) errors.filed_on = d.message;
    else filed = d.value;
  }
  if (Object.keys(errors).length === 0) {
    const { promoter, fii, dii, govt, public: pub, mf, insurance } = nums;
    if (
      promoter !== undefined &&
      fii !== undefined &&
      dii !== undefined &&
      govt !== undefined &&
      pub !== undefined
    ) {
      const sum = promoter + fii + dii + govt + pub;
      if (Math.abs(sum - 100) > 1.0) {
        errors.promoter = `promoter + fii + dii + govt + public = ${sum.toFixed(2)}; it must be 100 +/- 1.0`;
      }
    }
    if (
      mf !== undefined &&
      insurance !== undefined &&
      dii !== undefined &&
      mf + insurance > dii + 0.5
    ) {
      errors.mf = `mf + insurance = ${(mf + insurance).toFixed(2)} exceeds dii ${dii.toFixed(2)} (they are components of dii)`;
    }
  }
  if (Object.keys(errors).length > 0 || quarter === null) return { errors, body: null };
  return { errors, body: { quarter_end: quarter, ...body, filed_on: filed } };
}

export const ACTION_TYPES = [
  "split",
  "bonus",
  "dividend",
  "rights",
  "buyback",
  "merger",
  "demerger",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
const MAX_PURPOSE = 500;

export interface ActionInput {
  exDate: string;
  type: string;
  ratioNum: string;
  ratioDen: string;
  amount: string;
  purpose: string;
}

function decimalCell(
  field: string,
  raw: string,
  dp: number,
  limit: number,
  errors: FieldErrors,
): string | null {
  const c = cleanNumber(raw);
  if (!c.ok) {
    errors[field] = c.message;
    return null;
  }
  if (c.value === null) return null;
  const n = Number(c.value);
  const decimals = c.value.split(".")[1] ?? "";
  if (!(n > 0)) errors[field] = `${field} must be greater than 0`;
  else if (decimals.replace(/0+$/, "").length > dp) {
    errors[field] = `${field} may have at most ${dp} decimal places`;
  } else if (n >= limit) errors[field] = `${field} is too large`;
  else return c.value;
  return null;
}

/** Same rules as `ValidateAction`. A future ex-date is accepted (ACT-10). */
export function validateAction(input: ActionInput): {
  errors: FieldErrors;
  body: Record<string, string | null> | null;
} {
  const errors: FieldErrors = {};
  const exDate = requiredDate("ex_date", input.exDate, errors, "", { future: false });
  const type = input.type.trim().toLowerCase();
  if (type === "") errors.type = "type is required";
  else if (!(ACTION_TYPES as readonly string[]).includes(type)) {
    errors.type = `type "${input.type}" must be one of ${ACTION_TYPES.join(", ")}`;
  }
  const num = decimalCell("ratio_num", input.ratioNum, 4, 100_000_000, errors);
  const den = decimalCell("ratio_den", input.ratioDen, 4, 100_000_000, errors);
  const amount = decimalCell("amount_per_share", input.amount, 4, 10_000_000_000, errors);
  const purpose = input.purpose.trim();
  if ([...purpose].length > MAX_PURPOSE) {
    errors.purpose_text = `purpose_text must be at most ${MAX_PURPOSE} characters`;
  }
  if (Object.keys(errors).length === 0) {
    const hasNum = input.ratioNum.trim() !== "";
    const hasDen = input.ratioDen.trim() !== "";
    if (type === "split" || type === "bonus") {
      if (!hasNum || !hasDen) {
        const what =
          type === "bonus"
            ? "ratio_num = new shares and ratio_den = shares held (1 and 1 for 1:1)"
            : "ratio_num = old face value and ratio_den = new face value (10 and 2 for 10 to 2)";
        errors.ratio_num = `${type} needs both ratios: ${what}`;
      } else if (type === "split" && num !== null && den !== null && Number(num) === Number(den)) {
        errors.ratio_num = "a split with equal ratios changes nothing";
      }
    } else if (type === "dividend") {
      if (amount === null) errors.amount_per_share = "a dividend needs amount_per_share";
    } else if (hasNum !== hasDen) {
      errors.ratio_num = "give ratio_num and ratio_den together or neither";
    }
  }
  if (Object.keys(errors).length > 0 || exDate === null) return { errors, body: null };
  return {
    errors,
    body: {
      ex_date: exDate,
      type,
      ratio_num: num,
      ratio_den: den,
      amount_per_share: amount,
      purpose_text: purpose === "" ? null : purpose,
    },
  };
}

/** Quarter label for a note hint is not needed; this guards the free-text note (<= 500). */
export function noteError(note: string): string | null {
  return [...note].length > 500 ? "The note may have at most 500 characters." : null;
}
