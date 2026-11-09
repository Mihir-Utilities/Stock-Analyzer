import { isPlainDecimal, plainString, toDec } from "@/lib/portfolio/decimal";

// Per-kind alert parameters (docs/03 section 13 table and B12-1: every field is required, prices
// and levels are JSON numbers, integers are whole numbers). The checks mirror
// `apps/api/internal/alerts/params.go` so the form rejects what the API would reject. Values are
// typed as text and checked with decimal arithmetic; a number is created only at the very end and
// only when it prints back to exactly the same digits (no binary rounding of a price).

export const ALERT_KINDS = [
  "price_above",
  "price_below",
  "day_change_pct",
  "wk52_high",
  "wk52_low",
  "ma_cross",
  "rsi_above",
  "rsi_below",
  "results_upcoming",
  "results_declared",
  "holding_change",
  "nav_above",
  "nav_below",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export function isAlertKind(v: string): v is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(v);
}

/** nav_* kinds apply to a mutual fund (scheme code), everything else to a stock (symbol). */
export function targetTypeFor(kind: AlertKind): "stock" | "mf" {
  return kind === "nav_above" || kind === "nav_below" ? "mf" : "stock";
}

export interface DecimalField {
  type: "decimal";
  key: string;
  label: string;
  unit: string;
  hint: string;
  min: string;
  max: string | null;
  /** True: the minimum itself is invalid ("greater than 0"). */
  exclusiveMin: boolean;
}
export interface IntField {
  type: "int";
  key: string;
  label: string;
  unit: string;
  hint: string;
  min: number;
  max: number;
}
export interface EnumField {
  type: "enum";
  key: string;
  label: string;
  hint: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}
export type ParamField = DecimalField | IntField | EnumField;

const price = (hint: string): DecimalField => ({
  type: "decimal",
  key: "price",
  label: "Price",
  unit: "INR",
  hint,
  min: "0",
  max: null,
  exclusiveMin: true,
});

const rsi = (hint: string): DecimalField => ({
  type: "decimal",
  key: "level",
  label: "RSI level",
  unit: "points",
  hint: `Between 1 and 99. ${hint}`,
  min: "1",
  max: "99",
  exclusiveMin: false,
});

const navField = (hint: string): DecimalField => ({
  type: "decimal",
  key: "nav",
  label: "NAV",
  unit: "INR",
  hint,
  min: "0",
  max: null,
  exclusiveMin: true,
});

export const KIND_FIELDS: Record<AlertKind, readonly ParamField[]> = {
  price_above: [price("Fires when the price rises to or above this level.")],
  price_below: [price("Fires when the price falls to or below this level.")],
  day_change_pct: [
    {
      type: "decimal",
      key: "pct",
      label: "Day change",
      unit: "%",
      hint: "Between 0.1 and 50, compared with the previous close.",
      min: "0.1",
      max: "50",
      exclusiveMin: false,
    },
    {
      type: "enum",
      key: "direction",
      label: "Direction",
      hint: "Which way the price has to move.",
      options: [
        { value: "up", label: "Up" },
        { value: "down", label: "Down" },
        { value: "either", label: "Either way" },
      ],
    },
  ],
  wk52_high: [],
  wk52_low: [],
  ma_cross: [
    {
      type: "int",
      key: "fast",
      label: "Fast average",
      unit: "days",
      hint: "Whole number from 5 to 100.",
      min: 5,
      max: 100,
    },
    {
      type: "int",
      key: "slow",
      label: "Slow average",
      unit: "days",
      hint: "Whole number from 20 to 300, greater than the fast average.",
      min: 20,
      max: 300,
    },
    {
      type: "enum",
      key: "direction",
      label: "Cross",
      hint: "Golden: fast above slow. Death: fast below slow.",
      options: [
        { value: "golden", label: "Golden cross" },
        { value: "death", label: "Death cross" },
      ],
    },
  ],
  rsi_above: [rsi("Fires when the 14-day RSI rises through this level.")],
  rsi_below: [rsi("Fires when the 14-day RSI falls through this level.")],
  results_upcoming: [
    {
      type: "int",
      key: "days_before",
      label: "Days before",
      unit: "days",
      hint: "Whole number from 1 to 14; needs a results date in the calendar.",
      min: 1,
      max: 14,
    },
  ],
  results_declared: [],
  holding_change: [
    {
      type: "enum",
      key: "holder",
      label: "Holder",
      hint: "Whose shareholding to watch.",
      options: [
        { value: "promoter", label: "Promoter" },
        { value: "fii", label: "FII" },
        { value: "dii", label: "DII" },
        { value: "mf", label: "Mutual funds" },
      ],
    },
    {
      type: "decimal",
      key: "delta_pct",
      label: "Change",
      unit: "percentage points",
      hint: "Between 0.1 and 20, from one quarter filing to the next.",
      min: "0.1",
      max: "20",
      exclusiveMin: false,
    },
  ],
  nav_above: [navField("Fires when the NAV rises to or above this value.")],
  nav_below: [navField("Fires when the NAV falls to or below this value.")],
};

export type ParamValue = number | string;
export type ParamErrors = Record<string, string>;

const MAX_DP = 4;

/** Text to JSON number, only when it prints back unchanged (15 significant digits at most). */
export function exactNumber(text: string): number | null {
  const t = text.trim();
  if (!isPlainDecimal(t, MAX_DP)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return plainString(String(n)) === plainString(t) ? n : null;
}

function decimalCheck(
  f: DecimalField,
  text: string,
): { error: string | null; value: number | null } {
  const t = text.trim();
  if (t === "") return { error: `Enter ${f.label.toLowerCase()}.`, value: null };
  if (!isPlainDecimal(t, MAX_DP)) {
    return {
      error: `${f.label} must be a plain number with at most ${MAX_DP} decimals, for example 4000 or 12.5.`,
      value: null,
    };
  }
  const d = toDec(t);
  const lo = toDec(f.min);
  const hi = f.max === null ? null : toDec(f.max);
  if (d === null || lo === null) return { error: `${f.label} is not a valid number.`, value: null };
  const tooLow = f.exclusiveMin ? d.lte(lo) : d.lt(lo);
  const tooHigh = hi !== null && d.gt(hi);
  if (tooLow || tooHigh) {
    return {
      error:
        hi === null
          ? `${f.label} must be greater than ${f.min}.`
          : `${f.label} must be between ${f.min} and ${f.max}.`,
      value: null,
    };
  }
  const n = exactNumber(t);
  if (n === null) return { error: `${f.label} has too many digits (15 at most).`, value: null };
  return { error: null, value: n };
}

/** Checks the typed values of one kind; returns the JSON params when there is no error. */
export function validateParams(
  kind: AlertKind,
  raw: Readonly<Record<string, string>>,
): { errors: ParamErrors; params: Record<string, ParamValue> | null } {
  const errors: ParamErrors = {};
  const params: Record<string, ParamValue> = {};
  for (const f of KIND_FIELDS[kind]) {
    const text = raw[f.key] ?? "";
    if (f.type === "decimal") {
      const r = decimalCheck(f, text);
      if (r.error) errors[f.key] = r.error;
      else if (r.value !== null) params[f.key] = r.value;
    } else if (f.type === "int") {
      const t = text.trim();
      if (t === "") errors[f.key] = `Enter ${f.label.toLowerCase()}.`;
      else if (!/^\d{1,6}$/.test(t)) errors[f.key] = `${f.label} must be a whole number.`;
      else if (Number(t) < f.min || Number(t) > f.max)
        errors[f.key] = `${f.label} must be between ${f.min} and ${f.max}.`;
      else params[f.key] = Number(t);
    } else if (f.options.some((o) => o.value === text)) {
      params[f.key] = text;
    } else {
      errors[f.key] = `Choose ${f.label.toLowerCase()}.`;
    }
  }
  if (
    kind === "ma_cross" &&
    !errors.fast &&
    !errors.slow &&
    Number(params.slow) <= Number(params.fast)
  ) {
    errors.slow = "Slow average must be greater than the fast average.";
  }
  return Object.keys(errors).length > 0 ? { errors, params: null } : { errors, params };
}

/** API param value back to the text of an input (edit form); never scientific notation. */
export function paramText(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return plainString(String(v));
  return typeof v === "string" ? v : "";
}

export interface TargetInput {
  symbol: string;
  code: string;
}

export function validateTarget(
  kind: AlertKind,
  t: TargetInput,
): { error: { field: "symbol" | "code"; message: string } | null; target: unknown } {
  if (targetTypeFor(kind) === "mf") {
    const c = t.code.trim();
    if (!/^\d{1,10}$/.test(c) || Number(c) < 1 || Number(c) > 2147483647) {
      return {
        error: { field: "code", message: "Enter the scheme code, a positive whole number." },
        target: null,
      };
    }
    return { error: null, target: { type: "mf", code: Number(c) } };
  }
  const s = t.symbol.trim();
  if (s === "" || s.length > 40) {
    return {
      error: { field: "symbol", message: "Enter the exchange symbol (1 to 40 characters)." },
      target: null,
    };
  }
  return { error: null, target: { type: "stock", symbol: s } };
}

/** Cooldown in minutes: empty means the API default; otherwise a whole number >= 0. */
export function validateCooldown(text: string): { error: string | null; value: number | null } {
  const t = text.trim();
  if (t === "") return { error: null, value: null };
  if (!/^\d{1,10}$/.test(t) || Number(t) > 2147483647)
    return { error: "Cooldown must be a whole number of minutes, 0 or more.", value: null };
  return { error: null, value: Number(t) };
}

/** Expiry date: empty means none; otherwise a real calendar date YYYY-MM-DD (no clock involved). */
export function validateExpiry(text: string): { error: string | null; value: string | null } {
  const t = text.trim();
  if (t === "") return { error: null, value: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m !== null) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) {
      return { error: null, value: t };
    }
  }
  return { error: "Use a real date as YYYY-MM-DD.", value: null };
}
