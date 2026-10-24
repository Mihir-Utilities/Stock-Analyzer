import { formatDate, formatPercent, type Formatted } from "@/lib/format";
import type { Bar, CorporateAction, IndicatorsData, Quote, StockProfile } from "./schemas";

// Pure view logic for the stock header and Overview (docs/06 sections 4.2, 6.4, 9). Everything
// that becomes text goes through lib/format; nothing here invents a number.

/** API null-reason codes (docs/05, B05-1) as the plain words the UI shows. */
const REASONS: Record<string, string> = {
  insufficient_history: "insufficient history",
  insufficient_overlap: "insufficient overlap with the benchmark",
  no_benchmark: "no benchmark data imported",
  "n/m": "not meaningful",
  not_applicable: "not applicable",
  not_computed: "not computed yet",
  no_data_entered: "no data entered",
  insufficient_data: "insufficient data",
  universe_too_small: "not enough tracked stocks to rank against",
};

export function humanReason(code: string | null | undefined, fallback = "no data"): string {
  if (!code) return fallback;
  return REASONS[code] ?? code.replace(/_/g, " ");
}

// ---- header ---------------------------------------------------------------------------------

export interface HeaderPrice {
  /** `quote`: broker quote row; `last_close`: last imported bar; `none`: nothing to show. */
  kind: "quote" | "last_close" | "none";
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  /** Date or instant the price is as of (raw, formatted by the caller through lib/format). */
  asOf: string | null;
  source: string;
  reason: string | null;
}

/**
 * LTP for the header. A quote row (broker mode, or an owner-supplied `quote_latest`) wins. In
 * manual price mode there is usually none, so the last imported bar is shown as "Last close" with
 * the change against the bar before it (adjusted series; F05-1).
 */
export function headerPrice(profile: StockProfile, bars: ReadonlyArray<Bar> | null): HeaderPrice {
  const q: Quote | null | undefined = profile.quote;
  if (q && q.ltp !== null) {
    return {
      kind: "quote",
      ltp: q.ltp,
      change: q.change ?? null,
      changePct: q.change_pct ?? null,
      asOf: q.quote_ts ?? null,
      source: q.source ?? "quote",
      reason: null,
    };
  }
  const last = bars && bars.length > 0 ? bars[bars.length - 1] : undefined;
  if (last) {
    const prev = bars && bars.length > 1 ? bars[bars.length - 2] : undefined;
    const close = last[4];
    const change = prev ? close - prev[4] : null;
    const changePct = prev && prev[4] !== 0 ? (close / prev[4] - 1) * 100 : null;
    return {
      kind: "last_close",
      ltp: close,
      change,
      changePct,
      asOf: last[0],
      source: "Imported prices",
      reason: null,
    };
  }
  return {
    kind: "none",
    ltp: null,
    change: null,
    changePct: null,
    asOf: profile.freshness.prices_as_of,
    source: "Imported prices",
    reason: profile.flags.no_prices ? "no prices imported" : "price series not loaded",
  };
}

/** 52-week range: the quote's wk52 values when present, else the computed ones (docs/05 section 3). */
export function weekRange(
  profile: StockProfile,
  ind: IndicatorsData | null,
): { low: number | null; high: number | null; source: string } {
  const q = profile.quote;
  if (q && typeof q.wk52_low === "number" && typeof q.wk52_high === "number") {
    return { low: q.wk52_low, high: q.wk52_high, source: q.source ?? "quote" };
  }
  const lo = ind?.technicals["low_52w"];
  const hi = ind?.technicals["high_52w"];
  return {
    low: typeof lo === "number" ? lo : null,
    high: typeof hi === "number" ? hi : null,
    source: "computed from imported prices",
  };
}

export interface ImportChip {
  text: string;
  stale: boolean;
}

/** "Last price import: {bar date}", amber (stale) from `freshness.prices_stale` (D-L). */
export function importChip(profile: StockProfile): ImportChip {
  const d = formatDate(profile.freshness.prices_as_of, { reason: "no prices imported" });
  return {
    text: `Last price import: ${d.reason === null ? d.text : "none yet"}`,
    stale: profile.freshness.prices_stale,
  };
}

export interface Badge {
  id: string;
  text: string;
}

/** Status / series / kind badges (docs/06 section 8: status and flags -> badges). */
export function profileBadges(p: StockProfile): Badge[] {
  const out: Badge[] = [];
  if (p.status === "suspended") out.push({ id: "suspended", text: "Suspended" });
  if (p.status === "delisted") out.push({ id: "delisted", text: "Delisted" });
  if (p.status === "symbol_changed") out.push({ id: "symbol-changed", text: "Symbol changed" });
  if (p.instrument_kind !== "equity") out.push({ id: "kind", text: kindLabel(p.instrument_kind) });
  if (p.flags.series_warning) {
    out.push({ id: "series", text: `Series ${p.flags.series_warning}` });
  }
  return out;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "etf":
      return "ETF";
    case "reit":
      return "REIT";
    case "invit":
      return "InvIT";
    case "sme":
      return "SME";
    default:
      return "Other instrument";
  }
}

// ---- banners --------------------------------------------------------------------------------

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/** Dates of detected, unconfirmed corporate actions (from `UNCONFIRMED_ACTION` warnings). */
export function unconfirmedDates(warnings: ReadonlyArray<{ code: string; message: string }>) {
  const dates = new Set<string>();
  for (const w of warnings) {
    if (w.code !== "UNCONFIRMED_ACTION") continue;
    const m = ISO_DATE.exec(w.message);
    if (m) dates.add(m[0]);
  }
  return [...dates].sort();
}

/** Close-to-close change in percent on `date`, from the loaded bars; null when not computable. */
export function changeOn(bars: ReadonlyArray<Bar>, date: string): number | null {
  const i = bars.findIndex((b) => b[0] === date);
  const cur = bars[i];
  const prev = bars[i - 1];
  if (i < 1 || !cur || !prev || prev[4] === 0) return null;
  return (cur[4] / prev[4] - 1) * 100;
}

/**
 * Exact copy of docs/06 section 9: "Possible split or bonus on {date}: price changed {x}%. Confirm
 * to adjust history." When the day's change cannot be computed the clause is left out rather than
 * showing a made-up number (F05-6).
 */
export function unconfirmedCopy(date: string, changePct: number | null): string {
  const d = formatDate(date).text;
  if (changePct === null) {
    return `Possible split or bonus on ${d}. Confirm to adjust history.`;
  }
  const x: Formatted = formatPercent(changePct, { decimals: 1 });
  return `Possible split or bonus on ${d}: price changed ${x.text}. Confirm to adjust history.`;
}

/** Drop that triggers the softer notice (decision D-O: single-day close-to-close drop >= 20%). */
export const SOFT_FLAG_DROP_PCT = 20;

export interface SoftFlag {
  date: string;
  dropPct: number;
}

/**
 * Soft flag (D-O / D-U): drops of 20% or more that are neither a confirmed marker nor a detected
 * action. Computed from the bars the page already loaded, because no API field carries it yet
 * (F05-5). Dismissals are server-side (B07): see `lib/stock/soft-flag-adapter.ts`.
 */
export function softFlags(
  bars: ReadonlyArray<Bar>,
  covered: ReadonlySet<string>,
  dismissed: ReadonlySet<string> = new Set(),
): SoftFlag[] {
  const out: SoftFlag[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    if (!cur || !prev || prev[4] <= 0) continue;
    // Rounded so an exact 20% drop is not missed by float error (0.8 - 1 = -0.19999999999999996).
    const pct = Math.round((cur[4] / prev[4] - 1) * 100 * 1e6) / 1e6;
    if (pct <= -SOFT_FLAG_DROP_PCT && !covered.has(cur[0]) && !dismissed.has(cur[0])) {
      out.push({ date: cur[0], dropPct: pct });
    }
  }
  return out;
}

export function coveredDates(
  actions: ReadonlyArray<{ date: string }>,
  warnings: ReadonlyArray<{ code: string; message: string }>,
  events: ReadonlyArray<CorporateAction> | null,
): Set<string> {
  const s = new Set<string>(actions.map((a) => a.date));
  for (const d of unconfirmedDates(warnings)) s.add(d);
  for (const e of events ?? [])
    if (e.type.includes("split") || e.type === "bonus") s.add(e.ex_date);
  return s;
}

// ---- performance ----------------------------------------------------------------------------

export interface PerfRow {
  id: string;
  label: string;
  value: number | null;
  reason: string | null;
}

/** 1W..5Y price returns (percent numbers). 1W is the 5-row trading window, the rest calendar. */
export function performanceRows(ind: IndicatorsData): PerfRow[] {
  const reasons = ind.null_reasons ?? {};
  const cal = ind.returns.calendar;
  const week = ind.returns.trading?.["ret_1w"];
  const rows: PerfRow[] = [
    {
      id: "1w",
      label: "1W",
      value: typeof week === "number" ? week : null,
      reason: humanReason(reasons["ret_1w"], "insufficient history"),
    },
  ];
  for (const k of ["1m", "3m", "6m", "1y", "3y", "5y"]) {
    const v = cal[`ret_${k}`];
    rows.push({
      id: k,
      label: k.toUpperCase(),
      value: typeof v === "number" ? v : null,
      reason: humanReason(reasons[`cal_ret_${k}`], "insufficient history"),
    });
  }
  return rows;
}
