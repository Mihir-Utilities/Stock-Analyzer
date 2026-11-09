import { z } from "zod";

// Web side of the /mf/* contract (docs/03 section 10 and the B10 implementation notes; the
// OpenAPI `data` schemas are untyped). Tolerant of extra keys; everything that can be unknown is
// nullable, never defaulted to 0.

const num = z.number().nullable();
const str = z.string().nullable();

export const schemeItemSchema = z.object({
  code: z.number(),
  name: z.string(),
  fund_house: str,
  category: str,
  plan: z.string(),
  option: z.string(),
  status: z.string(),
  latest_nav: num,
  last_nav_date: str,
  return_1y_pct: num,
  returns_as_of: str,
});
export type SchemeItem = z.infer<typeof schemeItemSchema>;

export const fundGroupSchema = z.object({
  name: z.string(),
  fund_house: str,
  category: str,
  variants: z.array(schemeItemSchema),
});
export type FundGroup = z.infer<typeof fundGroupSchema>;

export const searchSchema = z.object({
  items: z.array(z.union([fundGroupSchema, schemeItemSchema])),
  next_cursor: str,
  attribution: z.string().optional(),
});
export type SearchPage = z.infer<typeof searchSchema>;

export function isGroup(i: SchemeItem | FundGroup): i is FundGroup {
  return "variants" in i;
}

export const categoriesSchema = z.object({ items: z.array(z.string()) });

export const rollingSchema = z
  .object({
    min: num,
    median: num,
    max: num,
    pct_positive: num,
    count: z.number(),
  })
  .nullable()
  .optional();
export type Rolling1Y = z.infer<typeof rollingSchema>;

export const navJumpSchema = z.object({ date: z.string(), change_pct: z.number() });

const riskSchema = z.object({
  volatility_pct: num,
  volatility_reason: str,
  volatility_years: num,
  max_drawdown_pct: num,
  sharpe_like: num,
  sharpe_reason: str,
  risk_free_rate: num,
});

export const detailSchema = z.object({
  code: z.number(),
  name: z.string(),
  fund_house: str,
  scheme_type: str.optional(),
  category: str,
  plan: z.string(),
  option: z.string(),
  status: z.string(),
  first_nav_date: str,
  nav_count: z.number(),
  latest_nav: z.object({ value: z.number(), date: z.string(), unit: z.string() }).nullable(),
  returns: z.record(z.string(), num),
  return_basis: z.record(z.string(), z.string()).nullable().optional(),
  return_reasons: z.record(z.string(), z.string()).nullable().optional(),
  risk: riskSchema.nullable(),
  rolling_1y: rollingSchema,
  nav_jumps: z.array(navJumpSchema).nullable().optional(),
  metrics_as_of: str.optional(),
  backfill: z.object({ status: z.string(), job_id: z.number().nullable() }).nullable().optional(),
  attribution: z.string().optional(),
});
export type SchemeDetail = z.infer<typeof detailSchema>;

const point = z.tuple([z.string(), z.number()]);

export const navSchema = z.object({
  code: z.number(),
  range: z.string(),
  log: z.boolean(),
  unit: z.string(),
  points: z.array(point),
  raw_count: z.number(),
  downsampled: z.boolean(),
  attribution: z.string().optional(),
});
export type NavSeries = z.infer<typeof navSchema>;

const installmentSchema = z.object({
  date: z.string(),
  nav_date: z.string(),
  nav: z.number(),
  units: z.string(),
});

export const sipSchema = z.object({
  code: z.number(),
  amount: z.string(),
  start: z.string(),
  end: z.string(),
  day: z.number(),
  invested: z.string(),
  value: str,
  units: z.string(),
  absolute_return_pct: num,
  xirr_pct: num,
  xirr_reason: str,
  installments: z.number(),
  skipped_installments: z.number(),
  end_nav_date: str,
  end_nav: num,
  schedule: z.array(installmentSchema).nullable(),
  attribution: z.string().optional(),
});
export type SipResult = z.infer<typeof sipSchema>;
export type SipInstallment = z.infer<typeof installmentSchema>;

export const compareSchema = z.object({
  range: z.string(),
  common_start: z.string(),
  common_end: z.string(),
  base: z.number(),
  different_starts: z.boolean(),
  series: z.array(z.object({ code: z.number(), name: z.string(), points: z.array(point) })),
  table: z.array(
    z.object({
      code: z.number(),
      name: z.string(),
      first_nav_date: z.string(),
      history_shorter_than_range: z.boolean(),
      return_pct: num,
      return_basis: z.string(),
      volatility_pct: num,
      volatility_reason: str,
      max_drawdown_pct: num,
    }),
  ),
  attribution: z.string().optional(),
});
export type CompareResult = z.infer<typeof compareSchema>;

export const startedSchema = z.object({ job_id: z.number().optional(), id: z.number().optional() });
export const watchFundsSchema = z.object({
  funds: z.array(z.object({ id: z.number(), code: z.number() }).passthrough()),
});
