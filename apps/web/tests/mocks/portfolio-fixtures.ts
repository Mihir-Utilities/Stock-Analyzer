// Contract fixtures for the portfolio and watchlist screens, shaped after docs/03 sections 11 and
// 12 (B11 notes) and the Go response structs. The UI is developed against these, not a live API.

import type { MockReply } from "./imports-fixtures";

const meta = { as_of: "2026-10-24T09:00:00Z", source: "import", stale: false };

export const envelope = (
  data: unknown,
  warnings: Array<{ code: string; message: string }> = [],
  status = 200,
  m: Record<string, unknown> = meta,
): MockReply => ({ status, body: { data, meta: m, warnings } });

export const tcs = {
  symbol: "TCS",
  name: "Tata Consultancy Services",
  sector: "IT",
  status: "active",
  flags: [] as string[],
  qty: "10.0000",
  avg_cost: "3500.0000",
  invested: "35000.0000",
  ltp: "4000.0000",
  ltp_reason: null,
  ltp_as_of: "2026-10-23",
  price_stale: false,
  market_value: "40000.0000",
  unrealized_pnl: "5000.0000",
  unrealized_pct: 14.2857,
  day_change: "200.0000",
  day_change_reason: null,
  weight_pct: 80,
  realized_pnl: "0.0000",
  exited: false,
  adjustments_applied: [] as unknown[],
  review_needed: [] as unknown[],
};

/** Bought 10 at 1000, 1:1 bonus (x2) applied: 20 shares, average cost 500, value unchanged. */
export const infySplit = {
  symbol: "INFY",
  name: "Infosys",
  sector: "IT",
  status: "active",
  flags: ["price_before_action"],
  qty: "20.0000",
  avg_cost: "500.0000",
  invested: "10000.0000",
  ltp: "500.0000",
  ltp_reason: null,
  ltp_as_of: "2026-10-23",
  price_stale: false,
  market_value: "10000.0000",
  unrealized_pnl: "0.0000",
  unrealized_pct: 0,
  day_change: null,
  day_change_reason: "corporate_action_in_window",
  weight_pct: 20,
  realized_pnl: "0.0000",
  exited: false,
  adjustments_applied: [
    { date: "2026-08-01", type: "bonus", multiplier: "2.00000000", source: "confirmed_action" },
  ],
  review_needed: [] as unknown[],
};

export const wiproExited = {
  symbol: "WIPRO",
  name: "Wipro",
  sector: "IT",
  status: "active",
  flags: [] as string[],
  qty: "0.0000",
  avg_cost: null,
  invested: "0.0000",
  ltp: "250.0000",
  ltp_reason: null,
  ltp_as_of: "2026-10-23",
  price_stale: false,
  market_value: "0.0000",
  unrealized_pnl: "0.0000",
  unrealized_pct: null,
  day_change: "0.0000",
  day_change_reason: null,
  weight_pct: null,
  realized_pnl: "1234.5000",
  exited: true,
  adjustments_applied: [] as unknown[],
  review_needed: [] as unknown[],
};

export function summary(
  over: Record<string, unknown> = {},
  holdings: unknown[] = [tcs, infySplit],
) {
  return {
    as_of: "2026-10-24",
    currency: "INR",
    holdings,
    totals: {
      invested: "45000.0000",
      market_value: "50000.0000",
      market_value_reason: null,
      unrealized_pnl: "5000.0000",
      unrealized_pct: 11.1111,
      realized_pnl: "1234.5000",
      day_change: "200.0000",
      day_change_reason: null,
    },
    returns: {
      xirr_pct: 18.4,
      xirr_reason: null,
      absolute_return_pct: 11.1111,
      absolute_return_basis: "open_holdings",
    },
    benchmark: {
      code: "NIFTY50",
      xirr_pct: 12.1,
      reason: null,
      level_as_of: "2026-10-23",
      note: "Nifty 50 price index (dividends excluded) with the same dated cash flows",
    },
    allocation_by_stock: [
      { key: "TCS", weight_pct: 80 },
      { key: "INFY", weight_pct: 20 },
    ],
    allocation_by_sector: [{ key: "IT", weight_pct: 100 }],
    allocation_excludes_unpriced: false,
    estimated_dividends: {
      amount: "150.0000",
      label: "Estimated from dividend actions you entered; excluded from XIRR",
      items: [
        {
          symbol: "TCS",
          ex_date: "2026-06-01",
          qty: "10.0000",
          amount_per_share: "15.0000",
          amount: "150.0000",
          qty_as_of: "2026-06-01",
        },
      ],
    },
    ...over,
  };
}

export const withExited = () => summary({}, [tcs, infySplit, wiproExited]);

export const txns = {
  items: [
    {
      id: 3,
      symbol: "INFY",
      name: "Infosys",
      side: "buy",
      qty: "10.0000",
      price: "1000.0000",
      fees: "0.0000",
      trade_date: "2026-05-04",
      note: "",
    },
    {
      id: 2,
      symbol: "TCS",
      name: "Tata Consultancy Services",
      side: "sell",
      qty: "2.0000",
      price: "3900.0000",
      fees: "10.0000",
      trade_date: "2026-04-01",
      note: "trim",
    },
    {
      id: 1,
      symbol: "TCS",
      name: "Tata Consultancy Services",
      side: "buy",
      qty: "12.0000",
      price: "3500.0000",
      fees: "0.1000",
      trade_date: "2026-01-05",
      note: "",
    },
  ],
  next_cursor: null,
};

export const adjustments = {
  items: [
    {
      id: null,
      symbol: "INFY",
      date: "2026-08-01",
      type: "bonus",
      multiplier: "2.00000000",
      source: "confirmed_action",
      applied: true,
      corporate_action_id: 7,
      note: "",
    },
    {
      id: null,
      symbol: "TCS",
      date: "2026-09-01",
      type: "rights",
      multiplier: null,
      source: "review_needed",
      applied: false,
      corporate_action_id: 9,
      note: "not applied to quantities automatically; review needed",
    },
    {
      id: null,
      symbol: "INFY",
      date: "2026-09-15",
      type: "split_or_bonus",
      multiplier: null,
      source: "detected_unconfirmed",
      applied: false,
      corporate_action_id: null,
      note: "",
    },
  ],
};

export const reviewWarnings = [
  {
    code: "REVIEW_NEEDED",
    message: "TCS rights on 2026-09-01 needs review; it is not applied automatically",
  },
  {
    code: "UNCONFIRMED_ACTION",
    message: "Possible split on 2026-09-15 for INFY not yet confirmed",
  },
];

export const savedTxn = {
  id: 10,
  symbol: "TCS",
  name: "Tata Consultancy Services",
  side: "buy",
  qty: "5.0000",
  price: "4000.0000",
  fees: "0.0000",
  trade_date: "2026-10-23",
  note: "",
};

export const watchlist = {
  stocks: [
    {
      id: 4,
      symbol: "TCS",
      name: "Tata Consultancy Services",
      ltp: 4000,
      ltp_as_of: "2026-10-23",
      price_stale: false,
      change_pct: 1.25,
      change_reason: null,
      added_at: "2026-10-01T00:00:00Z",
      note: "core",
    },
    {
      id: 5,
      symbol: "INFY",
      name: "Infosys",
      ltp: null,
      ltp_as_of: null,
      price_stale: false,
      change_pct: null,
      change_reason: "no_price",
      added_at: "2026-10-02T00:00:00Z",
      note: "",
    },
  ],
  funds: [],
};
