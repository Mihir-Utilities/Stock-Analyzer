// Synthetic contract fixtures for the portfolio views and MF holdings (docs/03 section 12a). Every
// name, folio, ISIN, unit and amount here is invented; none comes from a real statement (privacy).

import type { MockReply } from "./imports-fixtures";
import { envelope, summary as equitySummary } from "./portfolio-fixtures";

export { envelope };

export const alphaGrowth = {
  asset_class: "mf",
  scheme_code: 100001,
  scheme_name: "Example Alpha Fund - Direct Plan - Growth",
  fund_house: "Example AMC",
  category: "Equity: Large Cap",
  plan: "direct",
  option: "growth",
  isin: "INF000000001",
  folios: ["TEST-F1"],
  units: "100.5000",
  avg_cost: "100.0000",
  invested: "10050.0000",
  nav: "120.0000",
  nav_date: "2026-10-23",
  nav_stale: false,
  nav_reason: null,
  market_value: "12060.0000",
  unrealized_pnl: "2010.0000",
  unrealized_pct: 20,
  realized_pnl: "0.0000",
  idcw_income: "0.0000",
  day_change: "50.2500",
  day_change_reason: null,
  weight_pct: 70,
  xirr_pct: 15.2,
  xirr_reason: null,
  absolute_return_pct: 20,
  first_txn_date: "2024-01-05",
  span_days: 1022,
  exited: false,
  flags: [] as string[],
  source: "your statement; NAV: AMFI via mfapi.in",
};

export const betaIdcw = {
  ...alphaGrowth,
  scheme_code: 100002,
  scheme_name: "Example Beta Fund - Regular Plan - IDCW",
  category: "Hybrid: Balanced",
  plan: "regular",
  option: "idcw",
  isin: "INF000000002",
  folios: ["TEST-F2"],
  units: "50.0000",
  avg_cost: "100.0000",
  invested: "5000.0000",
  nav: "90.0000",
  market_value: "4500.0000",
  unrealized_pnl: "-500.0000",
  unrealized_pct: -10,
  idcw_income: "200.0000",
  day_change: "-10.0000",
  weight_pct: 30,
  xirr_pct: null,
  xirr_reason: "under_one_year",
  absolute_return_pct: -5.5,
  span_days: 200,
  flags: ["idcw"],
};

/** A scheme with no NAV at all: value, P&L and XIRR are unknown with a reason, units stay. */
export const gammaNoNav = {
  ...alphaGrowth,
  scheme_code: 100003,
  scheme_name: "Example Gamma Fund - Direct Plan - Growth",
  isin: null,
  folios: ["TEST-F3"],
  units: "10.0000",
  avg_cost: "50.0000",
  invested: "500.0000",
  nav: null,
  nav_date: null,
  nav_reason: "no_nav",
  market_value: null,
  unrealized_pnl: null,
  unrealized_pct: null,
  day_change: null,
  day_change_reason: "no_previous_nav",
  weight_pct: null,
  xirr_pct: null,
  xirr_reason: "no_nav",
  absolute_return_pct: null,
};

const mfTotals = {
  invested: "15050.0000",
  market_value: "16560.0000",
  market_value_reason: null,
  unrealized_pnl: "1510.0000",
  unrealized_pct: 10.03,
  realized_pnl: "300.0000",
  idcw_income: "200.0000",
  total_pnl: "2010.0000",
  total_pnl_reason: null,
  purchase_cash: "15050.0000",
  day_change: "40.2500",
  day_change_reason: null,
};

const stocksTotals = {
  invested: "45000.0000",
  market_value: "50000.0000",
  market_value_reason: null,
  unrealized_pnl: "5000.0000",
  unrealized_pct: 11.1111,
  realized_pnl: "1234.5000",
  idcw_income: null,
  total_pnl: "6234.5000",
  total_pnl_reason: null,
  purchase_cash: "45000.0000",
  day_change: "200.0000",
  day_change_reason: null,
};

const breakdown = [
  {
    asset_class: "equity",
    invested: "45000.0000",
    market_value: "50000.0000",
    market_value_reason: null,
    unrealized_pnl: "5000.0000",
    realized_pnl: "1234.5000",
    idcw_income: null,
    total_pnl: "6234.5000",
    xirr_pct: 18.4,
    xirr_reason: null,
    absolute_return_pct: 11.11,
    as_of: "2026-10-23",
    stale: false,
  },
  {
    asset_class: "mf",
    invested: "15050.0000",
    market_value: "16560.0000",
    market_value_reason: null,
    unrealized_pnl: "1510.0000",
    realized_pnl: "300.0000",
    idcw_income: "200.0000",
    total_pnl: "2010.0000",
    xirr_pct: 9.5,
    xirr_reason: null,
    absolute_return_pct: 10,
    as_of: "2026-10-23",
    stale: false,
  },
];

const base = equitySummary();

/** The summary of one view as the API sends it (docs/03 12a). Pass `over` to change top-level fields. */
export function viewSummary(
  view: "all" | "equity" | "mf",
  over: Record<string, unknown> = {},
  mfRows: unknown[] = [alphaGrowth, betaIdcw],
) {
  const common = {
    as_of: "2026-10-24",
    currency: "INR",
    estimated_dividends: base.estimated_dividends,
    allocation_excludes_unpriced: false,
  };
  if (view === "equity") {
    return {
      ...base,
      ...common,
      view,
      asset_classes_present: ["equity", "mf"],
      totals: { ...stocksTotals },
      returns: { ...base.returns, span_days: 700, first_flow_date: "2024-12-01" },
      breakdown: [],
      mf_holdings: [],
      allocation_by_scheme: [],
      allocation_by_category: [],
      allocation_by_asset_class: [],
      ...over,
    };
  }
  if (view === "mf") {
    return {
      ...common,
      view,
      asset_classes_present: ["equity", "mf"],
      holdings: [],
      totals: { ...mfTotals },
      returns: {
        xirr_pct: 9.5,
        xirr_reason: null,
        absolute_return_pct: 10,
        absolute_return_basis: "(value + proceeds + IDCW - invested) / invested; simple, not annualised",
        span_days: 900,
        first_flow_date: "2024-01-05",
      },
      benchmark: { code: null, xirr_pct: null, reason: "not_defined_for_view" },
      estimated_dividends: {
        amount: "0.0000",
        label: "not applicable to mutual funds; IDCW income is taken from your transactions",
        items: [],
      },
      breakdown: [],
      mf_holdings: mfRows,
      allocation_by_stock: [],
      allocation_by_sector: [],
      allocation_by_scheme: [
        { key: "Example Alpha Fund", weight_pct: 70 },
        { key: "Example Beta Fund", weight_pct: 30 },
      ],
      allocation_by_category: [
        { key: "Equity: Large Cap", weight_pct: 70 },
        { key: "Hybrid: Balanced", weight_pct: 30 },
      ],
      allocation_by_asset_class: [],
      ...over,
    };
  }
  return {
    ...base,
    ...common,
    view,
    asset_classes_present: ["equity", "mf"],
    totals: {
      invested: "60050.0000",
      market_value: "66560.0000",
      market_value_reason: null,
      unrealized_pnl: "6510.0000",
      unrealized_pct: 10.84,
      realized_pnl: "1534.5000",
      idcw_income: "200.0000",
      total_pnl: "8244.5000",
      total_pnl_reason: null,
      purchase_cash: "60050.0000",
      day_change: "240.2500",
      day_change_reason: null,
    },
    returns: {
      xirr_pct: 12.29,
      xirr_reason: null,
      absolute_return_pct: 13.7,
      absolute_return_basis: "simple, not annualised",
      span_days: 900,
      first_flow_date: "2024-01-05",
    },
    benchmark: { code: null, xirr_pct: null, reason: "not_defined_for_view" },
    breakdown,
    mf_holdings: mfRows,
    allocation_by_scheme: [
      { key: "Example Alpha Fund", weight_pct: 70 },
      { key: "Example Beta Fund", weight_pct: 30 },
    ],
    allocation_by_category: [
      { key: "Equity: Large Cap", weight_pct: 70 },
      { key: "Hybrid: Balanced", weight_pct: 30 },
    ],
    allocation_by_asset_class: [
      { key: "equity", weight_pct: 75.1 },
      { key: "mf", weight_pct: 24.9 },
    ],
    ...over,
  };
}

/** Route handler that answers by the `view` query parameter like the API does. */
export function byView(
  over: Partial<Record<"all" | "equity" | "mf", unknown>> = {},
  warnings: Array<{ code: string; message: string }> = [],
  m: Record<string, unknown> = { as_of: "2026-10-24T09:00:00Z", source: "mixed", stale: false },
) {
  return (call: { query: URLSearchParams }): MockReply => {
    const v = call.query.get("view");
    const view = v === "mf" || v === "equity" || v === "all" ? v : "equity";
    return envelope(over[view] ?? viewSummary(view), warnings, 200, m);
  };
}

export const mfTxn = {
  id: 501,
  asset_class: "mf",
  scheme_code: 100001,
  scheme_name: "Example Alpha Fund - Direct Plan - Growth",
  isin: "INF000000001",
  plan: "direct",
  option: "growth",
  folio: "TEST-F1",
  txn_type: "purchase",
  txn_date: "2026-09-04",
  units: "12.3450",
  nav: "81.0000",
  amount: "999.9500",
  stamp_duty: "0.0500",
  external_ref: null,
  source: "manual",
  import_batch_id: null,
  note: "",
};

export const mfTxnImported = { ...mfTxn, id: 502, source: "import", import_batch_id: 9, txn_type: "sip" };

export const mfSchemeSearch = {
  items: [
    {
      code: 100001,
      name: "Example Alpha Fund - Direct Plan - Growth",
      fund_house: "Example AMC",
      category: "Equity: Large Cap",
      plan: "direct",
      option: "growth",
      status: "active",
      latest_nav: 120,
      last_nav_date: "2026-10-23",
      return_1y_pct: 12,
      returns_as_of: "2026-10-23",
    },
    {
      code: 100009,
      name: "Example Alpha Fund - Regular Plan - IDCW",
      fund_house: "Example AMC",
      category: "Equity: Large Cap",
      plan: "regular",
      option: "idcw",
      status: "active",
      latest_nav: 33,
      last_nav_date: "2026-10-23",
      return_1y_pct: 10,
      returns_as_of: "2026-10-23",
    },
  ],
  next_cursor: null,
  attribution: "NAV data: AMFI via mfapi.in.",
};

// ---- statement import (synthetic rows; the real statement is never used) -----------------------

export function candidate(code: number, over: Record<string, unknown> = {}) {
  return {
    scheme_code: code,
    name: `Example Alpha Fund (code ${code})`,
    fund_house: "Example AMC",
    plan: "direct",
    option: "growth",
    isin: `INF00000${code}`,
    on_watchlist: false,
    has_nav: true,
    ...over,
  };
}

const previewRow = (row: number, over: Record<string, unknown> = {}) => ({
  row,
  date: "2025-01-06",
  fund_name: "Example Alpha Fund",
  txn_type: "purchase",
  folio: "TEST-F1",
  units: "10.0000",
  nav: "100.0000",
  amount: "1000.0000",
  stamp_duty: "0.0500",
  scheme_code: null,
  ...over,
});

export interface ImportScenario {
  unmapped?: boolean;
  dup?: boolean;
  inDb?: number;
}

/** `data` of validate/revalidate for a statement with one fund name. */
export function mfValidate(sc: ImportScenario = {}) {
  const unmapped = sc.unmapped ?? true;
  const dup = sc.dup ?? false;
  const rows = dup ? 3 : 2;
  const preview = [
    previewRow(3, unmapped ? {} : { scheme_code: 100001 }),
    previewRow(4, unmapped ? {} : { scheme_code: 100001 }),
    ...(dup ? [previewRow(5, unmapped ? {} : { scheme_code: 100001 })] : []),
  ];
  const errors = unmapped
    ? preview.map((p) => ({
        row: p.row,
        column: "fund_name",
        code: "UNMAPPED_FUND",
        message: 'fund "Example Alpha Fund" has no scheme chosen yet; pick the scheme for this fund name',
      }))
    : [];
  const warnings = dup
    ? [4, 5].map((r) => ({
        row: r,
        column: "",
        code: "DUPLICATE_IN_FILE",
        message: "identical to an earlier row in this file; kept as a separate transaction",
      }))
    : [];
  return {
    upload_id: "11111111-1111-4111-8111-111111111111",
    upload_group: null,
    rows,
    preview,
    errors,
    warnings,
    error_count: errors.length,
    warning_count: warnings.length,
    estimated_growth_mb: null,
    prices_already_adjusted: null,
    mf: {
      date_from: "2025-01-06",
      date_to: "2025-01-06",
      rows_by_type: { purchase: rows },
      funds: [
        {
          fund_name: "Example Alpha Fund",
          fund_name_key: "example alpha fund",
          rows,
          mapped: !unmapped,
          scheme_code: unmapped ? null : 100001,
          scheme_name: unmapped ? null : "Example Alpha Fund - Direct Plan - Growth",
          plan: unmapped ? null : "direct",
          option: unmapped ? null : "growth",
        },
      ],
      unmapped_funds: unmapped
        ? [
            {
              fund_name: "Example Alpha Fund",
              fund_name_key: "example alpha fund",
              rows,
              candidates: [
                candidate(100010, {
                  name: "Example Alpha Fund - Regular Plan - Growth",
                  plan: "regular",
                }),
                candidate(100001, {
                  name: "Example Alpha Fund - Direct Plan - Growth",
                  on_watchlist: true,
                }),
                candidate(100011, {
                  name: "Example Alpha Fund - Direct Plan - IDCW",
                  option: "idcw",
                  has_nav: false,
                }),
              ],
            },
          ]
        : [],
      fund_mappings: [],
      duplicate_groups: dup ? [{ rows: [3, 4, 5], count: 3 }] : [],
      duplicates_in_db: sc.inDb ?? 0,
    },
  };
}

export const mfMapping = {
  fund_name: "Example Alpha Fund",
  fund_name_key: "example alpha fund",
  scheme_code: 100001,
  scheme_name: "Example Alpha Fund - Direct Plan - Growth",
  plan: "direct",
  option: "growth",
  isin: "INF000000001",
  rows: 2,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:00:00Z",
  audit_note: null,
};
