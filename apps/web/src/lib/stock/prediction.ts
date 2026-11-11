import { z } from "zod";
import type { ChartDataset } from "@/components/charts/chart-data";
import { apiRequest } from "@/lib/api/client";
import { formatDate, formatFraction } from "@/lib/format";
import { redirectSchema } from "./schemas";

// Prediction tab model (docs/06 6.4, docs/03 section 6, docs/05 section 10, B14-1/2/7). Pure except
// the request. `p_up` and the band returns are FRACTIONS (0.054 = 5.4%); there is no single-price
// forecast field anywhere in this model.
//
// Reading is per section and honest: a section whose value has the wrong type, or a fraction outside
// 0..1, becomes the explicit UNREADABLE marker. The UI then says "could not be read" (and the
// console logs it) instead of inventing a domain statement such as "no model", "no resolved
// predictions" or "not passed". A boolean or a count is never asserted from a failed read.

export const UNREADABLE = { unreadable: true } as const;
export type Unreadable = typeof UNREADABLE;
export const isUnreadable = (v: unknown): v is Unreadable => v === UNREADABLE;
/** Shown wherever a section is marked unreadable. */
export const UNREADABLE_COPY = "This section could not be read";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOr = (v: unknown): number | null => (finite(v) ? v : null);
const strOr = (v: unknown): string | null => (typeof v === "string" ? v : null);

function unreadable(where: string): Unreadable {
  console.warn(`[prediction] ${where} could not be read; the page shows it as unreadable`);
  return UNREADABLE;
}

/** A fraction (0..1). null/undefined are "not served"; anything else outside 0..1 is unreadable. */
function frac(v: unknown): number | null | Unreadable {
  if (v === null || v === undefined) return null;
  return finite(v) && v >= 0 && v <= 1 ? v : UNREADABLE;
}

export interface ModelCard {
  version: string | null;
  trained_at: string | null;
  oos_auc: number | null;
  oos_brier: number | null;
  baseline_brier: number | null;
  folds: number | null;
  guardrail_pass: boolean;
}

export interface TrackRecord {
  resolved: number;
  direction_hit_rate: number | null;
  band_coverage_80: number | null;
  since: string | null;
  reason: string | null;
}

export interface ScoreLabel {
  score: number | null;
  label: string | null;
  reason: string | null;
}

export interface Band {
  q10: number;
  q50: number;
  q90: number;
  price_q10: number | null;
  price_q50: number | null;
  price_q90: number | null;
}

export interface Horizon {
  days: number;
  /** null: the value was not a boolean (unreadable). */
  shown: boolean | null;
  p_up: number | null | Unreadable;
  bucket: string | null;
  band: Band | null | Unreadable;
  hidden_reason: string | null;
  model: ModelCard | null | Unreadable;
  track_record: TrackRecord | null | Unreadable;
}

export interface PredictionData {
  experimental: boolean;
  disclaimer: string | null;
  /** null: the value was not a string (unreadable). */
  state: string | null;
  state_reason: string | null;
  as_of: string | null;
  ref_close: number | null;
  ref_close_reason: string | null;
  horizons: Horizon[] | Unreadable;
  /** Entries of `horizons` that had no usable `days` (counted, not drawn). */
  unreadable_horizons: number;
  trend: ScoreLabel | null | Unreadable;
  risk: ScoreLabel | null | Unreadable;
  model: ModelCard | null | Unreadable;
  track_record: TrackRecord | null | Unreadable;
}

function readModel(v: unknown, where: string): ModelCard | null | Unreadable {
  if (v === null || v === undefined) return null;
  if (!isRec(v) || typeof v["guardrail_pass"] !== "boolean") return unreadable(where);
  return {
    version: strOr(v["version"]),
    trained_at: strOr(v["trained_at"]),
    oos_auc: numOr(v["oos_auc"]),
    oos_brier: numOr(v["oos_brier"]),
    baseline_brier: numOr(v["baseline_brier"]),
    folds: numOr(v["folds"]),
    guardrail_pass: v["guardrail_pass"],
  };
}

function readTrack(v: unknown, where: string): TrackRecord | null | Unreadable {
  if (v === null || v === undefined) return null;
  if (!isRec(v)) return unreadable(where);
  const resolved = v["resolved"];
  const hit = frac(v["direction_hit_rate"]);
  const cov = frac(v["band_coverage_80"]);
  if (!finite(resolved) || resolved < 0 || !Number.isInteger(resolved)) return unreadable(where);
  if (isUnreadable(hit) || isUnreadable(cov)) return unreadable(where);
  return {
    resolved,
    direction_hit_rate: hit,
    band_coverage_80: cov,
    since: strOr(v["since"]),
    reason: strOr(v["reason"]),
  };
}

function readScore(v: unknown, where: string): ScoreLabel | null | Unreadable {
  if (v === null || v === undefined) return null;
  if (!isRec(v)) return unreadable(where);
  const s = v["score"];
  if (s !== null && s !== undefined && !(finite(s) && s >= 0 && s <= 100)) return unreadable(where);
  return { score: numOr(s), label: strOr(v["label"]), reason: strOr(v["reason"]) };
}

function readBand(v: unknown, where: string): Band | null | Unreadable {
  if (v === null || v === undefined) return null;
  if (!isRec(v) || !finite(v["q10"]) || !finite(v["q50"]) || !finite(v["q90"])) {
    return unreadable(where);
  }
  return {
    q10: v["q10"],
    q50: v["q50"],
    q90: v["q90"],
    price_q10: numOr(v["price_q10"]),
    price_q50: numOr(v["price_q50"]),
    price_q90: numOr(v["price_q90"]),
  };
}

function readHorizon(v: unknown, i: number): Horizon | null {
  if (!isRec(v)) return null;
  const days = v["days"];
  if (!finite(days) || !Number.isInteger(days) || days <= 0) return null;
  const at = `horizons[${i}]`;
  const shown = typeof v["shown"] === "boolean" ? v["shown"] : null;
  if (shown === null) unreadable(`${at}.shown`);
  const pUp = frac(v["p_up"]);
  return {
    days,
    shown,
    p_up: isUnreadable(pUp) ? unreadable(`${at}.p_up`) : pUp,
    bucket: strOr(v["bucket"]),
    band: readBand(v["band"], `${at}.band`),
    hidden_reason: strOr(v["hidden_reason"]),
    model: readModel(v["model"], `${at}.model`),
    track_record: readTrack(v["track_record"], `${at}.track_record`),
  };
}

function normalize(raw: Rec): PredictionData {
  let horizons: Horizon[] | Unreadable;
  let bad = 0;
  if (Array.isArray(raw["horizons"])) {
    const list: Horizon[] = [];
    (raw["horizons"] as unknown[]).forEach((h, i) => {
      const r = readHorizon(h, i);
      if (r) list.push(r);
      else {
        bad += 1;
        unreadable(`horizons[${i}]`);
      }
    });
    horizons = list;
  } else {
    horizons = unreadable("horizons");
  }
  return {
    experimental: typeof raw["experimental"] === "boolean" ? raw["experimental"] : true,
    disclaimer: strOr(raw["disclaimer"]),
    state: typeof raw["state"] === "string" ? raw["state"] : null,
    state_reason: strOr(raw["state_reason"]),
    as_of: strOr(raw["as_of"]),
    ref_close: numOr(raw["ref_close"]),
    ref_close_reason: strOr(raw["ref_close_reason"]),
    horizons,
    unreadable_horizons: bad,
    trend: readScore(raw["trend"], "trend"),
    risk: readScore(raw["risk"], "risk"),
    model: readModel(raw["model"], "model"),
    track_record: readTrack(raw["track_record"], "track_record"),
  };
}

export const predictionDataSchema = z.record(z.string(), z.unknown()).transform(normalize);

export const predictionSchema = z.union([redirectSchema, predictionDataSchema]);

export const predictionKey = (symbol: string) => ["stocks", symbol, "prediction"] as const;

export const getPrediction = (symbol: string) =>
  apiRequest(`/stocks/${encodeURIComponent(symbol)}/prediction`, { schema: predictionSchema });

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
    "The model did not pass its accuracy checks in testing, so its forecast is hidden. A forecast that is no better than a simple baseline or a coin toss is not shown.",
  insufficient_history:
    "Not enough price history for this forecast. Either this stock has too few imported daily prices, or the model's walk-forward testing did not have enough history. Importing more daily prices may enable it.",
  low_liquidity: "This stock trades too thinly for a forecast to mean anything, so none is shown.",
  near_corporate_action:
    "A split, bonus or other corporate action is close, or one is waiting for your confirmation. Confirm the possible split first on the Events tab.",
  no_model:
    "No model is active for this horizon yet. A model is trained once enough stocks have imported price history.",
  awaiting_predictions:
    "A model is active, but no forecast has been written for this stock yet. It appears after the next prediction run.",
  not_tracked:
    "This stock is not tracked, not active or not an equity, so no forecast is ever made for it.",
  stale_data:
    "The latest price data is more than 3 trading days old, so the forecast is hidden until prices are imported again.",
};

export function hiddenReasonText(reason: string | null | undefined): string {
  if (!reason) return "This forecast is hidden and no reason was served. No numbers are shown.";
  return (
    HIDDEN_REASON_TEXT[reason] ??
    "This forecast is hidden for a reason this page does not recognise. No numbers are shown."
  );
}

/** Copy for a horizon the page cannot draw although the API says it is shown. */
export const HORIZON_UNREADABLE_COPY =
  "The forecast data for this horizon could not be read, so no numbers are shown.";

/** Whole-tab state copy (B14-1). The API's `state_reason` is shown next to it. Extensible: any state
 * missing here gets STATE_FALLBACK, which says nothing more than that no forecast is available. */
export const STATE_TEXT: Record<string, string> = {
  no_model: "No forecasting model has been trained yet. Nothing is predicted for this stock.",
  insufficient_universe:
    "Not enough tracked stocks to train a model. Forecasts need at least 20 tracked stocks with about three years of imported daily prices each. Import prices for more stocks to enable them.",
  insufficient_history: "Not enough price history to train or show a model yet.",
  guardrail_failed:
    "The latest model did not pass its accuracy checks in testing, so its forecasts are hidden.",
  training_aborted:
    "The latest training run hit its time limit and stored nothing, so no model is active yet. Forecasts stay hidden until a run completes.",
};
export const STATE_FALLBACK = "No forecast is available for this stock right now.";
export const STATE_UNREADABLE = "The state of the forecast could not be read.";

export function stateText(state: string | null): string {
  if (state === null) return STATE_UNREADABLE;
  return STATE_TEXT[state] ?? STATE_FALLBACK;
}

/** Empty model-card copy that matches the whole-tab state (no false "no model has been trained"). */
export function noCardText(state: string | null): string {
  switch (state) {
    case "no_model":
    case "insufficient_universe":
      return "No model card: no model has been trained. There is no track record either, because nothing has been predicted.";
    case "insufficient_history":
      return "No model card: there is not enough price history to train a model. There is no track record either.";
    case "guardrail_failed":
      return "The latest model did not pass its checks and no model card is served for it. There is no live track record either.";
    default:
      return "No model card is served right now. See the state above for why no forecast is shown.";
  }
}

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

/** A horizon's band, only when it is shown AND complete; else null (a hidden horizon has no numbers). */
export function usableBand(h: Horizon): UsableBand | null {
  if (h.shown !== true || !h.band || isUnreadable(h.band) || isUnreadable(h.p_up)) return null;
  const { q10, q50, q90, price_q10, price_q90 } = h.band;
  return { q10, q50, q90, priceQ10: price_q10, priceQ90: price_q90 };
}

/** shown: drawable forecast; hidden: the API hid it (reason applies); unreadable: data unusable. */
export function horizonStatus(h: Horizon): "shown" | "hidden" | "unreadable" {
  if (h.shown === null) return "unreadable";
  if (h.shown) return usableBand(h) ? "shown" : "unreadable";
  return "hidden";
}

export function horizonList(d: PredictionData): Horizon[] {
  return isUnreadable(d.horizons) ? [] : d.horizons;
}

/** A model card or track record to show for a horizon, falling back to the top-level mirror once. */
export function cardsOf(d: PredictionData): {
  days: number | null;
  model: ModelCard | null | Unreadable;
  track: TrackRecord | null | Unreadable;
}[] {
  const own = horizonList(d)
    .filter((h) => h.model !== null || h.track_record !== null)
    .map((h) => ({ days: h.days, model: h.model, track: h.track_record }));
  if (own.length > 0) return own;
  if (d.model !== null || d.track_record !== null) {
    return [{ days: null, model: d.model, track: d.track_record }];
  }
  return [];
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const pctFromPercent = (v: number) => formatFraction(v / 100, { decimals: 1, signed: true }).text;

/**
 * Fan chart: return versus the last close at "Now" (0 by definition) and at each SHOWN horizon, as
 * dashed forecast lines (10th, 50th, 90th percentile). Hidden horizons are left off the axis, so
 * the "Now" point is always connected and nothing is drawn as zero. The axis is categorical.
 */
export function fanDataset(
  d: PredictionData,
  asOfFallback: string | null = null,
): ChartDataset | null {
  const shown = horizonList(d).flatMap((h) => {
    const b = usableBand(h);
    return b ? [{ days: h.days, b }] : [];
  });
  if (shown.length === 0) return null;
  const mk = (id: string, name: string, pick: (b: UsableBand) => number) => ({
    id,
    name,
    unit: "%",
    kind: "line" as const,
    forecast: true,
    format: pctFromPercent,
    nullReason: "no forecast",
    values: [0, ...shown.map((s) => round6(pick(s.b) * 100))],
  });
  return {
    xName: "Horizon",
    x: ["Now", ...shown.map((s) => `${s.days} days`)],
    series: [
      mk("q90", "90th percentile (upper end of the 80% range)", (b) => b.q90),
      mk("q50", "Median", (b) => b.q50),
      mk("q10", "10th percentile (lower end of the 80% range)", (b) => b.q10),
    ],
    source: "Experimental model trained on your imported prices",
    asOf: d.as_of ?? asOfFallback,
  };
}

/**
 * Live track record: observed rates next to what chance / a calibrated band would give. The API
 * serves only the tracking start (`since`), never the date of the latest resolved prediction, so
 * the chart's as-of is null ("as of not served") and the start is named as such in the source.
 */
export function trackDataset(t: TrackRecord): ChartDataset | null {
  const hit = t.direction_hit_rate;
  const cov = t.band_coverage_80;
  if (t.resolved <= 0 || hit === null || cov === null) return null;
  const fmt = (v: number) => formatFraction(v / 100, { decimals: 1 }).text;
  const since = t.since
    ? `tracking since ${formatDate(t.since).text}`
    : "tracking start not served";
  return {
    xName: "Measure",
    x: ["Direction hit rate", "80% band coverage"],
    series: [
      {
        id: "live",
        name: "Live result",
        unit: "%",
        kind: "bar",
        values: [round6(hit * 100), round6(cov * 100)],
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
    source: `Live predictions resolved against later closes (${since}; as of not served)`,
    asOf: null,
  };
}
