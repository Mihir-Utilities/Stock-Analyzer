// Contract-shaped answers for the stock page (docs/03 sections 3 to 5, openapi.yaml examples and the
// worker snapshot shape in docs/OPEN_QUESTIONS D05a-A6/B04-7). Illustrative numbers only; the URLs
// are placeholders, no real site. No network.

import { fail, ok, type MockReply } from "./imports-fixtures";

export const profileData = {
  id: 123,
  symbol: "TCS",
  name: "Tata Consultancy Services Ltd",
  isin: "INE467B01029",
  series: "EQ",
  sector: "IT",
  industry: "IT Services",
  company_type: "general",
  status: "active",
  instrument_kind: "equity",
  listing_date: "2004-08-25",
  broker_ok: null,
  tracked: true,
  price_mode: "manual",
  quote: null,
  freshness: {
    prices_stale: false,
    holidays_missing: false,
    prices_as_of: "2026-10-09",
    fundamentals_as_of: null,
    shareholding_as_of: null,
    predictions_as_of: null,
  },
  flags: { no_prices: false, limited_history: false, series_warning: null },
};

export function profile(over: Record<string, unknown> = {}): MockReply {
  return ok({ ...profileData, ...over });
}

export const withFreshness = (f: Record<string, unknown>) => ({
  freshness: { ...profileData.freshness, ...f },
});

/** `n` daily bars ending 2026-10-09 with a steady rise; `drops` maps bar index -> multiplier. */
export function bars(n = 70, drops: Record<number, number> = {}) {
  const out: Array<[string, number, number, number, number, number]> = [];
  let close = 100;
  const end = Date.UTC(2026, 9, 9);
  for (let i = 0; i < n; i++) {
    close = close * (drops[i] ?? 1.002);
    const d = new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    out.push([d, close - 0.5, close + 1, close - 1, close, 1000 + i]);
  }
  return out;
}

export function prices(
  over: { n?: number; drops?: Record<number, number>; actions?: unknown[] } = {},
  warnings: Array<{ code: string; message: string }> = [],
): MockReply {
  const r = ok({
    bars: bars(over.n ?? 70, over.drops ?? {}),
    adjusted: true,
    actions: over.actions ?? [],
    range: "1Y",
    limited_history: false,
    depth: { first_bar: "2026-07-02", last_bar: "2026-10-09", bars: over.n ?? 70 },
  });
  return {
    ...r,
    body: {
      ...(r.body as object),
      warnings,
      meta: { interval: "1d", as_of: "2026-10-09", stale: false },
    },
  };
}

export const indicatorsData = {
  version: "d05a-1",
  as_of: "2026-10-09",
  bars: 70,
  price_basis: "adj_close price return (excludes dividends)",
  source: "owner-imported prices",
  last_close: 115,
  returns: {
    trading: { ret_1w: 0.9, ret_1m: 2.1 },
    calendar: { ret_1m: 2.2, ret_3m: -4.5, ret_6m: null, ret_1y: null, ret_3y: null, ret_5y: null },
    risk: { vol_252: null, beta_252: null },
  },
  technicals: { high_52w: null, low_52w: null, rsi14: 55 },
  scores: {},
  null_reasons: {
    cal_ret_6m: "insufficient_history",
    cal_ret_1y: "insufficient_history",
    cal_ret_3y: "insufficient_history",
    cal_ret_5y: "insufficient_history",
    high_52w: "insufficient_history",
  },
  units: { "ret_*": "percent" },
  warnings: [],
};

export const indicators = (over: Record<string, unknown> = {}): MockReply =>
  ok({ ...indicatorsData, ...over });

export const indicatorsFull = (): MockReply =>
  indicators({
    technicals: { high_52w: 130, low_52w: 90, rsi14: 55 },
    scores: {
      trend: { score: 70, label: "up" },
      risk: { score: 40, label: "medium" },
      quality: { score: null, reason: "not_computed" },
    },
  });

export const noPrices = fail(404, "DATA_UNAVAILABLE", "No prices imported", {
  reason: "no_prices_imported",
});

export const events = ok({
  actions: [
    {
      id: 1,
      ex_date: "2026-06-12",
      record_date: null,
      type: "split",
      status: "confirmed",
      ratio_num: 1,
      ratio_den: 2,
      amount_per_share: null,
      purpose_text: "Stock split",
      source: "manual",
    },
    {
      id: 2,
      ex_date: "2026-08-01",
      record_date: null,
      type: "dividend",
      status: "confirmed",
      ratio_num: null,
      ratio_den: null,
      amount_per_share: 10,
      purpose_text: "",
      source: "manual",
    },
  ],
  calendar: [
    { event_date: "2026-11-05", type: "results", details: "Q2 results", source: "manual" },
  ],
  reason: null,
  entry_hint: null,
});

export const eventsEmpty = ok({
  actions: [],
  calendar: [],
  reason: "no_data_entered",
  entry_hint: "Add events via Import or the manual form",
});

export const links = ok({
  links: [
    { label: "Example quote page", url: "https://example.com/quote/TCS" },
    { label: "Example search", url: "https://example.com/search?q=Tata+Consultancy" },
  ],
});

export const fundamentalsNotComputed = ok({
  ratios: null,
  valuation: null,
  ratios_reason: "not_computed",
  valuation_reason: "not_computed",
  derived_as_of: null,
});

export const fundamentalsComputed = ok({
  ratios: { roe: 12.5, roce: 15.25, debt_equity: 0.4 },
  valuation: { pe_ttm: 23.45, pb: 3.2, div_yield: 1.5 },
  ratios_reason: null,
  valuation_reason: null,
  derived_as_of: "2026-10-09",
});

export const emptyWatchlist = ok({ stocks: [], funds: [] });
