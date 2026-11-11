import type { HeatCell } from "@/components/ui/Heatmap";
import {
  formatCount,
  formatDate,
  formatMonthName,
  formatMonthYear,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import type {
  InvBlocks,
  Position,
  Seasonality,
  VolRegime,
  DrawdownProfile,
  YearReturn,
} from "./inv-schemas";

// Pure view logic for the investment-context cards (docs/06 6.4a, docs/05 section 12). The browser
// computes nothing here beyond choosing, joining and formatting stored figures. Every number goes
// through lib/format; an unknown value is an em dash plus a plain-English reason (never 0).

/** The fixed line of every card (docs/06 6.4a). */
export const PAST_NOTE = "Past behaviour is not a forecast.";
/** The one place the strip says what it is not (docs/06 6.4a); the only use of that word. */
export const CONTEXT_NOTE = "Context, not advice or a signal.";
export const NOT_COMPUTED = "Not computed yet. It will appear after the next price import.";
export const INV_SOURCE = "Your imported prices, price return, excludes dividends";

/** docs/05 12.0 reason codes in plain English. */
const INV_REASONS: Record<string, string> = {
  insufficient_history: "not enough price history",
  too_few_years: "fewer than 3 years of this month",
  too_few_months: "fewer than 2 calendar months have enough years",
  too_few_windows: "fewer than 20 windows",
  too_few_episodes: "too few past episodes",
  "n/m": "not meaningful",
  no_drawdown: "the price never fell from a high",
  no_base: "no earlier month to compare with",
  gap_before: "the month before has no price",
  incomplete_month_data: "this month's prices stop before its last trading day",
  under_one_year: "XIRR is shown once the history is a year long",
  history_under_12_months: "fewer than 12 monthly instalments in the history",
  no_bar_this_month: "no price bar yet this month",
  flat_range: "the price did not move over the range",
  no_prices_imported: "No prices imported",
  no_history: "Not enough price history",
};

export function invReason(code: string | null | undefined, fallback = "no data"): string {
  if (!code) return fallback;
  return INV_REASONS[code] ?? code.replace(/_/g, " ");
}

const pct = (v: number | null | undefined, o: { signed?: boolean; decimals?: number } = {}) =>
  formatPercent(v ?? null, { decimals: 1, ...o });

// ---- Monthly heatmap: Year column, summary rows, markers ---------------------------------------

export const YEAR_COLUMN = "Year (price return)";

export interface SummaryCell {
  text: string;
  /** Plain-English reason when `text` is an em dash. */
  reason: string | null;
  /** Value for the diverging tint (Average and Median only). */
  tint: number | null;
  /** Marked as a small sample (fewer than the minimum years). */
  small: boolean;
}

export interface SummaryRow {
  key: "avg" | "median" | "green" | "best" | "worst" | "years";
  label: string;
  cells: SummaryCell[];
  year: SummaryCell;
}

export interface InvHeatModel {
  rows: string[];
  columns: string[];
  cells: HeatCell[][];
  maxAbs: number;
  /** The Year (price return) column; null when the snapshot has no `year_returns`. */
  trailing: { cells: HeatCell[]; maxAbs: number } | null;
  footer: SummaryRow[];
  /** Distinct reasons used by empty cells, as visible text under the grid. */
  emptyReasons: string[];
  footnote: string;
  bestWorst: { best: string | null; worst: string | null; reason: string | null };
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const dash = (reason: string, small = false): SummaryCell => ({
  text: "—",
  reason,
  tint: null,
  small,
});

function statCell(
  v: number | null | undefined,
  n: number | null | undefined,
  minYears: number,
  opts: { signed?: boolean; decimals?: number; tint?: boolean; year?: number | null } = {},
): SummaryCell {
  const small = (n ?? 0) < minYears;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return dash(n ? "no value for this month" : "no closed year of this month yet", small);
  }
  const f = pct(v, { signed: opts.signed ?? true, decimals: opts.decimals ?? 1 });
  const text = opts.year ? `${f.text} (${opts.year})` : f.text;
  return { text, reason: null, tint: opts.tint ? v : null, small };
}

function summaryFor(
  s: {
    n: number | null | undefined;
    green: number | null | undefined;
    greenReason: string | null | undefined;
    avg: number | null | undefined;
    median: number | null | undefined;
    best: { pct?: number | null; year?: number | null } | null | undefined;
    worst: { pct?: number | null; year?: number | null } | null | undefined;
  },
  minYears: number,
): Omit<SummaryRow, "key" | "label" | "cells" | "year"> & { cells: SummaryCell[] } {
  const n = s.n ?? 0;
  return {
    cells: [
      statCell(s.avg, n, minYears, { tint: true }),
      statCell(s.median, n, minYears, { tint: true }),
      typeof s.green === "number" && Number.isFinite(s.green)
        ? {
            text: formatPercent(s.green, { decimals: 0 }).text,
            reason: null,
            tint: null,
            small: false,
          }
        : dash(invReason(s.greenReason ?? "too_few_years")),
      statCell(s.best?.pct, n, minYears, { year: s.best?.year ?? null }),
      statCell(s.worst?.pct, n, minYears, { year: s.worst?.year ?? null }),
      { text: formatCount(n).text, reason: null, tint: null, small: false },
    ],
  };
}

/**
 * The month x year grid with the Year (price return) column and the summary rows. Cells print
 * their value; the running month is marked MTD and the partial first / running year are marked in
 * text (docs/06 6.4a). Returns null when there is nothing to draw.
 */
export function invHeatModel(
  monthYear: ReadonlyArray<readonly [number, number, number | null]>,
  inv: InvBlocks,
): InvHeatModel | null {
  const years = [...new Set(monthYear.map((r) => r[0]))].sort((a, b) => a - b);
  if (years.length === 0) return null;
  const season = inv.seasonality.kind === "ok" ? inv.seasonality.value : null;
  const yearRows: YearReturn[] = inv.yearReturns.kind === "ok" ? inv.yearReturns.value : [];
  const byYear = new Map(yearRows.map((r) => [r.year, r]));
  const values = new Map(monthYear.map((r) => [`${r[0]}-${r[1]}`, r[2]]));
  const reasons = new Map(inv.monthReasons.map((r) => [`${r[0]}-${r[1]}`, r[2]]));
  const running = season?.running ?? null;
  const emptyReasons = new Set<string>();

  const cells = years.map((y) =>
    MONTH_ABBR.map((_, i): HeatCell => {
      const key = `${y}-${i + 1}`;
      const isRunning = running !== null && running.year === y && running.month === i + 1;
      let v = values.get(key);
      if (
        isRunning &&
        (v === undefined || v === null) &&
        typeof running.mtd_return_pct === "number"
      ) {
        v = running.mtd_return_pct;
      }
      if (typeof v === "number" && Number.isFinite(v)) {
        const f = pct(v, { signed: true });
        return {
          value: v,
          text: f.text,
          ...(isRunning
            ? {
                marker: "MTD",
                markerTitle: "Month still running; not counted below",
                outlined: true,
              }
            : {}),
        };
      }
      const code = isRunning ? (running.mtd_reason ?? reasons.get(key)) : reasons.get(key);
      if (code) {
        const reason = invReason(code);
        emptyReasons.add(reason);
        return {
          value: null,
          text: null,
          reason,
          ...(isRunning
            ? { marker: "MTD", markerTitle: "Month still running", outlined: true }
            : {}),
        };
      }
      return { value: null, text: null };
    }),
  );
  const maxAbs = Math.max(
    0,
    ...monthYear.map((r) => (typeof r[2] === "number" ? Math.abs(r[2]) : 0)),
  );

  const trailingCells = years.map((y): HeatCell => {
    const r = byYear.get(y);
    if (!r) return { value: null, text: null, reason: "No year row for this year" };
    if (typeof r.return_pct === "number" && Number.isFinite(r.return_pct)) {
      const f = pct(r.return_pct, { signed: true });
      const kindMarker =
        r.kind === "partial_first"
          ? {
              marker: "partial",
              markerTitle: `Only ${r.months_covered ?? "some"} months with a base`,
            }
          : r.kind === "ytd"
            ? {
                marker: "YTD",
                markerTitle: `Year to date as of ${formatDate(r.end_date ?? null, { reason: "the last bar" }).text}`,
              }
            : {};
      return { value: r.return_pct, text: f.text, ...kindMarker };
    }
    const reason = invReason(r.return_pct_reason);
    emptyReasons.add(reason);
    return { value: null, text: null, reason };
  });
  const trailingMax = Math.max(
    0,
    ...yearRows.map((r) => (typeof r.return_pct === "number" ? Math.abs(r.return_pct) : 0)),
  );

  const footer: SummaryRow[] = [];
  const minYears = season?.min_years ?? 3;
  if (season) {
    const byMonth = new Map(season.months.map((m) => [m.month, m]));
    const monthSummaries = MONTH_ABBR.map((_, i) => {
      const m = byMonth.get(i + 1);
      return summaryFor(
        {
          n: m?.n_years ?? 0,
          green: m?.green_pct,
          greenReason: m?.green_pct_reason,
          avg: m?.avg_pct,
          median: m?.median_pct,
          best: m?.best ?? null,
          worst: m?.worst ?? null,
        },
        minYears,
      ).cells;
    });
    const ys = season.years;
    const yearSummary = summaryFor(
      {
        n: ys?.n ?? 0,
        green: ys?.green_pct,
        greenReason: ys?.green_pct_reason,
        avg: ys?.avg_pct,
        median: ys?.median_pct,
        best: ys?.best ?? null,
        worst: ys?.worst ?? null,
      },
      minYears,
    ).cells;
    const labels: Array<[SummaryRow["key"], string]> = [
      ["avg", "Average"],
      ["median", "Median"],
      ["green", "% of years green"],
      ["best", "Best"],
      ["worst", "Worst"],
      ["years", "Years"],
    ];
    labels.forEach(([key, label], idx) => {
      footer.push({
        key,
        label,
        cells: monthSummaries.map((c) => c[idx]!),
        year: yearSummary[idx]!,
      });
    });
  }

  const first = season?.first_bar ?? null;
  const hist = season?.years_of_history ?? null;
  const total =
    first && season?.last_bar
      ? Number(season.last_bar.slice(0, 4)) - Number(first.slice(0, 4)) + 1
      : null;
  const base =
    hist !== null && first
      ? `Based on ${formatNumber(hist, { decimals: 1 }).text} years of data from ${formatMonthYear(first).text}.`
      : "Based on your imported prices.";
  const more =
    total !== null && total > years.length
      ? ` Rows show the last ${years.length} years; the summary uses all ${total}.`
      : "";
  const footnote = `${base} The running month and the partial first year are not counted. ${PAST_NOTE}${more}`;

  return {
    rows: years.map(String),
    columns: MONTH_ABBR,
    cells,
    maxAbs,
    trailing: inv.yearReturns.kind === "ok" ? { cells: trailingCells, maxAbs: trailingMax } : null,
    footer,
    emptyReasons: [...emptyReasons],
    footnote,
    bestWorst: bestWorstLines(season),
  };
}

function monthLine(
  pick: { month: number; median_pct?: number | null; n_years?: number | null } | null | undefined,
): string | null {
  if (!pick || typeof pick.median_pct !== "number") return null;
  const name = formatMonthName(pick.month);
  if (name.reason !== null) return null;
  return `${name.text}: median ${pct(pick.median_pct, { signed: true }).text} (${formatCount(pick.n_years ?? 0).text} years)`;
}

export function bestWorstLines(season: Seasonality | null) {
  if (!season) return { best: null, worst: null, reason: "Not computed yet" };
  const best = monthLine(season.best_month);
  const worst = monthLine(season.worst_month);
  return {
    best,
    worst,
    reason: best && worst ? null : invReason(season.best_worst_reason ?? "too_few_months"),
  };
}

// ---- Entry context strip -----------------------------------------------------------------------

export interface ContextFact {
  key: "position" | "drawdown" | "volatility" | "month";
  label: string;
  /** Main sentence; null when the fact is unknown. */
  text: string | null;
  reason: string | null;
  asOf: string | null;
  /** Extra sentence (for the month: the running month so far, never part of the share). */
  extra: string | null;
  small: boolean;
}

const BAND_POSITION: Record<string, string> = {
  lower: "lower",
  middle: "middle",
  upper: "upper",
};
const BAND_VOL: Record<string, string> = {
  lower: "quieter than usual",
  typical: "typical",
  higher: "bigger than usual",
};

export function positionFact(p: Position | null): ContextFact {
  const base = { key: "position" as const, label: "Price position", extra: null, small: false };
  if (!p) return { ...base, text: null, reason: "Not computed yet", asOf: null };
  const band = p.range_band ? BAND_POSITION[p.range_band] : null;
  if (!band) {
    return {
      ...base,
      text: null,
      reason: invReason(p.range_pos_52w_reason, "no 52-week range"),
      asOf: p.as_of ?? null,
    };
  }
  const pos = p.range_pos_52w_pct;
  return {
    ...base,
    text: `Trading in the ${band} third of its 52-week range${typeof pos === "number" ? ` (${formatPercent(pos, { decimals: 0 }).text} of the way up)` : ""}`,
    reason: null,
    asOf: p.as_of ?? null,
  };
}

export function drawdownFact(d: DrawdownProfile | null, highDate: string | null): ContextFact {
  const base = { key: "drawdown" as const, label: "Current drawdown", extra: null, small: false };
  if (!d) return { ...base, text: null, reason: "Not computed yet", asOf: null };
  if (typeof d.current_dd_pct !== "number") {
    return { ...base, text: null, reason: "no current drawdown figure", asOf: d.as_of ?? null };
  }
  if (d.current_dd_pct === 0) {
    return { ...base, text: "At its highest close", reason: null, asOf: d.as_of ?? null };
  }
  const x = formatPercent(Math.abs(d.current_dd_pct), { decimals: 1 }).text;
  const when = highDate ? ` (${formatDate(highDate).text})` : "";
  return {
    ...base,
    text: `${x} below its highest close${when}`,
    reason: null,
    asOf: d.as_of ?? null,
  };
}

export function volFact(v: VolRegime | null): ContextFact {
  const base = { key: "volatility" as const, label: "Volatility", extra: null, small: false };
  if (!v) return { ...base, text: null, reason: "Not computed yet", asOf: null };
  const band = v.band ? BAND_VOL[v.band] : null;
  if (!band)
    return {
      ...base,
      text: null,
      reason: invReason(v.reason, "no volatility band"),
      asOf: v.as_of ?? null,
    };
  const p =
    typeof v.percentile === "number" ? ` (percentile ${formatCount(v.percentile).text})` : "";
  return {
    ...base,
    text: `Recent price swings are ${band} for this stock${p}`,
    reason: null,
    asOf: v.as_of ?? null,
  };
}

/** `today` is the IST month (1..12) the caller picked; the running block says which month runs. */
export function monthFact(s: Seasonality | null, month: number | null): ContextFact {
  const base = {
    key: "month" as const,
    label: "This calendar month",
    extra: null as string | null,
  };
  if (!s || month === null)
    return { ...base, text: null, reason: "Not computed yet", asOf: null, small: false };
  const m = s.months.find((x) => x.month === month);
  const name = formatMonthName(month).text;
  const run = s.running;
  const extra =
    run && run.month === month
      ? typeof run.mtd_return_pct === "number"
        ? `${name} so far: ${pct(run.mtd_return_pct, { signed: true }).text} (month to date; not in the count)`
        : `${name} so far: — (${invReason(run.mtd_reason, "no month-to-date figure")})`
      : null;
  if (!m || !m.n_years) {
    return {
      ...base,
      text: null,
      reason: invReason(m?.green_pct_reason ?? "too_few_years"),
      asOf: s.as_of ?? null,
      extra,
      small: false,
    };
  }
  return {
    ...base,
    text: `${name} closed green in ${formatCount(m.n_green ?? 0).text} of ${formatCount(m.n_years).text} years`,
    reason: null,
    asOf: s.as_of ?? null,
    extra,
    small: (m.n_years ?? 0) < (s.small_sample_years ?? 5),
  };
}

/** The four facts in the fixed order (docs/05 12.10). No combined figure exists. */
export function contextFacts(blocks: InvBlocks, month: number | null): ContextFact[] {
  const get = <T>(b: { kind: string; value?: T }): T | null =>
    b.kind === "ok" ? (b.value as T) : null;
  return [
    positionFact(get(blocks.position)),
    drawdownFact(get(blocks.drawdown), get(blocks.position)?.high_all_date ?? null),
    volFact(get(blocks.vol)),
    monthFact(get(blocks.seasonality), month),
  ];
}

/** IST month number (1..12) of an instant. */
export function istMonth(now: Date): number {
  return new Date(now.getTime() + 330 * 60_000).getUTCMonth() + 1;
}
