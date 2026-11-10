import { z } from "zod";
import { apiRequest } from "@/lib/api/client";
import type { ChartDataset } from "@/components/charts/chart-data";
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatInr,
  formatMultiple,
  formatNumber,
  formatPercent,
  unknown,
  type Formatted,
} from "@/lib/format";
import { humanReason } from "./derive";
import { redirectSchema } from "./schemas";

// Fundamentals tab model (docs/06 section 6.4, docs/03 section 5, B05-1..9, R-B05-1). Pure view
// logic: nothing here invents a figure. The only arithmetic is what docs/05 names as computed from
// entered values (fcf = cfo - capex) and the differences a waterfall needs between two reported
// totals (labelled as such). Every number that becomes text goes through lib/format.

const num = z.number().nullable();
const numRecord = z.record(z.string(), z.array(num));

/** `GET /stocks/{symbol}/fundamentals` data; tolerant: a missing block is "not returned". */
export const fundamentalsFullSchema = z.object({
  basis_used: z.string().nullish(),
  basis_available: z.array(z.string()).nullish(),
  basis_note: z.string().nullish(),
  period_type: z.string().nullish(),
  periods_available: z.number().nullish(),
  unit: z.string().nullish(),
  unit_by_metric: z.record(z.string(), z.string()).nullish(),
  source_by_metric: z.record(z.string(), z.string()).nullish(),
  periods: z.array(z.string()).nullish(),
  labels: z.array(z.string()).nullish(),
  metrics: numRecord.nullish(),
  metrics_reason: z.string().nullish(),
  derived: numRecord.nullish(),
  derived_reason: z.string().nullish(),
  derived_as_of: z.string().nullish(),
  null_reasons: z
    .object({
      derived: z.record(z.string(), z.record(z.string(), z.string())).nullish(),
      ratios: z.record(z.string(), z.string()).nullish(),
      valuation: z.record(z.string(), z.string()).nullish(),
    })
    .nullish(),
  ratio_meta: z
    .object({
      roe_basis: z.string().nullish(),
      roce_basis: z.string().nullish(),
      ratio_period: z.record(z.string(), z.string()).nullish(),
    })
    .nullish(),
  ratios: z.record(z.string(), num).nullish(),
  ratios_reason: z.string().nullish(),
  valuation: z.record(z.string(), z.union([z.number(), z.string()]).nullable()).nullish(),
  valuation_reason: z.string().nullish(),
  company_type: z.string().nullish(),
  status: z.string().nullish(),
  entry_hint: z.string().nullish(),
  last_updated: z.string().nullish(),
  last_updated_source: z.string().nullish(),
});
export type FundamentalsFull = z.infer<typeof fundamentalsFullSchema>;
export const fundamentalsFullResponse = z.union([redirectSchema, fundamentalsFullSchema]);

export type BasisChoice = "auto" | "consolidated" | "standalone";
export type PeriodChoice = "Q" | "A";

export const fundamentalsFullKey = (symbol: string, basis: BasisChoice, period: PeriodChoice) =>
  ["stocks", symbol, "fundamentals-tab", basis, period] as const;

export const getFundamentalsFull = (symbol: string, basis: BasisChoice, period: PeriodChoice) =>
  apiRequest(`/stocks/${encodeURIComponent(symbol)}/fundamentals`, {
    schema: fundamentalsFullResponse,
    query: { basis, period },
  });

/**
 * `derived_as_of` is an RFC 3339 instant (D05bGo-3: the worker's computed_at) for new snapshots
 * and a plain date for older ones. An instant is shown in IST with the time; a date as a date.
 */
export function formatDerivedAsOf(v: string | null | undefined): Formatted {
  const t = formatDateTime(v ?? null);
  return t.reason === null ? t : formatDate(v ?? null);
}

// ---- groups and rows ------------------------------------------------------------------------

export type GroupId = "pnl" | "bs" | "cf" | "ratios" | "valuation";
export const GROUPS: ReadonlyArray<{ id: GroupId; label: string }> = [
  { id: "pnl", label: "P&L" },
  { id: "bs", label: "Balance sheet" },
  { id: "cf", label: "Cash flow" },
  { id: "ratios", label: "Ratios" },
  { id: "valuation", label: "Valuation" },
];

export type UnitKind = "INR_CR" | "INR" | "SHARES" | "PERCENT" | "MULT" | "TEXT";

const UNIT_WORDS: Record<UnitKind, string> = {
  INR_CR: "INR crore",
  INR: "INR",
  SHARES: "shares",
  PERCENT: "percent",
  MULT: "times",
  TEXT: "label",
};
export const unitWords = (u: UnitKind): string => UNIT_WORDS[u];

const LABELS: Record<string, string> = {
  "pnl.revenue": "Revenue",
  "pnl.ebitda": "EBITDA",
  "pnl.operating_income": "Operating income",
  "pnl.other_income": "Other income",
  "pnl.interest": "Interest",
  "pnl.depreciation": "Depreciation",
  "pnl.pbt": "Profit before tax",
  "pnl.tax": "Tax",
  "pnl.net_profit": "Net profit",
  "pnl.eps": "EPS",
  "pnl.nii": "Net interest income",
  "pnl.provisions": "Provisions",
  "bs.total_assets": "Total assets",
  "bs.total_liabilities": "Total liabilities",
  "bs.equity": "Equity",
  "bs.borrowings": "Borrowings",
  "bs.current_liabilities": "Current liabilities",
  "bs.cash": "Cash",
  "bs.shares_outstanding": "Shares outstanding",
  "bs.equity_capital": "Equity capital",
  "bs.reserves": "Reserves",
  "bs.fixed_assets": "Fixed assets",
  "bs.investments": "Investments",
  "bs.inventory": "Inventory",
  "bs.receivables": "Receivables",
  "bs.deposits": "Deposits",
  "bs.advances": "Advances",
  "cf.cfo": "Cash from operations (CFO)",
  "cf.cfi": "Cash from investing (CFI)",
  "cf.cff": "Cash from financing (CFF)",
  "cf.capex": "Capital expenditure",
  revenue_yoy: "Revenue growth, year on year",
  revenue_qoq: "Revenue growth, quarter on quarter",
  net_profit_yoy: "Net profit growth, year on year",
  net_profit_qoq: "Net profit growth, quarter on quarter",
  op_margin: "Operating margin",
  net_margin: "Net margin",
  roe: "ROE",
  roce: "ROCE",
  debt_equity: "Debt to equity",
  interest_coverage: "Interest coverage",
  cfo_to_pat: "CFO to net profit",
  fcf: "Free cash flow",
  pe_ttm: "P/E (trailing twelve months)",
  pe_basis: "P/E basis",
  pb: "P/B",
  div_yield: "Dividend yield",
  peg: "PEG",
  pe_percentile_5y: "P/E percentile (5 years)",
};

const SCALAR_UNITS: Record<string, UnitKind> = {
  roe: "PERCENT",
  roce: "PERCENT",
  debt_equity: "MULT",
  interest_coverage: "MULT",
  cfo_to_pat: "MULT",
  fcf: "INR_CR",
  pe_ttm: "MULT",
  pe_basis: "TEXT",
  pb: "MULT",
  div_yield: "PERCENT",
  peg: "MULT",
  pe_percentile_5y: "PERCENT",
};

export const RATIO_KEYS = [
  "roe",
  "roce",
  "debt_equity",
  "interest_coverage",
  "cfo_to_pat",
  "fcf",
] as const;
export const VALUATION_KEYS = [
  "pe_ttm",
  "pe_basis",
  "pb",
  "div_yield",
  "peg",
  "pe_percentile_5y",
] as const;
/** Derived series the API names in docs/03 section 5; shown in P&L even before they are computed. */
export const DERIVED_KEYS = ["revenue_yoy", "net_profit_yoy", "op_margin", "net_margin"] as const;

export function metricLabel(key: string): string {
  return LABELS[key] ?? key.replace(/[._]/g, " ");
}

function unitOfMetric(key: string, d: FundamentalsFull): UnitKind {
  const u = d.unit_by_metric?.[key];
  if (u === "INR") return "INR";
  if (u === "SHARES") return "SHARES";
  if (u === "INR_CR") return "INR_CR";
  if (key === "pnl.eps") return "INR";
  if (key === "bs.shares_outstanding") return "SHARES";
  return "INR_CR";
}

export function formatByUnit(
  unit: UnitKind,
  v: number | null | undefined,
  reason?: string,
): Formatted {
  const o = reason === undefined ? {} : { reason };
  switch (unit) {
    case "INR":
      return formatInr(v, o);
    case "SHARES":
      return formatCount(v, o);
    case "PERCENT":
      return formatPercent(v, o);
    case "MULT":
      return formatMultiple(v, o);
    case "TEXT":
      return unknown(reason);
    default:
      return formatNumber(v, o);
  }
}

export interface SeriesRow {
  key: string;
  label: string;
  unit: UnitKind;
  values: Array<number | null>;
  /** Source and as-of of the row: the latest period's `source_by_metric`, or the snapshot/formula. */
  source: string | null;
  /** Why a value is unknown in this row. */
  reason: string;
  /** Per-period reasons from `null_reasons` (same order as the periods); null = use `reason`. */
  reasons?: Array<string | null>;
}

const padded = (v: ReadonlyArray<number | null> | undefined, n: number): Array<number | null> =>
  Array.from({ length: n }, (_, i) => v?.[i] ?? null);

function metricRows(d: FundamentalsFull, prefix: string): SeriesRow[] {
  const n = d.periods?.length ?? 0;
  const metrics = d.metrics ?? {};
  const known = Object.keys(LABELS).filter((k) => k.startsWith(prefix));
  const extra = Object.keys(metrics)
    .filter((k) => k.startsWith(prefix) && !known.includes(k))
    .sort();
  return [...known, ...extra]
    .filter((k) => metrics[k] !== undefined)
    .map((k) => ({
      key: k,
      label: metricLabel(k),
      unit: unitOfMetric(k, d),
      values: padded(metrics[k], n),
      source: d.source_by_metric?.[k] ?? null,
      reason: "not entered for this period",
    }));
}

/** fcf = cfo - capex (docs/05 section 2), only where both entered values exist. */
export function fcfSeries(d: FundamentalsFull): Array<number | null> | null {
  const cfo = d.metrics?.["cf.cfo"];
  const capex = d.metrics?.["cf.capex"];
  if (!cfo || !capex) return null;
  const n = d.periods?.length ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const a = cfo[i];
    const b = capex[i];
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  });
}

function derivedRows(d: FundamentalsFull): SeriesRow[] {
  const n = d.periods?.length ?? 0;
  const derived = d.derived ?? {};
  const reason = d.derived_reason ? humanReason(d.derived_reason) : "not available for this period";
  const when = formatDerivedAsOf(d.derived_as_of);
  const perPeriod = d.null_reasons?.derived ?? {};
  const source =
    when.reason === null
      ? `Analytics snapshot, as of ${when.text}`
      : "Analytics snapshot, not computed yet";
  const keys = [
    ...DERIVED_KEYS,
    ...Object.keys(derived).filter((k) => !(DERIVED_KEYS as readonly string[]).includes(k)),
  ];
  return keys.map((k) => ({
    key: k,
    label: metricLabel(k),
    unit: "PERCENT",
    values: padded(derived[k], n),
    source,
    reason,
    reasons: (d.periods ?? []).map((p) => {
      const code = perPeriod[k]?.[p];
      return code ? humanReason(code) : null;
    }),
  }));
}

export function seriesRows(d: FundamentalsFull, group: GroupId): SeriesRow[] {
  if (group === "pnl") return [...metricRows(d, "pnl."), ...derivedRows(d)];
  if (group === "bs") return metricRows(d, "bs.");
  if (group === "cf") {
    const rows = metricRows(d, "cf.");
    const fcf = fcfSeries(d);
    if (fcf) {
      rows.push({
        key: "cf.fcf",
        label: "Free cash flow (CFO minus capex)",
        unit: "INR_CR",
        values: fcf,
        source: "Computed here: CFO minus capex of the same period",
        reason: "needs CFO and capex for the period",
      });
    }
    return rows;
  }
  return [];
}

export interface ScalarRow {
  key: string;
  label: string;
  unit: UnitKind;
  /** Number, text (P/E basis) or null. */
  value: number | string | null;
  reason: string;
  /** Period end the ratio used (`ratio_meta.ratio_period`), an ISO date; null when not sent. */
  period: string | null;
  /** Definition note, e.g. the ROE basis (`ratio_meta.roe_basis`, `ratio_meta.roce_basis`). */
  note: string | null;
}

export function scalarRows(d: FundamentalsFull, group: "ratios" | "valuation"): ScalarRow[] {
  const block = group === "ratios" ? d.ratios : d.valuation;
  const blockReason = group === "ratios" ? d.ratios_reason : d.valuation_reason;
  const keys = group === "ratios" ? RATIO_KEYS : VALUATION_KEYS;
  const extra = Object.keys(block ?? {}).filter((k) => !(keys as readonly string[]).includes(k));
  const blockWords = blockReason ? humanReason(blockReason) : "not available for this stock";
  const perMetric = (group === "ratios" ? d.null_reasons?.ratios : d.null_reasons?.valuation) ?? {};
  const roeBasis = d.ratio_meta?.roe_basis;
  const roceBasis = d.ratio_meta?.roce_basis;
  return [...keys, ...extra].map((k) => ({
    key: k,
    label: metricLabel(k),
    unit: SCALAR_UNITS[k] ?? (group === "ratios" ? "MULT" : "TEXT"),
    value: block?.[k] ?? null,
    reason: perMetric[k] ? humanReason(perMetric[k]) : blockWords,
    period: (group === "ratios" ? d.ratio_meta?.ratio_period?.[k] : null) ?? null,
    note:
      group === "ratios" && k === "roe" && roeBasis
        ? roeBasis === "average"
          ? "Net profit over the average of opening and closing equity."
          : "Net profit over closing equity: the earlier year's equity was not entered."
        : group === "ratios" && k === "roce" && roceBasis
          ? roceBasis === "equity_plus_debt"
            ? "Profit before tax plus interest, over the average of equity plus borrowings."
            : "Profit before tax plus interest, over the average of total assets less current liabilities: equity or borrowings was not entered."
          : null,
  }));
}

export function hasAnyValue(row: SeriesRow): boolean {
  return row.values.some((v) => v !== null);
}

// ---- chart datasets -------------------------------------------------------------------------

export function sourceText(d: FundamentalsFull): string {
  const set = [...new Set(Object.values(d.source_by_metric ?? {}))];
  return set.length > 0
    ? `Owner-entered fundamentals (${set.join(", ")})`
    : "Owner-entered fundamentals";
}

export function asOfText(d: FundamentalsFull): string | null {
  const f = formatDate(d.last_updated ?? null);
  return f.reason === null ? f.text : null;
}

const xOf = (d: FundamentalsFull): string[] => [...(d.labels ?? d.periods ?? [])];

function base(d: FundamentalsFull, series: ChartDataset["series"]): ChartDataset {
  return { xName: "Period", x: xOf(d), series, source: sourceText(d), asOf: asOfText(d) };
}

export function rowDataset(d: FundamentalsFull, row: SeriesRow): ChartDataset {
  return base(d, [
    {
      id: row.key,
      name: row.label,
      unit: unitWords(row.unit),
      kind: "bar",
      values: row.values,
      format: (v) => formatByUnit(row.unit, v).text,
      nullReason: row.reason,
    },
  ]);
}

function pick(d: FundamentalsFull, keys: string[], kind: "bar" | "line", stack?: string) {
  return keys.flatMap((k, i) => {
    const values = d.metrics?.[k];
    if (!values) return [];
    return [
      {
        id: k,
        name: metricLabel(k),
        unit: unitWords(unitOfMetric(k, d)),
        kind,
        values: padded(values, d.periods?.length ?? 0),
        colorIndex: i,
        ...(stack ? { stack } : {}),
        format: (v: number) => formatNumber(v).text,
        nullReason: "not entered for this period",
      },
    ];
  });
}

/** Stacked bars of the reported balance-sheet components plus total assets as a line. */
export function balanceDataset(d: FundamentalsFull): ChartDataset | null {
  const parts = pick(d, ["bs.equity", "bs.borrowings", "bs.current_liabilities"], "bar", "bs");
  if (parts.length === 0) return null;
  const total = pick(d, ["bs.total_assets"], "line").map((s) => ({ ...s, colorIndex: 4 }));
  return base(d, [...parts, ...total]);
}

export function cashflowDataset(d: FundamentalsFull): ChartDataset | null {
  const bars = pick(d, ["cf.cfo", "cf.cfi", "cf.cff"], "bar");
  if (bars.length === 0) return null;
  const fcf = fcfSeries(d);
  const line = fcf
    ? [
        {
          id: "cf.fcf",
          name: "Free cash flow (CFO minus capex)",
          unit: unitWords("INR_CR"),
          kind: "line" as const,
          values: fcf,
          colorIndex: 4,
          dash: "dashed" as const,
          format: (v: number) => formatNumber(v).text,
          nullReason: "needs CFO and capex for the period",
        },
      ]
    : [];
  return base(d, [...bars, ...line]);
}

// ---- P&L waterfall for the latest period ----------------------------------------------------

export interface WaterfallStep {
  label: string;
  kind: "total" | "step";
  /** Signed change for a step, the reported level for a total. */
  value: number;
}
export interface WaterfallModel {
  periodLabel: string;
  steps: WaterfallStep[];
  dataset: ChartDataset;
}

const WF_NEEDS = [
  "pnl.revenue",
  "pnl.ebitda",
  "pnl.depreciation",
  "pnl.interest",
  "pnl.pbt",
  "pnl.tax",
  "pnl.net_profit",
] as const;
const EPS = 1e-6;

/**
 * Revenue -> operating costs -> EBITDA -> D&A -> interest -> (other items) -> PBT -> tax ->
 * (other items) -> net profit for the latest period. The totals are the reported values, so they
 * equal the table's cells; each step is the difference between two reported values. "Other
 * items" balances the chain to the reported total (other income, exceptional items, minority
 * interest) and is omitted when it is zero. Returns the missing metrics instead when it cannot be
 * drawn (a missing value or a negative level).
 */
export function waterfall(
  d: FundamentalsFull,
): WaterfallModel | { missing: string[]; reason: string } {
  const n = d.periods?.length ?? 0;
  if (n === 0) return { missing: [], reason: "no period entered" };
  const at = (k: string): number | null => d.metrics?.[k]?.[n - 1] ?? null;
  const missing = WF_NEEDS.filter((k) => at(k) === null).map(metricLabel);
  if (missing.length > 0) {
    return { missing, reason: `Needs ${missing.join(", ")} for the latest period.` };
  }
  const v = (k: string) => at(k) as number;
  const rev = v("pnl.revenue");
  const ebitda = v("pnl.ebitda");
  const dep = v("pnl.depreciation");
  const int = v("pnl.interest");
  const pbt = v("pnl.pbt");
  const tax = v("pnl.tax");
  const np = v("pnl.net_profit");
  const steps: WaterfallStep[] = [
    { label: "Revenue", kind: "total", value: rev },
    { label: "Operating costs", kind: "step", value: ebitda - rev },
    { label: "EBITDA", kind: "total", value: ebitda },
    { label: "Depreciation", kind: "step", value: -dep },
    { label: "Interest", kind: "step", value: -int },
  ];
  const toPbt = pbt - (ebitda - dep - int);
  if (Math.abs(toPbt) > EPS)
    steps.push({ label: "Other items to PBT (balancing)", kind: "step", value: toPbt });
  steps.push({ label: "Profit before tax", kind: "total", value: pbt });
  steps.push({ label: "Tax", kind: "step", value: -tax });
  const toNp = np - (pbt - tax);
  if (Math.abs(toNp) > EPS)
    steps.push({ label: "Other items to net profit (balancing)", kind: "step", value: toNp });
  steps.push({ label: "Net profit", kind: "total", value: np });

  let level = 0;
  const total: Array<number | null> = [];
  const inc: Array<number | null> = [];
  const dec: Array<number | null> = [];
  const floor: Array<number | null> = [];
  for (const s of steps) {
    if (s.kind === "total") {
      level = s.value;
      if (level < 0)
        return {
          missing: [],
          reason: "A negative level (a loss) cannot be drawn as a waterfall; see the table.",
        };
      total.push(s.value);
      inc.push(null);
      dec.push(null);
      floor.push(0);
    } else {
      const next = level + s.value;
      if (next < 0)
        return {
          missing: [],
          reason: "A negative level (a loss) cannot be drawn as a waterfall; see the table.",
        };
      total.push(null);
      inc.push(s.value >= 0 ? s.value : null);
      dec.push(s.value < 0 ? -s.value : null);
      floor.push(Math.min(level, next));
      level = next;
    }
  }
  const unit = unitWords("INR_CR");
  const fmt = (x: number) => formatNumber(x).text;
  const periodLabel = d.labels?.[n - 1] ?? d.periods?.[n - 1] ?? "";
  const mk = (id: string, name: string, values: Array<number | null>, colorIndex: number) => ({
    id,
    name,
    unit,
    kind: "bar" as const,
    values,
    floatBase: floor,
    colorIndex,
    format: fmt,
    nullReason: "not a step of this kind",
  });
  return {
    periodLabel,
    steps,
    dataset: {
      xName: "Step",
      x: steps.map((s) => s.label),
      series: [
        mk("wf-total", "Reported total", total, 0),
        mk("wf-dec", "Decrease", dec, 1),
        mk("wf-inc", "Increase", inc, 2),
      ],
      source: sourceText(d),
      asOf: asOfText(d),
    },
  };
}

// ---- warnings and stamps --------------------------------------------------------------------

export interface ApiWarning {
  code: string;
  message: string;
}

/** Sentence for a fundamentals warning; an unknown code keeps the API's own message. */
export function warningText(w: ApiWarning, derivedAsOf: string | null | undefined): string {
  if (w.code === "DERIVED_STALE") {
    const when = formatDerivedAsOf(derivedAsOf);
    return `Growth, margins, ratios and valuation were computed ${when.reason === null ? `as of ${when.text}` : "earlier"}, before your latest entry. They update after the next analytics run.`;
  }
  if (w.code === "BASIS_NOT_MIXED") {
    return `One basis is shown at a time and bases are never mixed. ${w.message}`;
  }
  return w.message;
}
