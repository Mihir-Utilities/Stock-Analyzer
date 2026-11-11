import { ok, type MockReply } from "./imports-fixtures";

// GET /stocks/{symbol}/prediction replies (docs/03 section 6, B14-1/2/7). Fractions for p_up and
// band returns; the live API today answers the no_model / insufficient_universe shapes.

const DISCLAIMER =
  "Experimental. Not investment advice. Statistical models often fail out of sample.";

const hiddenNoModel = [
  { days: 5, shown: false, hidden_reason: "no_model", model: null, track_record: null },
  { days: 21, shown: false, hidden_reason: "no_model", model: null, track_record: null },
];

const noScore = (reason: string) => ({ score: null, label: null, reason });

export const insufficientUniverse = ok({
  experimental: true,
  disclaimer: DISCLAIMER,
  state: "insufficient_universe",
  state_reason: "3 of the 20 stocks needed have enough history",
  as_of: null,
  ref_close: null,
  ref_close_reason: "no_model",
  horizons: hiddenNoModel,
  trend: noScore("insufficient_history"),
  risk: noScore("universe_too_small"),
  model: null,
  track_record: null,
});

export const noModel = ok({
  experimental: true,
  disclaimer: DISCLAIMER,
  state: "no_model",
  state_reason: "No training run has finished yet",
  as_of: null,
  ref_close: null,
  ref_close_reason: "no_model",
  horizons: hiddenNoModel,
  trend: { score: 72, label: "up" },
  risk: { score: 41, label: "medium" },
  model: null,
  track_record: null,
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
  reason: null,
};

export const okData = {
  experimental: true,
  disclaimer: DISCLAIMER,
  state: "ok",
  state_reason: null,
  as_of: "2026-10-09",
  ref_close: 3500,
  horizons: [
    {
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
    },
    {
      days: 21,
      shown: false,
      hidden_reason: "model_not_better_than_baseline",
      model: null,
      track_record: null,
    },
  ],
  trend: { score: 72, label: "up" },
  risk: { score: 41, label: "medium" },
  model: model5,
  track_record: track5,
};

export const okState = ok(okData);

export const withHorizon21 = (hidden_reason: string): MockReply =>
  ok({
    ...okData,
    horizons: [
      okData.horizons[0],
      { days: 21, shown: false, hidden_reason, model: null, track_record: null },
    ],
  });

export const guardrailFailed = ok({
  ...okData,
  state: "guardrail_failed",
  state_reason: "the newest run did not pass its checks",
  as_of: null,
  ref_close: null,
  horizons: [
    {
      days: 5,
      shown: false,
      hidden_reason: "model_not_better_than_baseline",
      model: { ...model5, guardrail_pass: false },
      track_record: null,
    },
    {
      days: 21,
      shown: false,
      hidden_reason: "insufficient_history",
      model: null,
      track_record: null,
    },
  ],
  model: { ...model5, guardrail_pass: false },
  track_record: null,
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
