// The screener metric whitelist (docs/03 section 9) as one typed list. The metric pickers, the
// request builder, the compare table and the peers table all read it. The server stays
// authoritative: it answers 422 for any other key (SEC-04). `tests/unit/screener-lib.test.ts`
// checks this list against the docs/03 text, so an edit on one side fails CI.

export type UnitCode =
  | "INR_CR"
  | "INR"
  | "PERCENT"
  | "PERCENT_POINTS"
  | "RATIO"
  | "INDEX_0_100"
  | "SCORE_0_100"
  | "TEXT";

export type MetricKind = "numeric" | "text";
export type BestDirection = "higher" | "lower" | "none";

export interface MetricDef {
  key: string;
  label: string;
  unit: UnitCode;
  kind: MetricKind;
  /** Which side is better when comparing; mirrors the server table (`none`: no winner declared). */
  better: BestDirection;
}

const n = (
  key: string,
  label: string,
  unit: UnitCode,
  better: BestDirection = "none",
): MetricDef => ({ key, label, unit, kind: "numeric", better });

export const METRICS: ReadonlyArray<MetricDef> = [
  n("market_cap_cr", "Market cap", "INR_CR"),
  n("price", "Price", "INR"),
  n("pe", "P/E", "RATIO", "lower"),
  n("pb", "P/B", "RATIO", "lower"),
  n("ev_ebitda", "EV/EBITDA", "RATIO", "lower"),
  n("div_yield", "Dividend yield", "PERCENT", "higher"),
  n("roe", "ROE", "PERCENT", "higher"),
  n("roce", "ROCE", "PERCENT", "higher"),
  n("debt_equity", "Debt to equity", "RATIO", "lower"),
  n("interest_coverage", "Interest coverage", "RATIO", "higher"),
  n("op_margin", "Operating margin", "PERCENT", "higher"),
  n("net_margin", "Net margin", "PERCENT", "higher"),
  n("rev_growth_1y", "Revenue growth, 1 year", "PERCENT", "higher"),
  n("rev_growth_3y", "Revenue growth, 3 years", "PERCENT", "higher"),
  n("rev_growth_5y", "Revenue growth, 5 years", "PERCENT", "higher"),
  n("profit_growth_1y", "Profit growth, 1 year", "PERCENT", "higher"),
  n("profit_growth_3y", "Profit growth, 3 years", "PERCENT", "higher"),
  n("profit_growth_5y", "Profit growth, 5 years", "PERCENT", "higher"),
  n("cfo_to_pat", "Cash flow to profit", "RATIO", "higher"),
  n("promoter_pct", "Promoter holding", "PERCENT"),
  n("promoter_pledged_pct", "Promoter pledged", "PERCENT", "lower"),
  n("fii_pct", "FII holding", "PERCENT"),
  n("dii_pct", "DII holding", "PERCENT"),
  n("mf_pct", "Mutual fund holding", "PERCENT"),
  n("fii_change_qoq", "FII change, quarter on quarter", "PERCENT_POINTS"),
  n("mf_change_qoq", "Mutual fund change, quarter on quarter", "PERCENT_POINTS"),
  n("rsi14", "RSI (14)", "INDEX_0_100"),
  n("dist_52w_high_pct", "Distance from 52-week high", "PERCENT"),
  n("ret_1m", "Return, 1 month", "PERCENT", "higher"),
  n("ret_6m", "Return, 6 months", "PERCENT", "higher"),
  n("ret_1y", "Return, 1 year", "PERCENT", "higher"),
  n("quality_score", "Quality score", "SCORE_0_100", "higher"),
  n("trend_score", "Trend score", "SCORE_0_100", "higher"),
  n("risk_score", "Risk score", "SCORE_0_100", "lower"),
  { key: "sector", label: "Sector", unit: "TEXT", kind: "text", better: "none" },
  { key: "industry", label: "Industry", unit: "TEXT", kind: "text", better: "none" },
];

const BY_KEY: ReadonlyMap<string, MetricDef> = new Map(METRICS.map((m) => [m.key, m]));

export function metricDef(key: string): MetricDef | null {
  return BY_KEY.get(key) ?? null;
}

export function metricLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key.replace(/_/g, " ");
}

const UNIT_WORDS: Record<UnitCode, string> = {
  INR_CR: "INR crore",
  INR: "INR",
  PERCENT: "percent",
  PERCENT_POINTS: "percentage points",
  RATIO: "times",
  INDEX_0_100: "index 0 to 100",
  SCORE_0_100: "score 0 to 100",
  TEXT: "text",
};

export function unitWords(code: string | undefined): string {
  return UNIT_WORDS[code as UnitCode] ?? "";
}

/** Header text with the unit, e.g. `ROE (percent)`. The unit is the response's own when sent. */
export function metricHeader(key: string, units?: Record<string, string>): string {
  const code = units?.[key] ?? BY_KEY.get(key)?.unit;
  const words = unitWords(code);
  return words && words !== "text" ? `${metricLabel(key)} (${words})` : metricLabel(key);
}

export const NUMERIC_METRICS = METRICS.filter((m) => m.kind === "numeric");

/** Compare default columns (docs/03 section 8 and B13). */
export const COMPARE_DEFAULT_METRICS = [
  "market_cap_cr",
  "pe",
  "pb",
  "roe",
  "roce",
  "debt_equity",
  "op_margin",
  "rev_growth_3y",
  "profit_growth_3y",
  "ret_1y",
  "quality_score",
  "trend_score",
  "risk_score",
] as const;

/** Screener limits (docs/03 section 9). */
export const SCREENER_LIMITS = {
  filters: 12,
  inValues: 50,
  textLen: 100,
  columns: 40,
  saved: 30,
  maxNumber: 1e15,
} as const;
