import { z } from "zod";
import type { Block } from "@/lib/stock/inv-schemas";

// `analysis.swing_dips` (docs/03 4a-swing, docs/05 12.13). Optional (an older snapshot lacks it) and
// parsed ON ITS OWN, so a malformed block degrades this card only. Inside the block each scalar
// degrades to null on its own (`.catch`): an unexpected value becomes an unknown (an em dash with a
// reason), never 0, NaN or Infinity; one bad row never blanks a table.

function compact<T>(rows: Array<T | null>): T[] {
  return rows.filter((r): r is T => r !== null);
}

const num = z.number().finite().nullish().catch(null);
const str = z.string().nullish().catch(null);
const bool = z.boolean().nullish().catch(null);
const int = z.number().int().nonnegative().nullish().catch(null);

const record = z.object({
  peak_date: str,
  peak_close: num,
  low_date: str,
  low_close: num,
  depth_pct: num,
  days_peak_to_low: int,
  recovery_date: str,
  days_low_to_recovery: int,
  days_low_to_recovery_reason: str,
  status: z.enum(["recovered", "open", "superseded"]).nullish().catch(null),
});
export type SwingRecord = z.infer<typeof record>;

const dipRow = z.object({
  threshold_pct: z.number().int(),
  dips: int,
  recovered: int,
  superseded: int,
  open: int,
  recovered_share_pct: num,
  recovered_share_reason: str,
  median_depth_pct: num,
  median_depth_reason: str,
  worst_depth_pct: num,
  worst_depth_reason: str,
  median_days_peak_to_low: num,
  median_days_peak_to_low_reason: str,
  median_days_to_recover: num,
  median_days_to_recover_reason: str,
  longest_open_days: int,
  longest_open_reason: str,
  small_sample: bool,
  reason: str,
  records: z.array(record.nullable().catch(null)).transform(compact).catch([]),
});
export type SwingDipRow = z.infer<typeof dipRow>;

const legRow = z.object({
  threshold_pct: z.number().int(),
  legs: int,
  bounced: int,
  open: int,
  median_depth_pct: num,
  median_depth_reason: str,
  worst_depth_pct: num,
  worst_depth_reason: str,
  median_days_peak_to_low: num,
  median_days_peak_to_low_reason: str,
  median_days_to_bounce: num,
  median_days_to_bounce_reason: str,
  small_sample: bool,
  reason: str,
});
export type SwingLegRow = z.infer<typeof legRow>;

export const swingDipsSchema = z.object({
  as_of: str,
  bars: int,
  window_rows: int,
  min_episodes: int,
  thresholds: z.array(dipRow.nullable().catch(null)).transform(compact).catch([]),
  zigzag: z.array(legRow.nullable().catch(null)).transform(compact).catch([]),
});
export type SwingDips = z.infer<typeof swingDipsSchema>;

export interface SwingParsed {
  block: Block<SwingDips>;
  /** `compute_error` when the worker could not compute the block (the block is then null). */
  reason: string | null;
}

/** Parses `analysis.swing_dips` and its reason; never throws. */
export function parseSwingDips(analysis: unknown): SwingParsed {
  const a =
    analysis !== null && typeof analysis === "object" ? (analysis as Record<string, unknown>) : {};
  const raw = a["swing_dips"];
  const reason = typeof a["swing_dips_reason"] === "string" ? a["swing_dips_reason"] : null;
  if (raw === undefined || raw === null) {
    return { block: { kind: "missing" }, reason };
  }
  const r = swingDipsSchema.safeParse(raw);
  return { block: r.success ? { kind: "ok", value: r.data } : { kind: "error" }, reason: null };
}
