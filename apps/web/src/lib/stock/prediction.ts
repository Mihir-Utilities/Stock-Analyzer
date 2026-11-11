import { z } from "zod";
import type { ChartDataset } from "@/components/charts/chart-data";
import { apiRequest } from "@/lib/api/client";
import { formatFraction } from "@/lib/format";
import { redirectSchema } from "./schemas";

// Prediction tab model (docs/06 6.4, docs/03 section 6, docs/05 section 10, B14-1/2/7). Pure except
// the request. Every field degrades on its own: a value of an unexpected type becomes null and an
// unknown enum value keeps its raw text, so one odd field never blanks the tab. `p_up` and the band
// returns are FRACTIONS (0.054 = 5.4%); there is no single-price forecast field anywhere in this model.

const numN = z.number().nullish().catch(null);
const strN = z.string().nullish().catch(null);

const modelCardSchema = z
  .object({
    version: z.string().catch(""),
    trained_at: strN,
    oos_auc: numN,
    oos_brier: numN,
    baseline_brier: numN,
    folds: numN,
    guardrail_pass: z.boolean().catch(false),
  })
  .nullish()
  .catch(null);

const trackRecordSchema = z
  .object({
    resolved: z.number().catch(0),
    direction_hit_rate: numN,
    band_coverage_80: numN,
    since: strN,
    reason: strN,
  })
  .nullish()
  .catch(null);

const scoreSchema = z.object({ score: numN, label: strN, reason: strN }).nullish().catch(null);

const bandSchema = z
  .object({
    q10: numN,
    q50: numN,
    q90: numN,
    price_q10: numN,
    price_q50: numN,
    price_q90: numN,
  })
  .nullish()
  .catch(null);

const horizonSchema = z.object({
  days: z.number().catch(0),
  shown: z.boolean().catch(false),
  p_up: numN,
  bucket: strN,
  band: bandSchema,
  hidden_reason: strN,
  model: modelCardSchema,
  track_record: trackRecordSchema,
});

export const predictionDataSchema = z.object({
  experimental: z.boolean().catch(true),
  disclaimer: strN,
  state: z.string().catch("unknown"),
  state_reason: strN,
  as_of: strN,
  ref_close: numN,
  ref_close_reason: strN,
  horizons: z.array(horizonSchema.nullable().catch(null)).catch([]),
  trend: scoreSchema,
  risk: scoreSchema,
  model: modelCardSchema,
  track_record: trackRecordSchema,
});

export type PredictionData = z.infer<typeof predictionDataSchema>;
export type Horizon = z.infer<typeof horizonSchema>;
export type ModelCard = NonNullable<z.infer<typeof modelCardSchema>>;
export type TrackRecord = NonNullable<z.infer<typeof trackRecordSchema>>;
export type ScoreLabel = NonNullable<z.infer<typeof scoreSchema>>;

export const predictionSchema = z.union([redirectSchema, predictionDataSchema]);

export const predictionKey = (symbol: string) => ["stocks", symbol, "prediction"] as const;

export const getPrediction = (symbol: string) =>
  apiRequest(`/stocks/${encodeURIComponent(symbol)}/prediction`, { schema: predictionSchema });

/** Shown when the API sends no disclaimer (it always should); the banner is never hidden. */
export const DEFAULT_DISCLAIMER =
  "Experimental. Not investment advice. Statistical models often fail out of sample.";

export const BUCKET_TEXT: Record<string, string> = {
  strongly_down: "Leans strongly down",
  slightly_down: "Leans slightly down",
  neutral: "No clear direction",
  slightly_up: "Leans slightly up",
  strongly_up: "Leans strongly up",
};

export function bucketText(bucket: string | null | undefined): string {
  return (bucket ? BUCKET_TEXT[bucket] : undefined) ?? "Direction not classified";
}

/** Plain-language copy for each `hidden_reason` enum value (docs/03 section 6). */
export const HIDDEN_REASON_TEXT: Record<string, string> = {
  model_not_better_than_baseline:
    "The model did not beat a simple baseline in testing, so its forecast is hidden. A forecast that is no better than a coin toss is not shown.",
  insufficient_history:
    "Not enough price history for this stock (the model needs at least two years of daily prices). Import more history to enable it.",
  low_liquidity: "This stock trades too thinly for a forecast to mean anything, so none is shown.",
  near_corporate_action:
    "A split, bonus or other corporate action is close, or one is waiting for your confirmation. Confirm the possible split first on the Events tab.",
  no_model:
    "No model is active for this horizon yet. A model is trained once enough stocks have imported price history.",
  stale_data:
    "The latest price data is more than 3 trading days old, so the forecast is hidden until prices are imported again.",
};

export function hiddenReasonText(reason: string | null | undefined): string {
  const known = reason ? HIDDEN_REASON_TEXT[reason] : undefined;
  return (
    known ??
    "This forecast is hidden for a reason this page does not recognise. No numbers are shown."
  );
}

/** Whole-tab state copy (B14-1). The API's `state_reason` is shown next to it. */
export const STATE_TEXT: Record<string, string> = {
  no_model: "No forecasting model has been trained yet. Nothing is predicted for this stock.",
  insufficient_universe:
    "Not enough tracked stocks to train a model. Forecasts need at least 20 tracked stocks with about three years of imported daily prices each. Import prices for more stocks to enable them.",
  insufficient_history: "Not enough price history to train or show a model yet.",
  guardrail_failed:
    "The latest model did not pass its accuracy checks in testing, so its forecasts are hidden.",
};

export function horizonLabel(days: number): string {
  return `Next ${days} trading days`;
}

export interface UsableBand {
  q10: number;
  q50: number;
  q90: number;
  priceQ10: number | null;
  priceQ90: number | null;
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** A horizon's band, only when it is shown AND complete; else null (a hidden horizon has no numbers). */
export function usableBand(h: Horizon): UsableBand | null {
  if (!h.shown || !h.band) return null;
  const { q10, q50, q90, price_q10, price_q90 } = h.band;
  if (!finite(q10) || !finite(q50) || !finite(q90)) return null;
  return {
    q10,
    q50,
    q90,
    priceQ10: finite(price_q10) ? price_q10 : null,
    priceQ90: finite(price_q90) ? price_q90 : null,
  };
}

export function horizonList(d: PredictionData): Horizon[] {
  return d.horizons.filter((h): h is Horizon => h !== null && h.days > 0);
}

/** A model card or track record to show for a horizon, falling back to the top-level mirror once. */
export function cardsOf(d: PredictionData): {
  days: number | null;
  model: ModelCard | null;
  track: TrackRecord | null;
}[] {
  const own = horizonList(d)
    .filter((h) => h.model || h.track_record)
    .map((h) => ({ days: h.days, model: h.model ?? null, track: h.track_record ?? null }));
  if (own.length > 0) return own;
  if (d.model || d.track_record) {
    return [{ days: null, model: d.model ?? null, track: d.track_record ?? null }];
  }
  return [];
}

const pctFromPercent = (v: number) => formatFraction(v / 100, { decimals: 1, signed: true }).text;

/**
 * Fan chart: return versus the last close at "Now" (0 by definition) and at each shown horizon, as
 * dashed forecast lines (10th, 50th, 90th percentile). Hidden horizons are gaps, not zeros.
 */
export function fanDataset(d: PredictionData): ChartDataset | null {
  const hs = horizonList(d);
  if (!hs.some((h) => usableBand(h) !== null)) return null;
  const mk = (id: string, name: string, pick: (b: UsableBand) => number) => ({
    id,
    name,
    unit: "%",
    kind: "line" as const,
    forecast: true,
    format: pctFromPercent,
    nullReason: "forecast hidden for this horizon",
    values: [
      0,
      ...hs.map((h) => {
        const b = usableBand(h);
        return b ? pick(b) * 100 : null;
      }),
    ],
  });
  return {
    xName: "Horizon",
    x: ["Now", ...hs.map((h) => `${h.days} days`)],
    series: [
      mk("q90", "90th percentile (upper end of the 80% range)", (b) => b.q90),
      mk("q50", "Median", (b) => b.q50),
      mk("q10", "10th percentile (lower end of the 80% range)", (b) => b.q10),
    ],
    source: "Experimental model trained on your imported prices",
    asOf: d.as_of ?? null,
  };
}

/** Live track record: observed rates next to what chance / a calibrated band would give. */
export function trackDataset(t: TrackRecord): ChartDataset | null {
  const hit = t.direction_hit_rate;
  const cov = t.band_coverage_80;
  if (t.resolved <= 0 || !finite(hit) || !finite(cov)) return null;
  const fmt = (v: number) => formatFraction(v / 100, { decimals: 1 }).text;
  return {
    xName: "Measure",
    x: ["Direction hit rate", "80% band coverage"],
    series: [
      {
        id: "live",
        name: "Live result",
        unit: "%",
        kind: "bar",
        values: [hit * 100, cov * 100],
        format: fmt,
      },
      {
        id: "ref",
        name: "Reference (chance, and the 80% goal)",
        unit: "%",
        kind: "bar",
        values: [50, 80],
        format: fmt,
      },
    ],
    source: "Live predictions resolved against later closes",
    asOf: t.since ?? null,
  };
}
