// Contract-shaped answers for the F08 tabs (docs/03 section 5 shareholding/events, section 14 PATCH,
// B05, B07). Fixed dates only; illustrative numbers; no network.

import { ok } from "./imports-fixtures";

export const QUARTERS = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];

const base = {
  quarters: QUARTERS,
  promoter: [72.3, 72.1, 71.9, 71.7],
  fii: [12.0, 12.2, 12.1, 12.5],
  dii: [9.0, 9.1, 9.3, 9.5],
  mf: [4.0, 4.1, 4.2, 4.4],
  insurance: [2.0, 2.0, 2.1, 2.1],
  govt: [0.1, 0.1, 0.1, 0.1],
  public: [6.6, 6.6, 6.6, 6.3],
  pledged: [null, null, null, null],
  unit: "PERCENT",
  qoq_change: {
    promoter: -0.2,
    fii: 0.4,
    dii: 0.2,
    mf: 0.2,
    insurance: 0,
    govt: 0,
    public: -0.3,
    pledged: null,
  },
  qoq_reason: null,
  latest_filed_on: "2026-07-18",
  mf_available: true,
  note: null,
  reason: null,
  entry_hint: null,
  source: "manual",
  last_updated: "2026-07-20T10:00:00Z",
};

export const shareholding = ok(base);
export const shareholdingNoMf = ok({
  ...base,
  mf: [null, null, null, null],
  mf_available: false,
  note: "MF holding was not entered; DII includes mutual funds",
});
export const shareholdingSingle = ok({
  ...base,
  quarters: ["2026-06-30"],
  promoter: [71.7],
  fii: [12.5],
  dii: [9.5],
  mf: [4.4],
  insurance: [2.1],
  govt: [0.1],
  public: [6.3],
  pledged: [1.5],
  qoq_change: {
    promoter: null,
    fii: null,
    dii: null,
    mf: null,
    insurance: null,
    govt: null,
    public: null,
    pledged: null,
  },
  qoq_reason: "single_quarter",
});
export const shareholdingEmpty = ok({
  quarters: [],
  promoter: [],
  fii: [],
  dii: [],
  mf: [],
  insurance: [],
  govt: [],
  public: [],
  pledged: [],
  unit: "PERCENT",
  qoq_change: {},
  qoq_reason: "no_data_entered",
  latest_filed_on: null,
  mf_available: false,
  note: null,
  reason: "no_data_entered",
  entry_hint: "Add shareholding via Import or the manual form",
  source: null,
  last_updated: null,
});

export const detected = {
  id: 9,
  ex_date: "2026-03-12",
  record_date: null,
  type: "split_or_bonus",
  status: "detected",
  ratio_num: 1,
  ratio_den: 5,
  amount_per_share: null,
  purpose_text: "",
  source: "detected",
};

export const eventsDetected = ok({
  actions: [
    detected,
    {
      id: 2,
      ex_date: "2026-08-01",
      record_date: null,
      type: "dividend",
      status: "confirmed",
      ratio_num: null,
      ratio_den: null,
      amount_per_share: 10,
      purpose_text: "",
      source: "manual",
    },
    {
      id: 3,
      ex_date: "2025-05-02",
      record_date: null,
      type: "split_or_bonus",
      status: "rejected",
      ratio_num: 1,
      ratio_den: 2,
      amount_per_share: null,
      purpose_text: "",
      source: "detected",
    },
    {
      id: 4,
      ex_date: "2099-01-05",
      record_date: null,
      type: "bonus",
      status: "confirmed",
      ratio_num: 1,
      ratio_den: 1,
      amount_per_share: null,
      purpose_text: "",
      source: "manual",
    },
  ],
  calendar: [
    { event_date: "2026-11-05", type: "results", details: "Q2 results", source: "manual" },
  ],
  reason: null,
  entry_hint: null,
});

export const patchConfirmed = (over: Record<string, unknown> = {}) =>
  ok({
    id: 9,
    symbol: "TCS",
    ex_date: "2026-03-12",
    action_type: "split",
    status: "confirmed",
    ratio_num: "10",
    ratio_den: "2",
    multiplier: "5.0000",
    future_ex_date: false,
    changed: true,
    warnings: [],
    post_import_job_id: 31,
    ...over,
  });

export const patchRejected = ok({
  id: 9,
  symbol: "TCS",
  ex_date: "2026-03-12",
  action_type: "split_or_bonus",
  status: "rejected",
  ratio_num: "1",
  ratio_den: "5",
  multiplier: null,
  future_ex_date: false,
  changed: true,
  warnings: [],
  post_import_job_id: 32,
});

export const adjustment = (value: boolean | null) =>
  ok({ value, set_at: value === null ? null : "2026-10-01T05:00:00Z" });
