// Mock answers for the mutual fund screens, shaped after docs/03 section 10 and the B10 notes
// (contract-first: no live API). Fixed dates only; nothing depends on the wall clock or random data.

import type { MockReply } from "./imports-fixtures";

export const ATTRIBUTION = "NAV data: AMFI, via mfapi.in";

export function envelope(
  data: unknown,
  opts: {
    asOf?: string;
    stale?: boolean;
    warnings?: Array<{ code: string; message: string }>;
    status?: number;
  } = {},
): MockReply {
  return {
    status: opts.status ?? 200,
    body: {
      data,
      meta: { as_of: opts.asOf ?? "2026-10-23", source: "mfapi.in", stale: opts.stale ?? false },
      warnings: opts.warnings ?? [],
    },
  };
}

export const item = (code: number, over: Record<string, unknown> = {}) => ({
  code,
  name: `Alpha Flexi Cap Fund - Direct Plan - Growth ${code}`,
  fund_house: "Alpha Mutual Fund",
  category: "Equity Scheme - Flexi Cap Fund",
  plan: "direct",
  option: "growth",
  status: "active",
  latest_nav: 123.4567,
  last_nav_date: "2026-10-23",
  return_1y_pct: 12.34,
  returns_as_of: "2026-10-23",
  unit: "INR per unit",
  source: "mfapi.in",
  ...over,
});

export const searchPage = (items: unknown[], next: string | null = null, stale = false) =>
  envelope({ items, next_cursor: next, attribution: ATTRIBUTION }, { stale });

export const categories = envelope({
  items: ["Equity Scheme - Flexi Cap Fund", "Debt Scheme - Liquid Fund"],
});

const RETURN_KEYS = ["r_1m", "r_3m", "r_6m", "r_ytd", "r_1y", "r_3y", "r_5y", "r_since"];

export function detail(over: Record<string, unknown> = {}) {
  const returns: Record<string, number | null> = {
    r_1m: 1.2,
    r_3m: -2.5,
    r_6m: 5.5,
    r_ytd: 8.1,
    r_1y: 12.34,
    r_3y: 15.5,
    r_5y: null,
    r_since: 14.2,
  };
  return {
    code: 120503,
    name: "Alpha Flexi Cap Fund - Direct Plan - Growth",
    fund_house: "Alpha Mutual Fund",
    scheme_type: "Open Ended Schemes",
    category: "Equity Scheme - Flexi Cap Fund",
    plan: "direct",
    option: "growth",
    isin_growth: null,
    isin_div_reinvest: null,
    status: "active",
    tracked: true,
    first_nav_date: "2021-01-04",
    nav_count: 1500,
    latest_nav: { value: 123.4567, date: "2026-10-23", unit: "INR per unit" },
    returns,
    return_basis: {
      r_1m: "absolute",
      r_3m: "absolute",
      r_6m: "absolute",
      r_ytd: "absolute",
      r_1y: "cagr",
      r_3y: "cagr",
      r_5y: "cagr",
      r_since: "cagr",
    },
    return_reasons: { r_5y: "insufficient_history" },
    risk: {
      volatility_pct: 14.5,
      volatility_reason: null,
      volatility_years: 3,
      max_drawdown_pct: -22.1,
      sharpe_like: 0.85,
      sharpe_reason: null,
      risk_free_rate: 6.5,
    },
    rolling_1y: { min: -8.2, median: 13.1, max: 41.5, pct_positive: 82.5, count: 900 },
    nav_jumps: [{ date: "2026-10-21", change_pct: 30.5 }],
    metrics_as_of: "2026-10-23",
    units: {},
    backfill: null,
    attribution: ATTRIBUTION,
    ...over,
  };
}

export const noNavDetail = (backfill: { status: string; job_id: number | null }) =>
  envelope(
    detail({
      nav_count: 0,
      first_nav_date: null,
      latest_nav: null,
      returns: Object.fromEntries(RETURN_KEYS.map((k) => [k, null])),
      return_basis: {},
      return_reasons: Object.fromEntries(RETURN_KEYS.map((k) => [k, "no_nav_yet"])),
      risk: null,
      rolling_1y: null,
      nav_jumps: null,
      metrics_as_of: null,
      backfill,
    }),
    {
      warnings: [{ code: "NO_NAV_DATA", message: "No NAV history is stored for this scheme yet." }],
    },
  );

/** 120 fixed NAV points on consecutive calendar days from 2026-06-26 (spike on 2026-10-21 is index 117). */
export function navPoints(n = 120): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const start = Date.UTC(2026, 5, 26);
  for (let i = 0; i < n; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    out.push([d, Math.round((100 + i * 0.2) * 10_000) / 10_000]);
  }
  return out;
}

export const nav = (range = "1Y", points = navPoints(), downsampled = false) =>
  envelope({
    code: 120503,
    range,
    log: false,
    unit: "INR per unit",
    points,
    raw_count: downsampled ? 5000 : points.length,
    downsampled,
    attribution: ATTRIBUTION,
  });

export function sip(over: Record<string, unknown> = {}) {
  return {
    code: 120503,
    amount: "5000.00",
    start: "2026-01-01",
    end: "2026-03-31",
    day: 1,
    invested: "15000.00",
    value: "16000.00",
    units: "150.5",
    absolute_return_pct: 6.67,
    xirr_pct: 28.9,
    xirr_reason: null,
    installments: 3,
    skipped_installments: 0,
    end_nav_date: "2026-03-31",
    end_nav: 106.3,
    schedule: [
      { date: "2026-01-01", nav_date: "2026-01-01", nav: 100, units: "50" },
      { date: "2026-02-01", nav_date: "2026-02-02", nav: 100, units: "50" },
      { date: "2026-03-01", nav_date: "2026-03-02", nav: 105, units: "50.5" },
    ],
    unit_labels: {},
    attribution: ATTRIBUTION,
    ...over,
  };
}

export const compare = (over: Record<string, unknown> = {}) =>
  envelope({
    range: "3Y",
    common_start: "2024-01-01",
    common_end: "2026-10-23",
    base: 100,
    different_starts: true,
    series: [
      {
        code: 120503,
        name: "Alpha Flexi Cap Fund - Direct Plan - Growth",
        points: [
          ["2024-01-01", 100],
          ["2024-01-02", 101],
          ["2024-01-03", 103.5],
        ],
      },
      {
        code: 118989,
        name: "Beta Large Cap Fund - Direct Plan - Growth",
        points: [
          ["2024-01-01", 100],
          ["2024-01-02", 99],
          ["2024-01-03", 98],
        ],
      },
    ],
    table: [
      {
        code: 120503,
        name: "Alpha Flexi Cap Fund - Direct Plan - Growth",
        first_nav_date: "2021-01-04",
        history_shorter_than_range: false,
        return_pct: 15.5,
        return_basis: "cagr",
        volatility_pct: 14.5,
        volatility_reason: null,
        max_drawdown_pct: -22.1,
      },
      {
        code: 118989,
        name: "Beta Large Cap Fund - Direct Plan - Growth",
        first_nav_date: "2023-06-01",
        history_shorter_than_range: true,
        return_pct: -4.2,
        return_basis: "absolute",
        volatility_pct: null,
        volatility_reason: "insufficient_history",
        max_drawdown_pct: -9.5,
      },
    ],
    attribution: ATTRIBUTION,
    ...over,
  });

export const emptyWatchFunds = envelope({ stocks: [], funds: [] });
