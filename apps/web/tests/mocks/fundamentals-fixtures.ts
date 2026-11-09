// Contract-shaped fundamentals answers (docs/03 section 5, B05). Illustrative numbers only, fixed
// dates, no clock and no randomness.

import { ok, type MockReply } from "./imports-fixtures";

export const PERIODS = ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"];
export const LABELS = ["Q3 FY26", "Q4 FY26", "Q1 FY27", "Q2 FY27"];

const base = {
  basis_used: "consolidated",
  basis_available: ["consolidated", "standalone"],
  basis_note: null,
  period_type: "Q",
  periods_available: 4,
  unit: "INR_CR",
  unit_by_metric: { "pnl.eps": "INR" },
  source_by_metric: {
    "pnl.revenue": "manual",
    "pnl.ebitda": "csv_import",
    "pnl.net_profit": "csv_import",
  },
  periods: PERIODS,
  labels: LABELS,
  metrics: {
    "pnl.revenue": [1000, 1100, 1200, 1300],
    "pnl.ebitda": [250, 270, 300, 320],
    "pnl.depreciation": [40, 42, 44, 45],
    "pnl.interest": [10, 10, 11, 12],
    "pnl.pbt": [210, 225, 250, 268],
    "pnl.tax": [50, 54, 60, 64],
    "pnl.net_profit": [160, 171, 190, 204],
    "pnl.eps": [4.5, 4.8, 5.3, 5.7],
  },
  metrics_reason: null,
  derived: null,
  derived_reason: "not_computed",
  derived_as_of: null,
  ratios: null,
  ratios_reason: "not_computed",
  valuation: null,
  valuation_reason: "not_computed",
  company_type: "general",
  status: "ok",
  entry_hint: null,
  last_updated: "2026-10-09T10:00:00Z",
  last_updated_source: "manual",
};

export function fundamentals(
  over: Record<string, unknown> = {},
  warnings: Array<{ code: string; message: string }> = [],
) {
  const r = ok({ ...base, ...over });
  return { ...r, body: { ...(r.body as object), warnings } } as MockReply;
}

export const noData = ok({
  ...base,
  periods: [],
  labels: [],
  periods_available: 0,
  metrics: {},
  metrics_reason: "no_data_entered",
  source_by_metric: {},
  entry_hint: "Add results via Import or the manual form",
  last_updated: null,
  last_updated_source: null,
  status: "none",
});

export const annualBalance = {
  period_type: "A",
  periods: ["2025-03-31", "2026-03-31"],
  labels: ["FY25", "FY26"],
  periods_available: 2,
  status: "partial",
  metrics: {
    "bs.equity": [500, 560],
    "bs.borrowings": [200, 180],
    "bs.current_liabilities": [150, 160],
    "bs.total_assets": [900, 950],
    "cf.cfo": [120, 140],
    "cf.cfi": [-80, -90],
    "cf.cff": [-30, -40],
    "cf.capex": [70, 75],
  },
};
