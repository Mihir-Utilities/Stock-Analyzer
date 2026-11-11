import { z } from "zod";

// Investment-context blocks of `analysis` (docs/03 section 4a, docs/05 section 12). Every block is
// optional (an older snapshot lacks it) and is parsed ON ITS OWN, so one malformed block degrades
// one card and never the tab. Inside a block each scalar degrades to null on its own (`.catch`):
// an unexpected value becomes an unknown (an em dash with a reason), never 0, NaN or Infinity.

/** Drops the rows that failed their own schema (one bad row never blanks a table). */
function compact<T>(rows: Array<T | null>): T[] {
  return rows.filter((r): r is T => r !== null);
}

const num = z.number().finite().nullish().catch(null);
const str = z.string().nullish().catch(null);
const bool = z.boolean().nullish().catch(null);
const int = z.number().int().nonnegative().nullish().catch(null);

const extreme = z.object({ pct: num, year: int }).nullish().catch(null);

const monthStats = z.object({
  month: z.number().int().min(1).max(12),
  n_years: int,
  n_green: int,
  green_pct: num,
  green_pct_reason: str,
  avg_pct: num,
  median_pct: num,
  best: extreme,
  worst: extreme,
  small_sample: bool,
});

const yearsStats = z.object({
  n: int,
  n_green: int,
  green_pct: num,
  green_pct_reason: str,
  avg_pct: num,
  median_pct: num,
  best: extreme,
  worst: extreme,
  small_sample: bool,
});

const monthPick = z
  .object({ month: z.number().int().min(1).max(12), median_pct: num, n_years: int })
  .nullish()
  .catch(null);

export const seasonalitySchema = z.object({
  as_of: str,
  bars: int,
  first_bar: str,
  last_bar: str,
  years_of_history: num,
  min_years: int,
  small_sample_years: int,
  running: z
    .object({
      year: z.number().int(),
      month: z.number().int().min(1).max(12),
      mtd_return_pct: num,
      mtd_reason: str,
      base_date: str,
      as_of: str,
    })
    .nullish()
    .catch(null),
  months: z.array(monthStats.nullable().catch(null)).transform(compact).catch([]),
  best_month: monthPick,
  worst_month: monthPick,
  best_worst_reason: str,
  years: yearsStats.nullish().catch(null),
});
export type Seasonality = z.infer<typeof seasonalitySchema>;

export const yearReturnSchema = z.object({
  year: z.number().int(),
  return_pct: num,
  return_pct_reason: str,
  kind: z.enum(["full", "partial_first", "ytd"]).nullish().catch(null),
  months_covered: int,
  base_date: str,
  end_date: str,
});
export type YearReturn = z.infer<typeof yearReturnSchema>;

export const positionSchema = z.object({
  as_of: str,
  bars: int,
  close: num,
  high_52w_close: num,
  low_52w_close: num,
  range_pos_52w_pct: num,
  range_pos_52w_reason: str,
  range_band: z.enum(["lower", "middle", "upper"]).nullish().catch(null),
  dist_high_52w_pct: num,
  dist_high_all_pct: num,
  high_all_date: str,
  history_first_date: str,
  pctile_52w: num,
  pctile_52w_reason: str,
  pctile_all: num,
  pctile_all_reason: str,
  pctile_all_n: int,
  sma200: num,
  ext_sma200_pct: num,
  ext_sma200_reason: str,
});
export type Position = z.infer<typeof positionSchema>;

const recoverySchema = z.object({
  threshold_pct: z.number(),
  episodes: int,
  recovered: int,
  open: int,
  median_days: num,
  median_days_reason: str,
  small_sample: bool,
});

export const drawdownProfileSchema = z.object({
  as_of: str,
  bars: int,
  first_date: str,
  current_dd_pct: num,
  days_since_high: int,
  max_dd: z
    .object({
      depth_pct: num,
      peak_date: str,
      trough_date: str,
      recovery_date: str,
      recovered: bool,
      reason: str,
    })
    .nullish()
    .catch(null),
  underwater_rows: int,
  time_under_water_pct: num,
  avg_underwater_depth_pct: num,
  avg_underwater_depth_reason: str,
  episodes_total: int,
  recovery: z.array(recoverySchema.nullable().catch(null)).transform(compact).catch([]),
});
export type DrawdownProfile = z.infer<typeof drawdownProfileSchema>;

const holdingWindow = z.object({
  key: z.string(),
  rows: int,
  windows: int,
  independent_periods: int,
  share_positive_pct: num,
  median_pct: num,
  best_pct: num,
  best_end_date: str,
  worst_pct: num,
  worst_end_date: str,
  reason: str,
  small_sample: bool,
});

export const holdingPeriodsSchema = z.object({
  as_of: str,
  bars: int,
  windows: z.array(holdingWindow.nullable().catch(null)).transform(compact).catch([]),
});
export type HoldingPeriods = z.infer<typeof holdingPeriodsSchema>;

const entryRow = z.object({
  drawdown_pct: z.number(),
  horizon: z.string(),
  horizon_rows: int,
  episodes: int,
  pending: int,
  median_pct: num,
  worst_pct: num,
  best_pct: num,
  share_positive_pct: num,
  all_windows_median_pct: num,
  last_event_date: str,
  reason: str,
  small_sample: bool,
});

export const entryStudySchema = z.object({
  as_of: str,
  bars: int,
  w52_rows: int,
  rows: z.array(entryRow.nullable().catch(null)).transform(compact).catch([]),
});
export type EntryStudy = z.infer<typeof entryStudySchema>;

export const volRegimeSchema = z.object({
  as_of: str,
  window_rows: int,
  current_vol_pct: num,
  percentile: num,
  sample: int,
  band: z.enum(["lower", "typical", "higher"]).nullish().catch(null),
  reason: str,
  first_date: str,
});
export type VolRegime = z.infer<typeof volRegimeSchema>;

const sipVariant = z.object({
  day: z.number().int().nullish().catch(null),
  installments: int,
  skipped: int,
  first_date: str,
  last_date: str,
  span_days: int,
  invested_inr: num,
  sip_value_inr: num,
  lump_value_inr: num,
  value_ratio: num,
  sip_absolute_return_pct: num,
  lump_absolute_return_pct: num,
  sip_xirr_pct: num,
  lump_xirr_pct: num,
  xirr_reason: str,
  sip_worst_unrealised_pct: num,
  lump_worst_unrealised_pct: num,
  reason: str,
});
export type SipVariant = z.infer<typeof sipVariant>;

export const sipBacktestSchema = z.object({
  as_of: str,
  amount_per_month_inr: num,
  price_basis: str,
  variants: z.array(sipVariant.nullable().catch(null)).transform(compact).catch([]),
});
export type SipBacktest = z.infer<typeof sipBacktestSchema>;

export const riskAdjustedSchema = z.object({
  as_of: str,
  window: str,
  cagr_3y_pct: num,
  maxdd_3y_window_pct: num,
  calmar_3y: num,
  calmar_3y_reason: str,
  downside_dev_3y_pct: num,
  return_per_downside_3y: num,
  downside_reason: str,
});
export type RiskAdjusted = z.infer<typeof riskAdjustedSchema>;

/** `ok`: parsed; `missing`: the snapshot has no such block (not computed yet); `error`: wrong shape. */
export type Block<T> = { kind: "ok"; value: T } | { kind: "missing" } | { kind: "error" };

function parseBlock<T>(raw: unknown, schema: z.ZodType<T>): Block<T> {
  if (raw === undefined || raw === null) return { kind: "missing" };
  const r = schema.safeParse(raw);
  return r.success ? { kind: "ok", value: r.data } : { kind: "error" };
}

export interface InvBlocks {
  seasonality: Block<Seasonality>;
  yearReturns: Block<YearReturn[]>;
  monthReasons: Array<[number, number, string]>;
  position: Block<Position>;
  drawdown: Block<DrawdownProfile>;
  holding: Block<HoldingPeriods>;
  entry: Block<EntryStudy>;
  vol: Block<VolRegime>;
  sip: Block<SipBacktest>;
  risk: Block<RiskAdjusted>;
}

const reasonsSchema = z
  .array(z.tuple([z.number(), z.number(), z.string()]).nullable().catch(null))
  .transform(compact);

/** Parses every INV block of `data.analysis` separately; a bad block never affects another. */
export function parseInvBlocks(analysis: unknown): InvBlocks {
  const a =
    analysis !== null && typeof analysis === "object" ? (analysis as Record<string, unknown>) : {};
  const reasons = reasonsSchema.safeParse(a["month_year_reasons"]);
  return {
    seasonality: parseBlock(a["seasonality"], seasonalitySchema),
    yearReturns: parseBlock(
      a["year_returns"],
      z.array(yearReturnSchema.nullable().catch(null)).transform(compact),
    ),
    monthReasons: reasons.success ? reasons.data.map((r) => [r[0], r[1], r[2]]) : [],
    position: parseBlock(a["position"], positionSchema),
    drawdown: parseBlock(a["drawdown_profile"], drawdownProfileSchema),
    holding: parseBlock(a["holding_periods"], holdingPeriodsSchema),
    entry: parseBlock(a["entry_study"], entryStudySchema),
    vol: parseBlock(a["vol_regime"], volRegimeSchema),
    sip: parseBlock(a["sip_backtest"], sipBacktestSchema),
    risk: parseBlock(a["risk_adjusted"], riskAdjustedSchema),
  };
}

// ---- Home tile: watchlist `stocks[].seasonality` -------------------------------------------------

export const watchSeasonalitySchema = z.object({
  month: z.number().int().min(1).max(12).nullish().catch(null),
  month_name: str,
  as_of: str,
  data_since: str,
  years_of_history: num,
  n_years: int,
  n_green: int,
  green_pct: num,
  green_pct_reason: str,
  small_sample: bool,
  min_years: int,
  avg_pct: num,
  median_pct: num,
  mtd_return_pct: num,
  mtd_reason: str,
  mtd_as_of: str,
});
export type WatchSeasonality = z.infer<typeof watchSeasonalitySchema>;
