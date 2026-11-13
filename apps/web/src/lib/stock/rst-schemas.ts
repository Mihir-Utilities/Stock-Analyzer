import { z } from "zod";
import type { Block } from "@/lib/stock/inv-schemas";

// `analysis.relative_strength` (docs/03 section 4a.RST, docs/05 12.14). Parsed on its own so a bad
// value never touches another card, and each scalar degrades to null on its own (`.catch`): an
// unexpected value becomes an unknown (an em dash with a reason), never 0, NaN or Infinity.

function compact<T>(rows: Array<T | null>): T[] {
  return rows.filter((r): r is T => r !== null);
}

const num = z.number().finite().nullish().catch(null);
const str = z.string().nullish().catch(null);
const bool = z.boolean().nullish().catch(null);
const int = z.number().int().nonnegative().nullish().catch(null);

const indexWindow = z.object({
  key: z.string(),
  rows: int,
  stock_pct: num,
  index_pct: num,
  excess_pp: num,
  reason: str,
});

const yearRow = z.object({
  year: z.number().int(),
  kind: z.enum(["full", "ytd"]).nullish().catch(null),
  base_date: str,
  end_date: str,
  stock_pct: num,
  index_pct: num,
  excess_pp: num,
});

const rollingYear = z
  .object({
    windows: int,
    independent_periods: int,
    share_beat_pct: num,
    median_excess_pp: num,
    small_sample: bool,
    reason: str,
  })
  .nullish()
  .catch(null);

const vsIndex = z.object({
  index_code: str,
  index_as_of: str,
  index_rows: int,
  aligned_rows: int,
  first_aligned: str,
  last_aligned: str,
  dropped_stock_dates: int,
  dropped_index_dates: int,
  windows: z.array(indexWindow.nullable().catch(null)).transform(compact).catch([]),
  years: z.array(yearRow.nullable().catch(null)).transform(compact).catch([]),
  rolling_year: rollingYear,
  ratio_rebased: z.array(num).nullish().catch(null),
  ratio_base_date: str,
  ratio_reason: str,
});
export type VsIndex = z.infer<typeof vsIndex>;
export type IndexWindow = z.infer<typeof indexWindow>;

const peerWindow = z.object({
  key: z.string(),
  rows: int,
  stock_pct: num,
  n_peers: int,
  n_total: int,
  rank: int,
  percentile: num,
  peer_median_pct: num,
  vs_median_pp: num,
  small_sample: bool,
  reason: str,
});
export type PeerWindow = z.infer<typeof peerWindow>;

const vsPeers = z.object({
  sector: str,
  as_of: str,
  peers_in_sector: int,
  excluded: int,
  windows: z.array(peerWindow.nullable().catch(null)).transform(compact).catch([]),
});
export type VsPeers = z.infer<typeof vsPeers>;

export const relativeStrengthSchema = z.object({
  as_of: str,
  bars: int,
  basis: str,
  vs_index: vsIndex.nullish().catch(null),
  vs_index_reason: str,
  vs_peers: vsPeers.nullish().catch(null),
  vs_peers_reason: str,
});
export type RelativeStrength = z.infer<typeof relativeStrengthSchema>;

export interface ParsedRelativeStrength {
  block: Block<RelativeStrength>;
  /** The dates of `analysis.drawdown` pairs: the rows `ratio_rebased` is aligned to (docs/03 4a.RST). */
  dates: string[];
}

const pairDates = z
  .array(z.tuple([z.string(), z.unknown()]).nullable().catch(null))
  .transform((rows) => compact(rows).map((r) => r[0]));

/** Parses the block of `data.analysis` and the date axis its ratio line needs. */
export function parseRelativeStrength(analysis: unknown): ParsedRelativeStrength {
  const a =
    analysis !== null && typeof analysis === "object" ? (analysis as Record<string, unknown>) : {};
  const raw = a["relative_strength"];
  const dates = pairDates.safeParse(a["drawdown"]);
  const axis = dates.success ? dates.data : [];
  if (raw === undefined || raw === null) return { block: { kind: "missing" }, dates: axis };
  const r = relativeStrengthSchema.safeParse(raw);
  return { block: r.success ? { kind: "ok", value: r.data } : { kind: "error" }, dates: axis };
}
