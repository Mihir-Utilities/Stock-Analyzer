import Decimal from "decimal.js";
import type { Warning } from "@analyzer/api-types";
import { formatInr } from "@/lib/format";
import type { SchemeDetail, SipInstallment } from "./schemas";

// Pure helpers for the mutual fund screens (docs/06 section 6.9, docs/05 section 9). Number and
// date formatting stays in lib/format; nothing here turns a number into display text except by
// calling it.

/**
 * docs/00 section 1 item 6 and docs/03 section 10 (B10-8): the comma is part of the text. One
 * constant, defined next to the footer that renders it (kept out of this module's imports so the
 * shell does not pull decimal.js into every page).
 */
export { MF_ATTRIBUTION } from "@/components/shell/Footer";
export const MF_SOURCE = "AMFI NAV file via mfapi.in";
/** docs/06 section 6.9, verbatim. */
export const MF_NOTICE = "AUM, expense ratio and manager are not available from this data source";
export const MF_STALE_DAYS = 4;
export const MF_UNIT = "INR per unit";

export const NAV_RANGES = ["1M", "6M", "1Y", "3Y", "5Y", "MAX"] as const;
export type NavRange = (typeof NAV_RANGES)[number];
export const COMPARE_RANGES = ["1Y", "3Y", "5Y", "MAX"] as const;

/** Return windows in the order of docs/03 section 10; the label says which basis applies. */
export const RETURN_KEYS = [
  ["r_1m", "1M"],
  ["r_3m", "3M"],
  ["r_6m", "6M"],
  ["r_ytd", "YTD"],
  ["r_1y", "1Y"],
  ["r_3y", "3Y"],
  ["r_5y", "5Y"],
  ["r_since", "Since first NAV"],
] as const;

const REASONS: Record<string, string> = {
  no_nav_yet: "no NAV data yet",
  insufficient_history: "history is shorter than this window",
  "n/m": "not meaningful (flat or non-positive NAV base)",
  weekly_nav: "this scheme publishes weekly NAVs",
  period_too_short: "fewer than 30 days between the first installment and the end",
  no_solution: "the rate could not be solved for these cash flows",
};

/** Plain words for a server reason code; an unknown code is shown as written, never hidden. */
export function reasonText(code: string | null | undefined, fallback = "not available"): string {
  if (!code) return fallback;
  return REASONS[code] ?? code.replace(/_/g, " ");
}

export interface ReturnRow {
  key: string;
  label: string;
  value: number | null;
  basis: "CAGR" | "Absolute" | null;
  reason: string | null;
}

/** One row per window; a null value always carries a reason (server reason, else history). */
export function returnRows(d: SchemeDetail): ReturnRow[] {
  return RETURN_KEYS.map(([key, label]) => {
    const raw = d.returns[key];
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const basis = d.return_basis?.[key];
    return {
      key,
      label,
      value,
      basis: basis === "cagr" ? "CAGR" : basis === "absolute" ? "Absolute" : null,
      reason: value === null ? reasonText(d.return_reasons?.[key], "no data") : null,
    };
  });
}

/** Whole days between two YYYY-MM-DD dates (UTC arithmetic, no timezone involved). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Warning codes from the detail response shown as banners (docs/05 section 9.5). */
export const MF_WARNING_COPY: Record<string, string> = {
  IDCW_NOT_COMPARABLE:
    "IDCW scheme: returns are computed from NAV and exclude payouts, so they are not comparable with growth schemes.",
  SCHEME_MAY_BE_MERGED:
    "This scheme may be merged or closed: it is inactive or its last NAV is more than 10 days old.",
};

/** Server text when we have no fixed copy; the code is never shown alone. */
export function warningText(w: Warning): string {
  return MF_WARNING_COPY[w.code] ?? w.message;
}

export type PlanOption = { plan: string; option: string };

export function planOptionLabels(p: PlanOption): [string, string] {
  const plan = p.plan === "direct" ? "Direct" : p.plan === "regular" ? "Regular" : p.plan;
  const option = p.option === "growth" ? "Growth" : p.option === "idcw" ? "IDCW" : p.option;
  return [plan, option];
}

// ---- SIP form (docs/05 section 9.4; B10-7 bounds; MF-11) -----------------------------------

export interface SipInput {
  amount: string;
  start: string;
  end: string;
  day: string;
}

export interface SipErrors {
  amount?: string;
  start?: string;
  end?: string;
  day?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SIP_MIN_START = "1990-01-01";

export function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** Client validation mirrors the API (it validates again): MF-11 limits the day to 1-28. */
export function validateSip(v: SipInput): SipErrors {
  const e: SipErrors = {};
  const amount = v.amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    e.amount = "Enter a positive amount with at most 2 decimals.";
  } else {
    const d = new Decimal(amount);
    if (d.lte(0)) e.amount = "Enter an amount above 0.";
    else if (d.gt(1_000_000_000))
      e.amount = `The amount can be at most ${formatInr(1_000_000_000, { decimals: 0 }).text}.`;
  }
  if (!isValidDate(v.start)) e.start = "Enter the first installment month as a date.";
  else if (v.start < SIP_MIN_START) e.start = "The start date must be on or after 1 Jan 1990.";
  const end = v.end.trim();
  if (end !== "") {
    if (!isValidDate(end)) e.end = "Enter the end date as a date, or leave it empty.";
    else if (isValidDate(v.start) && end < v.start) e.end = "The end date is before the start.";
  }
  const day = v.day.trim();
  if (!/^\d{1,2}$/.test(day) || Number(day) < 1 || Number(day) > 28) {
    e.day = "The installment day must be a whole number from 1 to 28.";
  }
  return e;
}

export interface GrowthPoint {
  /** Execution NAV date (x axis). */
  date: string;
  invested: number;
  /** Units accumulated so far times that installment's own NAV (an illustration, see UI note). */
  value: number;
}

/**
 * Cumulative invested and value after each executed installment, from the API's schedule.
 * Decimal arithmetic keeps units and rupees exact; numbers are produced only for plotting.
 * The final point (when its date is after the last execution) uses the API's end NAV and value.
 */
export function sipGrowth(
  schedule: ReadonlyArray<SipInstallment>,
  amount: string,
  end: { date: string | null; nav: number | null } = { date: null, nav: null },
): GrowthPoint[] {
  const out: GrowthPoint[] = [];
  let units = new Decimal(0);
  let invested = new Decimal(0);
  const unit = new Decimal(amount);
  for (const s of schedule) {
    units = units.plus(new Decimal(s.units));
    invested = invested.plus(unit);
    out.push({
      date: s.nav_date,
      invested: invested.toNumber(),
      value: units.times(s.nav).toNumber(),
    });
  }
  const last = out[out.length - 1];
  if (last && end.date !== null && end.nav !== null && end.date > last.date) {
    out.push({ date: end.date, invested: last.invested, value: units.times(end.nav).toNumber() });
  }
  return out;
}

export function sipMoney(v: string | null): string | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? formatInr(n).text : null;
}
