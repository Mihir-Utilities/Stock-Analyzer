// The only place numbers, dates and labels are turned into text (docs/06 section 3, CLAUDE.md).
// Every formatter returns { text, reason, direction }. An unknown value (null, undefined, NaN,
// +-Infinity) yields an em dash plus a reason for the tooltip, never "0", "NaN" or "Infinity"
// (UI-02). Pure functions: no Intl locale data, so output is identical on every machine.

export const DASH = "—";
export const RUPEE = "₹";

/** Reasons the spec names (docs/06 section 3). Callers may pass any other plain-English reason. */
export const NULL_REASONS = {
  noData: "no data",
  baseNegative: "n/m: base is negative",
  lossMaking: "loss making",
  noDataEntered: "no data entered",
  insufficientHistory: "insufficient history",
  awaitingEntry: "awaiting entry",
} as const;

export type Direction = "up" | "down" | "flat";
export type Grouping = "indian" | "western";

export interface Formatted {
  /** Display text; an em dash when the value is unknown. */
  text: string;
  /** Why the value is unknown (tooltip text); null when a value is shown. */
  reason: string | null;
  /** Sign of the underlying number after rounding, for the arrow; flat when zero or unknown. */
  direction: Direction;
}

export interface NullOpts {
  reason?: string;
}

let groupingPreference: Grouping = "indian";

/** Settings screen: western grouping (`1,234,567`) instead of lakh/crore grouping. */
export function setGroupingPreference(g: Grouping): void {
  groupingPreference = g;
}

export function getGroupingPreference(): Grouping {
  return groupingPreference;
}

export function unknown(reason: string = NULL_REASONS.noData): Formatted {
  return { text: DASH, reason, direction: "flat" };
}

function known(text: string, direction: Direction = "flat"): Formatted {
  return { text, reason: null, direction };
}

function isKnown(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

interface Parts {
  int: string;
  frac: string;
  zero: boolean;
}

/** Round half away from zero on the decimal value (1.005 -> 1.01), not on the binary float. */
function fixedParts(abs: number, decimals: number): Parts {
  let int: string;
  let frac: string;
  if (abs >= 1e15) {
    // Beyond 2^53 floats are whole numbers; BigInt prints them without an exponent.
    int = BigInt(Math.round(abs)).toString();
    frac = "0".repeat(decimals);
  } else {
    const scaled = Math.round(Number((abs * 10 ** decimals).toPrecision(15)));
    const digits = String(scaled).padStart(decimals + 1, "0");
    int = decimals === 0 ? digits : digits.slice(0, -decimals);
    frac = decimals === 0 ? "" : digits.slice(-decimals);
  }
  return { int, frac, zero: /^0*$/.test(int) && /^0*$/.test(frac) };
}

function group(int: string, grouping: Grouping): string {
  if (int.length <= 3) return int;
  if (grouping === "western") return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

interface Rendered {
  body: string;
  negative: boolean;
  direction: Direction;
}

function render(v: number, decimals: number, grouping: Grouping): Rendered {
  const p = fixedParts(Math.abs(v), decimals);
  const body = group(p.int, grouping) + (decimals > 0 ? `.${p.frac}` : "");
  // Negative zero and values that round to zero are neutral and unsigned.
  const negative = v < 0 && !p.zero;
  return { body, negative, direction: p.zero ? "flat" : negative ? "down" : "up" };
}

export interface NumberOpts extends NullOpts {
  decimals?: number;
  /** Defaults to the user preference (Indian). */
  grouping?: Grouping;
}

export function formatNumber(v: number | null | undefined, o: NumberOpts = {}): Formatted {
  if (!isKnown(v)) return unknown(o.reason);
  const r = render(v, o.decimals ?? 2, o.grouping ?? groupingPreference);
  return known(`${r.negative ? "-" : ""}${r.body}`, r.direction);
}

export function formatCount(
  v: number | null | undefined,
  o: NullOpts & { grouping?: Grouping } = {},
) {
  return formatNumber(v, { ...o, decimals: 0 });
}

/** `₹12,34,567.89`; negatives as `-₹1,234.50`. */
export function formatInr(v: number | null | undefined, o: NumberOpts = {}): Formatted {
  if (!isKnown(v)) return unknown(o.reason);
  const r = render(v, o.decimals ?? 2, o.grouping ?? groupingPreference);
  return known(`${r.negative ? "-" : ""}${RUPEE}${r.body}`, r.direction);
}

/** Crore amounts: `₹1,23,456 Cr`; from 1,00,000 Cr as `₹1.23 L Cr` (docs/06 section 3). */
export function formatCrore(
  v: number | null | undefined,
  o: NullOpts & { grouping?: Grouping } = {},
) {
  if (!isKnown(v)) return unknown(o.reason);
  const grouping = o.grouping ?? groupingPreference;
  const abs = Math.abs(v);
  // The tier follows the ROUNDED value, so 99,999.6 is `₹1.00 L Cr`, not `₹100,000 Cr`.
  // Below 1,000 Cr two decimals keep small values from reading as 0 (assumption F03-2).
  const roundedAbs = (decimals: number): number => {
    const p = fixedParts(abs, decimals);
    return Number(`${p.int}.${p.frac || "0"}`);
  };
  let decimals = abs >= 1000 ? 0 : 2;
  let rounded = roundedAbs(decimals);
  if (decimals === 2 && rounded >= 1000) {
    decimals = 0;
    rounded = roundedAbs(0);
  }
  const lakh = rounded >= 100000;
  const r = lakh ? render(v / 100000, 2, grouping) : render(v, decimals, grouping);
  return known(`${r.negative ? "-" : ""}${RUPEE}${r.body} ${lakh ? "L Cr" : "Cr"}`, r.direction);
}

/** Megabytes with a unit (`12.5 MB`); a value under 0.1 keeps two decimals so it is not read as 0. */
export function formatMb(
  v: number | null | undefined,
  o: NullOpts & { grouping?: Grouping } = {},
): Formatted {
  if (!isKnown(v)) return unknown(o.reason);
  const decimals = v !== 0 && Math.abs(v) < 0.1 ? 2 : 1;
  const r = render(v, decimals, o.grouping ?? groupingPreference);
  return known(`${r.negative ? "-" : ""}${r.body} MB`, r.direction);
}

/** A plain ratio such as an observed close ratio: `0.5002` (4 decimals unless told otherwise). */
export function formatRatio(
  v: number | null | undefined,
  o: NullOpts & { decimals?: number; grouping?: Grouping } = {},
): Formatted {
  if (!isKnown(v)) return unknown(o.reason);
  const r = render(v, o.decimals ?? 4, o.grouping ?? groupingPreference);
  return known(`${r.negative ? "-" : ""}${r.body}`, r.direction);
}

export interface PercentOpts extends NullOpts {
  decimals?: number;
  /** Defaults to the user preference (Indian). */
  grouping?: Grouping;
  /** Explicit `+` for gains (changes). Zero stays unsigned. */
  signed?: boolean;
}

/** Input is a percent number (12.34 = 12.34%), as every API percent field is. */
export function formatPercent(v: number | null | undefined, o: PercentOpts = {}): Formatted {
  if (!isKnown(v)) return unknown(o.reason);
  const r = render(v, o.decimals ?? 2, o.grouping ?? groupingPreference);
  const sign = r.negative ? "-" : o.signed && r.direction === "up" ? "+" : "";
  return known(`${sign}${r.body}%`, r.direction);
}

/** `part` as a percent of `whole` (1 decimal). An unknown or non-positive total is unknown. */
export function formatPercentOf(
  part: number | null | undefined,
  whole: number | null | undefined,
  o: PercentOpts = {},
): Formatted {
  if (!isKnown(part)) return unknown(o.reason);
  if (!isKnown(whole) || whole <= 0) return unknown(o.reason ?? "no total to compare with");
  return formatPercent((part / whole) * 100, { decimals: 1, ...o });
}

/** Input is a fraction (0.1234 = 12.34%): ML probabilities and `ret_q*` fields. */
export function formatFraction(v: number | null | undefined, o: PercentOpts = {}): Formatted {
  return formatPercent(isKnown(v) ? v * 100 : v, o);
}

/** `23.45x` */
export function formatMultiple(
  v: number | null | undefined,
  o: NullOpts & { decimals?: number; grouping?: Grouping } = {},
) {
  if (!isKnown(v)) return unknown(o.reason);
  const r = render(v, o.decimals ?? 2, o.grouping ?? groupingPreference);
  return known(`${r.negative ? "-" : ""}${r.body}x`, r.direction);
}

/** Adapts a formatter to the `(value) => string` shape chart axes and tooltips expect. */
export function asText(
  f: (v: number | null | undefined) => Formatted,
): (v: number | null | undefined) => string {
  return (v) => f(v).text;
}

// ---- dates (market dates are IST dates; instants are shown in IST) ------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * 60_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WITH_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parseDateOnly(s: string): Ymd | null {
  const m = DATE_ONLY.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function dateText(p: Ymd): string {
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** `10 Oct 2026` from `YYYY-MM-DD` (no timezone arithmetic) or an instant (shown as its IST date). */
export function formatDate(v: string | Date | null | undefined, o: NullOpts = {}): Formatted {
  if (v === null || v === undefined || v === "") return unknown(o.reason ?? NULL_REASONS.noData);
  if (typeof v === "string") {
    const p = parseDateOnly(v);
    if (p) return known(dateText(p));
  }
  const ist = toIst(v);
  if (!ist) return unknown(o.reason ?? "invalid date");
  return known(
    dateText({ y: ist.getUTCFullYear(), m: ist.getUTCMonth() + 1, d: ist.getUTCDate() }),
  );
}

/** A Date whose UTC fields hold the IST wall clock, or null if `v` is not a valid instant. */
function toIst(v: string | Date): Date | null {
  let t: number;
  if (v instanceof Date) t = v.getTime();
  else if (WITH_OFFSET.test(v)) t = Date.parse(v);
  else return null; // a timestamp without an offset is ambiguous; never guess the zone
  if (!Number.isFinite(t)) return null;
  return new Date(t + IST_OFFSET_MS);
}

/** `10 Oct 2026, 15:30 IST` */
export function formatDateTime(v: string | Date | null | undefined, o: NullOpts = {}): Formatted {
  if (v === null || v === undefined || v === "") return unknown(o.reason ?? NULL_REASONS.noData);
  const ist = toIst(v);
  if (!ist) return unknown(o.reason ?? "invalid date");
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  const date = dateText({ y: ist.getUTCFullYear(), m: ist.getUTCMonth() + 1, d: ist.getUTCDate() });
  return known(`${date}, ${hh}:${mm} IST`);
}

/** `just now`, `5m ago`, `2h ago`, `3d ago`, `in 2h`; a plain date after 30 days. */
export function formatRelative(
  v: string | Date | null | undefined,
  now: Date = new Date(),
  o: NullOpts = {},
): Formatted {
  if (v === null || v === undefined || v === "") return unknown(o.reason ?? NULL_REASONS.noData);
  const ist = toIst(v);
  if (!ist) return unknown(o.reason ?? "invalid date");
  const diffS = (now.getTime() - (ist.getTime() - IST_OFFSET_MS)) / 1000;
  const abs = Math.abs(diffS);
  if (abs < 45) return known("just now");
  const future = diffS < 0;
  let amount: string;
  if (abs < 3600) amount = `${Math.max(1, Math.round(abs / 60))}m`;
  else if (abs < 86400) amount = `${Math.floor(abs / 3600)}h`;
  else if (abs <= 30 * 86400) amount = `${Math.floor(abs / 86400)}d`;
  else return formatDate(v);
  return known(future ? `in ${amount}` : `${amount} ago`);
}

// ---- fiscal labels (India FY ends 31 March; FY = year of the March end) -------------------

/** Fiscal year number: Apr 2026 - Mar 2027 is FY2027. `periodEnd` is `YYYY-MM-DD`. */
export function fiscalYear(periodEnd: string): number | null {
  const p = parseDateOnly(periodEnd);
  if (!p) return null;
  return p.m >= 4 ? p.y + 1 : p.y;
}

const QUARTER_BY_MONTH: Record<number, number> = { 6: 1, 9: 2, 12: 3, 3: 4 };

function fy2(fy: number): string {
  return `FY${String(fy % 100).padStart(2, "0")}`;
}

/** `Q2 FY27 (Sep 2026)`. Only quarter-end months (Jun, Sep, Dec, Mar) get a label. */
export function fiscalQuarterLabel(periodEnd: string | null | undefined, o: NullOpts = {}) {
  if (!periodEnd) return unknown(o.reason ?? NULL_REASONS.noData);
  const p = parseDateOnly(periodEnd);
  if (!p) return unknown("invalid period end");
  const q = QUARTER_BY_MONTH[p.m];
  if (q === undefined) return unknown("period end is not a fiscal quarter end");
  return known(`Q${q} ${fy2(fiscalYear(periodEnd) as number)} (${MONTHS[p.m - 1]} ${p.y})`);
}

/** `FY26 (Mar 2026)`. Only a March period end is an annual period. */
export function fiscalAnnualLabel(periodEnd: string | null | undefined, o: NullOpts = {}) {
  if (!periodEnd) return unknown(o.reason ?? NULL_REASONS.noData);
  const p = parseDateOnly(periodEnd);
  if (!p) return unknown("invalid period end");
  if (p.m !== 3) return unknown("period end is not a fiscal year end");
  return known(`${fy2(p.y)} (Mar ${p.y})`);
}

// ---- freshness (source + as-of) -----------------------------------------------------------

export interface Freshness {
  source: string;
  /** Formatted as-of date, or an em dash. */
  asOf: string;
  /** `AMFI NAV file, as of 9 Oct 2026` */
  text: string;
}

export function formatFreshness(v: { source: string; asOf: string | null | undefined }): Freshness {
  const d = formatDate(v.asOf);
  return {
    source: v.source,
    asOf: d.text,
    text: `${v.source}, as of ${d.reason === null ? d.text : "unknown"}`,
  };
}
