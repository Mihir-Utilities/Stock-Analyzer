import { z } from "zod";

// Runtime validation of the stock endpoints' `data` (docs/03 sections 3, 4, 5, 11; the OpenAPI
// `data` schema is untyped, so these schemas are the web side of the contract). Objects are
// tolerant of extra keys; every field that can be unknown is nullable here, never defaulted to 0.

const num = z.number().nullable();
const str = z.string().nullable();

export const redirectSchema = z.object({ redirect_symbol: z.string() });

export const quoteSchema = z.object({
  ltp: num,
  prev_close: num.optional(),
  change: num.optional(),
  change_pct: num.optional(),
  day_high: num.optional(),
  day_low: num.optional(),
  wk52_high: num.optional(),
  wk52_low: num.optional(),
  volume: num.optional(),
  market_cap_cr: num.optional(),
  quote_ts: str.optional(),
  source: z.string().optional(),
});
export type Quote = z.infer<typeof quoteSchema>;

export const freshnessSchema = z.object({
  prices_stale: z.boolean(),
  holidays_missing: z.boolean(),
  prices_as_of: str,
  fundamentals_as_of: str.optional(),
  shareholding_as_of: str.optional(),
  predictions_as_of: str.optional(),
});

export const profileDataSchema = z.object({
  id: z.number(),
  symbol: z.string(),
  name: z.string(),
  isin: str.optional(),
  series: str.optional(),
  sector: str.optional(),
  industry: str.optional(),
  company_type: z.string(),
  status: z.string(),
  instrument_kind: z.string(),
  listing_date: str.optional(),
  broker_ok: z.boolean().nullable().optional(),
  tracked: z.boolean().optional(),
  price_mode: z.string(),
  quote: quoteSchema.nullable().optional(),
  freshness: freshnessSchema,
  flags: z.object({
    no_prices: z.boolean(),
    limited_history: z.boolean(),
    series_warning: str,
  }),
  hint: z.string().optional(),
  backfill: z
    .object({ status: z.string(), job_id: z.number().nullable().optional() })
    .nullable()
    .optional(),
});
export type StockProfile = z.infer<typeof profileDataSchema>;

export const profileSchema = z.union([redirectSchema, profileDataSchema]);

const barSchema = z.tuple([z.string(), z.number(), z.number(), z.number(), z.number(), z.number()]);
export type Bar = z.infer<typeof barSchema>;

export const pricesDataSchema = z.object({
  bars: z.array(barSchema),
  adjusted: z.boolean(),
  actions: z.array(z.object({ date: z.string(), type: z.string(), label: z.string() })),
  range: z.string().optional(),
  limited_history: z.boolean().optional(),
  depth: z.object({ first_bar: z.string(), last_bar: z.string(), bars: z.number() }).optional(),
});
export type PricesData = z.infer<typeof pricesDataSchema>;

export const pricesSchema = z.union([redirectSchema, pricesDataSchema]);

const metricMap = z.record(z.string(), z.number().nullable());

const scoreSchema = z
  .object({
    score: z.number().nullable().optional(),
    label: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .passthrough();
export type Score = z.infer<typeof scoreSchema>;

export const indicatorsDataSchema = z.object({
  as_of: z.string(),
  bars: z.number().optional(),
  price_basis: z.string().optional(),
  source: z.string().optional(),
  last_close: z.number().nullable().optional(),
  returns: z.object({
    trading: metricMap.optional(),
    calendar: metricMap,
    risk: z.record(z.string(), z.number().nullable()).optional(),
  }),
  technicals: z.record(z.string(), z.unknown()),
  scores: z
    .object({
      trend: scoreSchema.nullable().optional(),
      risk: scoreSchema.nullable().optional(),
      quality: scoreSchema.nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  null_reasons: z.record(z.string(), z.string()).optional(),
  units: z.record(z.string(), z.string()).optional(),
  warnings: z.array(z.unknown()).optional(),
  series: z.unknown().optional(),
  analysis: z.unknown().optional(),
});
export type IndicatorsData = z.infer<typeof indicatorsDataSchema>;

export const indicatorsSchema = z.union([redirectSchema, indicatorsDataSchema]);

export const actionSchema = z.object({
  id: z.number(),
  ex_date: z.string(),
  record_date: str.optional(),
  type: z.string(),
  status: z.string(),
  ratio_num: num.optional(),
  ratio_den: num.optional(),
  amount_per_share: num.optional(),
  purpose_text: z.string().optional(),
  source: z.string().optional(),
});
export type CorporateAction = z.infer<typeof actionSchema>;

export const calendarEventSchema = z.object({
  event_date: z.string(),
  type: z.string(),
  details: str.optional(),
  source: z.string().optional(),
});

export const eventsDataSchema = z.object({
  actions: z.array(actionSchema),
  calendar: z.array(calendarEventSchema),
  reason: str.optional(),
  entry_hint: str.optional(),
});
export type EventsData = z.infer<typeof eventsDataSchema>;
export const eventsSchema = z.union([redirectSchema, eventsDataSchema]);

export const linksDataSchema = z.object({
  links: z.array(z.object({ label: z.string(), url: z.string() })),
});
export type LinksData = z.infer<typeof linksDataSchema>;
export const linksSchema = z.union([redirectSchema, linksDataSchema]);

export const fundamentalsKpiSchema = z.object({
  ratios: z.record(z.string(), z.number().nullable()).nullable().optional(),
  valuation: z
    .record(z.string(), z.union([z.number(), z.string()]).nullable())
    .nullable()
    .optional(),
  ratios_reason: str.optional(),
  valuation_reason: str.optional(),
  derived_as_of: str.optional(),
  last_updated: str.optional(),
  last_updated_source: str.optional(),
  entry_hint: str.optional(),
});
export type FundamentalsKpi = z.infer<typeof fundamentalsKpiSchema>;
export const fundamentalsSchema = z.union([redirectSchema, fundamentalsKpiSchema]);

export const watchlistSchema = z.object({
  stocks: z.array(z.object({ id: z.number(), symbol: z.string() }).passthrough()),
});

export function isRedirect<T extends object>(
  v: T | { redirect_symbol: string },
): v is {
  redirect_symbol: string;
} {
  return "redirect_symbol" in v;
}
