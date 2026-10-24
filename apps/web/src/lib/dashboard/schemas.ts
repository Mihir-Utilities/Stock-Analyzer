import { z } from "zod";

// Response shapes the dashboard reads, taken from docs/03-api-spec.md (sections 8, 11, 12, 13, 14,
// 15) and the B11 notes. The OpenAPI file types these `data` payloads loosely, so the shapes are
// validated here at runtime. Unknown fields are ignored; unknown values are null (never 0).

const num = z.number().nullish();
const str = z.string().nullish();

export const watchStockSchema = z.object({
  id: z.number(),
  symbol: z.string(),
  name: z.string(),
  ltp: num,
  ltp_as_of: str,
  price_stale: z.boolean().nullish(),
  change_pct: num,
  change_reason: str,
});

export const watchFundSchema = z.object({
  id: z.number(),
  code: z.number(),
  name: z.string(),
  nav: num,
  nav_date: str,
  change_pct: num,
  change_reason: str,
});

export const watchlistSchema = z.object({
  stocks: z.array(watchStockSchema),
  funds: z.array(watchFundSchema),
});

export const indexQuoteSchema = z.object({
  code: z.string(),
  name: z.string().nullish(),
  value: num,
  change: num,
  change_pct: num,
  as_of: str,
});

export const marketOverviewSchema = z.object({
  indices: z.array(indexQuoteSchema).nullish(),
  vix: indexQuoteSchema.nullish(),
  market_status: z
    .object({
      is_open: z.boolean().nullish(),
      next_open: str,
      holiday: z.union([z.string(), z.object({ name: z.string().nullish() })]).nullish(),
    })
    .nullish(),
});

const share = z.object({ key: z.string(), weight_pct: z.number() });

export const portfolioSummarySchema = z.object({
  as_of: str,
  holdings: z.array(z.object({ symbol: z.string() })),
  totals: z.object({
    invested: str,
    market_value: str,
    market_value_reason: str,
    unrealized_pnl: str,
    unrealized_pct: num,
    day_change: str,
    day_change_reason: str,
  }),
  returns: z.object({
    xirr_pct: num,
    xirr_reason: str,
    absolute_return_pct: num,
  }),
  allocation_by_sector: z.array(share),
  allocation_by_stock: z.array(share),
  allocation_excludes_unpriced: z.boolean().nullish(),
});

export const alertEventsSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      alert_id: z.number(),
      kind: z.string(),
      target: z.object({
        type: z.string(),
        symbol: z.string().nullish(),
        code: z.number().nullish(),
        name: z.string().nullish(),
      }),
      fired_at: z.string(),
      delivery_status: z.string(),
    }),
  ),
  next_cursor: z.string().nullable(),
});

export const brokerStatusSchema = z.object({
  enabled: z.boolean(),
  mode: z.string().nullish(),
  connected: z.boolean().nullish(),
  minutes_left: num,
  needs_reconnect: z.boolean().nullish(),
});

// docs/03 section 14 names the job rows only as "latest ingestion_run per job"; field names are
// not specified, so every one is optional and shown as a dash when absent (assumption F04-6).
export const adminStatusSchema = z.object({
  jobs: z
    .array(
      z.object({
        job: z.string().nullish(),
        status: z.string().nullish(),
        finished_at: str,
      }),
    )
    .nullish(),
});

export const stockEventsSchema = z.object({
  calendar: z
    .array(
      z.object({
        event_date: z.string(),
        type: z.string(),
        details: z.unknown().optional(),
      }),
    )
    .nullish(),
});

export type Watchlist = z.infer<typeof watchlistSchema>;
export type WatchStock = z.infer<typeof watchStockSchema>;
export type WatchFund = z.infer<typeof watchFundSchema>;
export type MarketOverview = z.infer<typeof marketOverviewSchema>;
export type PortfolioSummary = z.infer<typeof portfolioSummarySchema>;
export type AlertEvents = z.infer<typeof alertEventsSchema>;
export type BrokerStatus = z.infer<typeof brokerStatusSchema>;
export type AdminStatus = z.infer<typeof adminStatusSchema>;
export type StockEvents = z.infer<typeof stockEventsSchema>;
