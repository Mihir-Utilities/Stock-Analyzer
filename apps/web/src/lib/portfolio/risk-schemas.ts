import { z } from "zod";
import { readRows, readSection } from "./mf-schemas";

// Response shape of GET /portfolio/risk (docs/03 section 12b). Degrade per field: every optional
// field falls back to null on a wrong value, rows are validated one by one, and a section that cannot
// be read at all is reported as such, so one bad value never blanks the section. Money fields are
// decimal STRINGS with 4 decimals, percent fields are percent numbers, `hhi` and `index` are plain
// numbers. The browser computes none of them.

const s = z.string().nullish().catch(null);
const n = z.number().nullish().catch(null);
const b = z.boolean().nullish().catch(null);

export const holdingWeightSchema = z.object({
  key: z.string(),
  name: z.string().catch(""),
  asset_class: z.string().catch(""),
  group: z.string().catch("Unclassified"),
  value: s,
  weight_pct: n,
  weight_reason: s,
});
export type HoldingWeight = z.infer<typeof holdingWeightSchema>;

export const groupWeightSchema = z.object({
  key: z.string(),
  kind: z.string().catch(""),
  value: s,
  weight_pct: n,
  holdings: n,
});
export type GroupWeight = z.infer<typeof groupWeightSchema>;

export const concentrationSchema = z.object({
  total_value: s,
  total_value_reason: s,
  holdings_count: n,
  top1_pct: n,
  top3_pct: n,
  top5_pct: n,
  shares_reason: s,
  hhi: n,
  effective_holdings: n,
  hhi_reason: s,
  group_hhi: n,
  group_top1_pct: n,
  group_reason: s,
  by_holding: z.unknown(),
  by_group: z.unknown(),
});

export const stressItemSchema = z.object({
  key: z.string(),
  name: z.string().catch(""),
  asset_class: z.string().catch(""),
  value: s,
  impact_10: s,
  impact_10_pct: n,
  impact_20: s,
  impact_20_pct: n,
  impact_reason: s,
});
export type StressItem = z.infer<typeof stressItemSchema>;

export const stressSchema = z.object({
  label: s,
  falls_pct: z.array(z.number()).nullish().catch(null),
  items: z.unknown(),
});

export const pointSchema = z.object({
  date: z.string(),
  value: z.string(),
  index: z.number().finite(),
  drawdown_pct: z.number().finite(),
});
export type Point = z.infer<typeof pointSchema>;

export const gapSchema = z.object({
  from: z.string(),
  to: z.string(),
  dates: z.number(),
  reason: z.string().catch(""),
});
export type Gap = z.infer<typeof gapSchema>;

const maxDrawdownSchema = z.object({
  depth_pct: n,
  peak_date: s,
  trough_date: s,
  recovery_date: s,
  recovered: b,
});

export const historySchema = z.object({
  basis: s,
  base: n,
  series_reason: s,
  from: s,
  to: s,
  points_count: n,
  points: z.unknown(),
  gaps: z.unknown(),
  gap_dates_total: n,
  gaps_truncated: b,
  skipped_steps: n,
  current_drawdown_pct: n,
  peak_date: s,
  peak_index: n,
  days_under_water: n,
  drawdown_reason: s,
  max_drawdown: maxDrawdownSchema.nullish().catch(null),
  twr_since_start_pct: n,
});

export const riskSchema = z.object({
  view: s,
  as_of: s,
  currency: s,
  concentration: z.unknown(),
  stress: z.unknown(),
  history: z.unknown(),
});

export interface ReadRisk {
  view: string | null;
  asOf: string | null;
  /** null = missing or unreadable (the block then says so). */
  concentration:
    | (z.infer<typeof concentrationSchema> & {
        rows: HoldingWeight[];
        groups: GroupWeight[];
        bad: number;
      })
    | null;
  stress:
    | (z.infer<typeof stressSchema> & {
        rows: StressItem[];
        bad: number;
      })
    | null;
  history:
    | (z.infer<typeof historySchema> & {
        pointRows: Point[];
        gapRows: Gap[];
        bad: number;
      })
    | null;
}

/** Reads the `data` of GET /portfolio/risk block by block; a bad block is null, never a throw. */
export function readRisk(raw: unknown): ReadRisk {
  const top = readSection(riskSchema, raw);
  if (!top) return { view: null, asOf: null, concentration: null, stress: null, history: null };
  const c = readSection(concentrationSchema, top.concentration);
  const st = readSection(stressSchema, top.stress);
  const h = readSection(historySchema, top.history);
  const byHolding = c ? readRows(holdingWeightSchema, c.by_holding) : null;
  const byGroup = c ? readRows(groupWeightSchema, c.by_group) : null;
  const items = st ? readRows(stressItemSchema, st.items) : null;
  const pts = h ? readRows(pointSchema, h.points) : null;
  const gaps = h ? readRows(gapSchema, h.gaps) : null;
  return {
    view: top.view ?? null,
    asOf: top.as_of ?? null,
    concentration:
      c && byHolding?.ok && byGroup?.ok
        ? { ...c, rows: byHolding.rows, groups: byGroup.rows, bad: byHolding.bad + byGroup.bad }
        : null,
    stress: st && items?.ok ? { ...st, rows: items.rows, bad: items.bad } : null,
    history:
      h && pts?.ok && gaps?.ok
        ? { ...h, pointRows: pts.rows, gapRows: gaps.rows, bad: pts.bad + gaps.bad }
        : null,
  };
}
