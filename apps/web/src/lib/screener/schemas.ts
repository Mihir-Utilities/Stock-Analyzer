import { z } from "zod";

// Web side of the B13 contract (docs/03 sections 5, 8, 9; OpenAPI `data` is untyped, so these are
// the runtime schemas). Fields that can be unknown are nullable; nothing is defaulted to 0.

const str = z.string().nullable();
const num = z.number().nullable();
const metricValue = z.union([z.number(), z.string()]).nullable();

/** Per-stock last updated stamp (decision D-R). */
export const stampShape = {
  last_updated: str,
  last_updated_source: str,
  stale: z.boolean(),
  stale_reason: str,
};

export const filterSchema = z.object({
  metric: z.string(),
  op: z.string(),
  value: z.union([z.number(), z.string(), z.array(z.number()), z.array(z.string())]),
});
export type FilterSpec = z.infer<typeof filterSchema>;

export const specSchema = z.object({
  filters: z.array(filterSchema),
  sort: z.object({ metric: z.string(), dir: z.string() }).nullish(),
  columns: z.array(z.string()).nullish(),
  universe: z
    .object({
      index: z.string().nullish(),
      kind: z.string().nullish(),
      company_type: z.string().nullish(),
    })
    .nullish(),
});
export type ScreenSpec = z.infer<typeof specSchema>;

export const screenerItemSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  as_of: z.string().nullish(),
  values: z.record(z.string(), metricValue),
  value_reasons: z.record(z.string(), z.string()).nullish(),
  coverage: z.number(),
  ...stampShape,
});
export type ScreenerItem = z.infer<typeof screenerItemSchema>;

export const screenerPageSchema = z.object({
  items: z.array(screenerItemSchema),
  next_cursor: str,
  total: z.number().nullable(),
  units: z.record(z.string(), z.string()),
});
export type ScreenerPage = z.infer<typeof screenerPageSchema>;

export const savedScreenSchema = z.object({
  name: z.string(),
  spec: specSchema,
  saved_at: z.string().nullish(),
});
export type SavedScreen = z.infer<typeof savedScreenSchema>;

export const presetSchema = z.object({ name: z.string(), spec: specSchema });
export type Preset = z.infer<typeof presetSchema>;

export const savedListSchema = z.object({
  items: z.array(savedScreenSchema),
  next_cursor: str.optional(),
  max_saved: z.number(),
  presets: z.array(presetSchema),
});
export type SavedList = z.infer<typeof savedListSchema>;

export const okSchema = z.object({ ok: z.boolean() });

// ---- compare -----------------------------------------------------------------------------------

export const compareSymbolSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  bars: z.number(),
  first_date: str,
  last_date: str,
  short_history: z.boolean(),
  prices_reason: str,
  metrics_as_of: str,
  ...stampShape,
});
export type CompareSymbol = z.infer<typeof compareSymbolSchema>;

export const compareSchema = z.object({
  range: z.string(),
  symbols: z.array(compareSymbolSchema),
  rebased: z.object({
    base_date: str,
    dates: z.array(z.string()),
    series: z.record(z.string(), z.array(z.number()).nullable()),
    unit: z.string(),
    reason: str,
  }),
  metrics: z.record(z.string(), z.record(z.string(), metricValue)),
  metric_reasons: z.record(z.string(), z.record(z.string(), z.string())).nullish(),
  units: z.record(z.string(), z.string()),
  best: z.record(z.string(), str),
});
export type CompareResult = z.infer<typeof compareSchema>;

// ---- peers -------------------------------------------------------------------------------------

export const PEER_METRICS = [
  "market_cap_cr",
  "ret_1y",
  "pe",
  "pb",
  "roe",
  "rev_growth_3y",
  "op_margin",
  "debt_equity",
] as const;

export const peerRowSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  origin: z.string(),
  market_cap_cr: num,
  ret_1y: num,
  pe: num,
  pb: num,
  roe: num,
  rev_growth_3y: num,
  op_margin: num,
  debt_equity: num,
  value_reasons: z.record(z.string(), z.string()).nullish(),
  percentile_rank: z.record(z.string(), num).nullish(),
  as_of: str.optional(),
  ...stampShape,
});
export type PeerRow = z.infer<typeof peerRowSchema>;

export const peersSchema = z.object({
  symbol: z.string(),
  sector: str,
  industry: str,
  basis: z.string(),
  market_cap_band: z.string(),
  note: str,
  units: z.record(z.string(), z.string()),
  peers: z.array(peerRowSchema),
  self: peerRowSchema,
  percentile_method: z.string(),
});
export type PeersResult = z.infer<typeof peersSchema>;
export const peersResponseSchema = z.union([
  z.object({ redirect_symbol: z.string() }),
  peersSchema,
]);
