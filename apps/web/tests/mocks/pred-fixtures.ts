import { ok, type MockReply } from "./imports-fixtures";

// GET /stocks/{symbol}/prediction replies built from the REAL API shapes (apps/api/internal/predict/
// predict.go, docs/03 section 6). Facts those shapes fix, which the fixtures must keep:
//  - a hidden horizon carries only {days, shown:false, hidden_reason} plus `model` and `track_record`
//    (null unless an active model exists for that horizon); p_up, bucket and band are omitted;
//  - a shown horizon has `hidden_reason: null`;
//  - when no horizon has an active model (no_model, insufficient_*, guardrail_failed) EVERY horizon
//    has model:null and track_record:null, and so do the top-level mirrors (predict.go hidden());
//  - `ref_close_reason` is "no_prediction" when nothing was stored; trend and risk carry
//    {score:null, label:null, reason:"no_analysis"} when there is no analysis snapshot.
// Fractions for p_up, rates and band returns.

export const DISCLAIMER =
  "Experimental. Not investment advice. Statistical models often fail out of sample.";

const hidden = (days: number, hidden_reason: string) => ({
  days,
  shown: false,
  hidden_reason,
  model: null,
  track_record: null,
});
const hiddenNoModel = [hidden(5, "no_model"), hidden(21, "no_model")];

const noScore = (reason: string) => ({ score: null, label: null, reason });

const noModelBase = {
  experimental: true,
  disclaimer: DISCLAIMER,
  as_of: null,
  ref_close: null,
  ref_close_reason: "no_prediction",
  model: null,
  track_record: null,
};

export const insufficientUniverse = ok({
  ...noModelBase,
  state: "insufficient_universe",
  state_reason:
    "Fewer than 20 stocks have enough price history for the experimental model; forecasts stay hidden.",
  horizons: hiddenNoModel,
  trend: noScore("insufficient_history"),
  risk: noScore("universe_too_small"),
});

export const noModel = ok({
  ...noModelBase,
  state: "no_model",
  state_reason: "No model has been trained yet; forecasts are not available.",
  horizons: hiddenNoModel,
  trend: { score: 72, label: "up" },
  risk: { score: 41, label: "medium" },
});

/** The shape of every no-active-model state with a given `state` and per-horizon reasons. */
export const noActiveModel = (
  state: string,
  reasons: [string, string] = ["no_model", "no_model"],
) =>
  ok({
    ...noModelBase,
    state,
    state_reason: `served reason for ${state}`,
    horizons: [hidden(5, reasons[0]), hidden(21, reasons[1])],
    trend: { score: 72, label: "up" },
    risk: { score: 41, label: "medium" },
  });

export const model5 = {
  version: "dir_5d@2026-10-04",
  trained_at: "2026-10-04T10:00:00Z",
  oos_auc: 0.536,
  oos_brier: 0.2491,
  baseline_brier: 0.2503,
  folds: 8,
  guardrail_pass: true,
};
export const track5 = {
  resolved: 140,
  direction_hit_rate: 0.514,
  band_coverage_80: 0.77,
  since: "2026-04-01",
};

const shown5 = {
  days: 5,
  shown: true,
  p_up: 0.54,
  bucket: "slightly_up",
  band: {
    q10: -0.041,
    q50: 0.002,
    q90: 0.046,
    price_q10: 3356,
    price_q50: 3507,
    price_q90: 3661,
  },
  hidden_reason: null,
  model: model5,
  track_record: track5,
};

/** 5-day model active and shown; the 21-day horizon has no active model (latest one failed its checks). */
export const okData = {
  experimental: true,
  disclaimer: DISCLAIMER,
  state: "ok",
  state_reason: null,
  as_of: "2026-10-09",
  ref_close: 3500,
  horizons: [shown5, hidden(21, "model_not_better_than_baseline")],
  trend: { score: 72, label: "up" },
  risk: { score: 41, label: "medium" },
  model: model5,
  track_record: track5,
};

export const okState = ok(okData);

export const withHorizon21 = (hidden_reason: string): MockReply =>
  ok({ ...okData, horizons: [shown5, hidden(21, hidden_reason)] });

/** Both horizons have an active model but the 21-day one is hidden near a corporate action. */
export const nearActionWithModel = ok({
  ...okData,
  horizons: [
    shown5,
    {
      days: 21,
      shown: false,
      hidden_reason: "near_corporate_action",
      model: { ...model5, version: "dir_21d@2026-10-04" },
      track_record: { ...track5, resolved: 30 },
    },
  ],
});

/**
 * guardrail_failed as the API really sends it (predict.go hidden()): no horizon has an active model, so
 * model and track_record are null on EVERY horizon and at the top level.
 */
export const guardrailFailed = ok({
  ...noModelBase,
  state: "guardrail_failed",
  state_reason: "The latest model did not beat the baseline out of sample; forecasts stay hidden.",
  horizons: [hidden(5, "model_not_better_than_baseline"), hidden(21, "insufficient_history")],
  trend: { score: 72, label: "up" },
  risk: { score: 41, label: "medium" },
});

/** Odd values everywhere: nothing here may blank the tab (degrade per field). */
export const odd = ok({
  experimental: "yes",
  disclaimer: 12,
  state: "brand_new_state",
  state_reason: { x: 1 },
  as_of: "2026-10-09",
  ref_close: "3500",
  horizons: [
    { days: 5, shown: true, p_up: "high", bucket: "mystery", band: { q10: "a", q50: 1, q90: 2 } },
    { days: 21, shown: false, hidden_reason: "from_the_future" },
    "garbage",
    null,
  ],
  trend: { score: "72", label: 3 },
  risk: 5,
  model: "nope",
  track_record: [],
});

/** Wrong types and out-of-range fractions in an otherwise valid reply. */
export const unreadableSections = ok({
  ...okData,
  disclaimer: "   ",
  trend: { score: "72" },
  risk: 5,
  horizons: [
    {
      ...shown5,
      model: { ...model5, guardrail_pass: "yes" },
      track_record: { ...track5, resolved: "many" },
    },
    { days: 21, shown: true, p_up: 54, band: { q10: -0.04, q50: 0, q90: 0.04 } },
  ],
  model: "nope",
  track_record: { ...track5, direction_hit_rate: 54 },
});
