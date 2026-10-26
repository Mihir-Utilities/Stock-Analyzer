import { z } from "zod";

// Response shapes of docs/03 section 11 (watchlist) and section 12 (portfolio, B11 notes). The
// OpenAPI file types these `data` payloads loosely, so they are validated here at runtime. Money
// fields are decimal STRINGS with 4 decimals; percent fields are percent numbers. Unknown values
// are null with a sibling `*_reason` (never 0).

const str = z.string().nullish();
const num = z.number().nullish();

const applied = z.object({
  date: z.string(),
  type: z.string(),
  multiplier: z.string(),
  source: z.string().nullish(),
});

const reviewItem = z.object({ date: z.string(), type: z.string(), note: z.string() });

export const holdingSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  sector: str,
  status: z.string().nullish(),
  flags: z.array(z.string()).nullish(),
  qty: z.string(),
  avg_cost: str,
  invested: z.string(),
  ltp: str,
  ltp_reason: str,
  ltp_as_of: str,
  price_stale: z.boolean().nullish(),
  market_value: str,
  unrealized_pnl: str,
  unrealized_pct: num,
  day_change: str,
  day_change_reason: str,
  weight_pct: num,
  realized_pnl: z.string(),
  exited: z.boolean().nullish(),
  adjustments_applied: z.array(applied).nullish(),
  review_needed: z.array(reviewItem).nullish(),
});

const share = z.object({ key: z.string(), weight_pct: z.number() });

const dividendItem = z.object({
  symbol: z.string(),
  ex_date: z.string(),
  qty: z.string(),
  amount_per_share: z.string(),
  amount: z.string(),
  qty_as_of: z.string().nullish(),
});

export const portfolioSummarySchema = z.object({
  as_of: str,
  currency: str,
  holdings: z.array(holdingSchema),
  totals: z.object({
    invested: z.string(),
    market_value: str,
    market_value_reason: str,
    unrealized_pnl: str,
    unrealized_pct: num,
    realized_pnl: z.string(),
    day_change: str,
    day_change_reason: str,
  }),
  returns: z.object({
    xirr_pct: num,
    xirr_reason: str,
    absolute_return_pct: num,
    absolute_return_basis: str,
  }),
  benchmark: z.object({
    code: z.string(),
    xirr_pct: num,
    reason: str,
    level_as_of: str,
    note: str,
  }),
  allocation_by_stock: z.array(share),
  allocation_by_sector: z.array(share),
  allocation_excludes_unpriced: z.boolean().nullish(),
  estimated_dividends: z.object({
    amount: str,
    label: str,
    items: z.array(dividendItem).nullish(),
  }),
});

export const txnSchema = z.object({
  id: z.number(),
  symbol: z.string(),
  name: z.string().nullish(),
  side: z.enum(["buy", "sell"]),
  qty: z.string(),
  price: z.string(),
  fees: z.string(),
  trade_date: z.string(),
  note: z.string().nullish(),
});

export const txnPageSchema = z.object({
  items: z.array(txnSchema),
  next_cursor: z.string().nullable(),
});

export const adjustmentSchema = z.object({
  id: z.number().nullish(),
  symbol: z.string(),
  date: z.string(),
  type: z.string(),
  multiplier: str,
  source: z.string(),
  applied: z.boolean(),
  corporate_action_id: z.number().nullish(),
  note: z.string().nullish(),
});

export const adjustmentsSchema = z.object({ items: z.array(adjustmentSchema) });

export const holidaysSchema = z.object({
  year_loaded: z.boolean(),
  items: z.array(z.object({ date: z.string() })).nullish(),
});

export const watchEntrySchema = z.object({
  id: z.number(),
  type: z.string(),
  symbol: z.string().nullish(),
  code: z.number().nullish(),
  name: z.string(),
  note: z.string().nullish(),
});

export const watchStockSchema = z.object({
  id: z.number(),
  symbol: z.string(),
  name: z.string(),
  ltp: num,
  ltp_as_of: str,
  price_stale: z.boolean().nullish(),
  change_pct: num,
  change_reason: str,
  note: str,
});

export const watchFundSchema = z.object({
  id: z.number(),
  code: z.number(),
  name: z.string(),
  nav: num,
  nav_date: str,
  change_pct: num,
  change_reason: str,
  note: str,
});

export const watchlistFullSchema = z.object({
  stocks: z.array(watchStockSchema),
  funds: z.array(watchFundSchema),
});

export const deletedSchema = z.object({ id: z.number(), deleted: z.boolean() });

export type Holding = z.infer<typeof holdingSchema>;
export type PortfolioSummary = z.infer<typeof portfolioSummarySchema>;
export type Txn = z.infer<typeof txnSchema>;
export type Adjustment = z.infer<typeof adjustmentSchema>;
export type WatchStockRow = z.infer<typeof watchStockSchema>;
export type WatchFundRow = z.infer<typeof watchFundSchema>;
