// Contract fixtures for GET /portfolio/risk (docs/03 section 12b), built from the golden vectors of
// docs/05 8.6 (C1, S1, TW1). Synthetic data only.

import type { MockReply } from "./imports-fixtures";
import { envelope } from "./portfolio-fixtures";

const holding = (
  key: string,
  group: string,
  value: string | null,
  weight: number | null,
  reason: string | null = null,
) => ({
  key,
  name: `${key} Ltd`,
  asset_class: "equity",
  group,
  value,
  weight_pct: weight,
  weight_reason: reason,
});

export const concentration = {
  total_value: "10000.0000",
  total_value_reason: null,
  holdings_count: 4,
  top1_pct: 50,
  top3_pct: 95,
  top5_pct: 100,
  shares_reason: null,
  hhi: 0.365,
  effective_holdings: 2.74,
  hhi_reason: null,
  group_hhi: 0.665,
  group_top1_pct: 80,
  group_reason: null,
  by_holding: [
    holding("A", "Banks", "5000.0000", 50),
    holding("B", "Banks", "3000.0000", 30),
    holding("C", "IT", "1500.0000", 15),
    holding("D", "Unclassified", "500.0000", 5),
  ],
  by_group: [
    { key: "Banks", kind: "sector", value: "8000.0000", weight_pct: 80, holdings: 2 },
    { key: "IT", kind: "sector", value: "1500.0000", weight_pct: 15, holdings: 1 },
    { key: "Unclassified", kind: "unclassified", value: "500.0000", weight_pct: 5, holdings: 1 },
  ],
};

export const unpriced = {
  ...concentration,
  total_value: null,
  total_value_reason: "missing_price: D",
  top1_pct: null,
  top3_pct: null,
  top5_pct: null,
  shares_reason: "missing_price: D",
  hhi: null,
  effective_holdings: null,
  hhi_reason: "missing_price: D",
  group_hhi: null,
  group_top1_pct: null,
  group_reason: "missing_price: D",
  by_holding: [
    holding("A", "Banks", "5000.0000", null, "missing_price: D"),
    holding("B", "Banks", "3000.0000", null, "missing_price: D"),
    holding("C", "IT", "1500.0000", null, "missing_price: D"),
    holding("D", "Unclassified", null, null, "missing_price: D"),
  ],
  by_group: [
    { key: "Banks", kind: "sector", value: "8000.0000", weight_pct: null, holdings: 2 },
    { key: "IT", kind: "sector", value: "1500.0000", weight_pct: null, holdings: 1 },
    { key: "Unclassified", kind: "unclassified", value: null, weight_pct: null, holdings: 1 },
  ],
};

const stressRow = (
  key: string,
  value: string,
  i10: string,
  p10: number,
  i20: string,
  p20: number,
) => ({
  key,
  name: `${key} Ltd`,
  asset_class: "equity",
  value,
  impact_10: i10,
  impact_10_pct: p10,
  impact_20: i20,
  impact_20_pct: p20,
  impact_reason: null,
});

export const stress = {
  label:
    "What if this one holding fell and nothing else moved. Arithmetic on today's values, not a forecast.",
  falls_pct: [10, 20],
  items: [
    stressRow("A", "5000.0000", "-500.0000", -5, "-1000.0000", -10),
    stressRow("B", "3000.0000", "-300.0000", -3, "-600.0000", -6),
    stressRow("C", "1500.0000", "-150.0000", -1.5, "-300.0000", -3),
    stressRow("D", "500.0000", "-50.0000", -0.5, "-100.0000", -1),
  ],
};

const point = (date: string, value: string, index: number, dd: number) => ({
  date,
  value,
  index,
  drawdown_pct: dd,
});

/** Vector TW1: the raw value never falls, the index falls 10%. */
export const history = {
  basis: "time_weighted_index",
  base: 100,
  series_reason: null,
  from: "2024-01-01",
  to: "2024-01-05",
  points_count: 5,
  points: [
    point("2024-01-01", "1000.0000", 100, 0),
    point("2024-01-02", "2200.0000", 110, 0),
    point("2024-01-03", "3960.0000", 99, -10),
    point("2024-01-04", "3960.0000", 99, -10),
    point("2024-01-05", "4356.0000", 108.9, -1),
  ],
  gaps: [],
  gap_dates_total: 0,
  gaps_truncated: false,
  skipped_steps: 0,
  current_drawdown_pct: -1,
  peak_date: "2024-01-02",
  peak_index: 110,
  days_under_water: 3,
  drawdown_reason: null,
  max_drawdown: {
    depth_pct: -10,
    peak_date: "2024-01-02",
    trough_date: "2024-01-03",
    recovery_date: null,
    recovered: false,
  },
  twr_since_start_pct: 8.9,
};

export const historyWithGaps = {
  ...history,
  gaps: [
    { from: "2024-01-03", to: "2024-01-03", dates: 1, reason: "missing_price: C" },
    { from: "2024-02-01", to: "2024-02-09", dates: 6, reason: "nav_gap: Fund One" },
  ],
  gap_dates_total: 7,
  skipped_steps: 1,
};

export const historyEmpty = {
  basis: "time_weighted_index",
  base: 100,
  series_reason: "no_transactions",
  from: null,
  to: null,
  points_count: 0,
  points: [],
  gaps: [],
  gap_dates_total: 0,
  gaps_truncated: false,
  skipped_steps: 0,
  current_drawdown_pct: null,
  peak_date: null,
  peak_index: null,
  days_under_water: null,
  drawdown_reason: "too_few_points",
  max_drawdown: null,
  twr_since_start_pct: null,
};

export const emptyConcentration = {
  ...concentration,
  total_value: null,
  total_value_reason: "no_open_holdings",
  holdings_count: 0,
  top1_pct: null,
  top3_pct: null,
  top5_pct: null,
  shares_reason: "no_open_holdings",
  hhi: null,
  effective_holdings: null,
  hhi_reason: "no_open_holdings",
  group_hhi: null,
  group_top1_pct: null,
  group_reason: "no_open_holdings",
  by_holding: [],
  by_group: [],
};

export function risk(view: "all" | "equity" | "mf", over: Record<string, unknown> = {}) {
  return {
    view,
    as_of: "2024-01-05",
    currency: "INR",
    concentration,
    stress,
    history,
    ...over,
  };
}

export function riskByView(
  over: Partial<Record<"all" | "equity" | "mf", unknown>> = {},
  warnings: Array<{ code: string; message: string }> = [],
) {
  return (call: { query: URLSearchParams }): MockReply => {
    const v = call.query.get("view");
    const view = v === "mf" || v === "equity" || v === "all" ? v : "all";
    return envelope(over[view] ?? risk(view), warnings, 200, {
      as_of: "2024-01-05T09:00:00Z",
      source: view === "mf" ? "mfapi.in" : "mixed",
      stale: false,
    });
  };
}
