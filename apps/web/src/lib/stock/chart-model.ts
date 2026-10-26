import { z } from "zod";
import type { ChartDataset, ChartPane, ChartSeries } from "@/components/charts/chart-data";
import {
  formatCount,
  formatDate,
  formatInr,
  formatNumber,
  formatPercent,
  formatRatio,
} from "@/lib/format";
import { humanReason } from "./derive";
import type { Bar, IndicatorsData } from "./schemas";

// Pure view logic for the Chart and Analysis tabs (docs/06 section 6.4, docs/06a section 5):
// zod parsing of the indicator series, alignment by date (nulls at warm-up, never fabricated),
// chart dataset builders and the plain-language reads. No React, no DOM.

export const CHART_RANGES = ["1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export type ChartType = "candle" | "line" | "area";

export const OVERLAY_IDS = ["sma20", "sma50", "sma200", "ema20", "ema50", "bollinger"] as const;
export type OverlayId = (typeof OVERLAY_IDS)[number];
export const PANE_IDS = ["volume", "rsi", "macd", "stochastic", "adx"] as const;
export type PaneId = (typeof PANE_IDS)[number];

export const OVERLAY_LABELS: Record<OverlayId, string> = {
  sma20: "SMA 20",
  sma50: "SMA 50",
  sma200: "SMA 200",
  ema20: "EMA 20",
  ema50: "EMA 50",
  bollinger: "Bollinger (20, 2)",
};
export const PANE_LABELS: Record<PaneId, string> = {
  volume: "Volume",
  rsi: "RSI 14",
  macd: "MACD",
  stochastic: "Stochastic",
  adx: "ADX 14",
};

/** Window of the stored indicator series (docs/03 section 4). */
export const SERIES_CAP = 750;
export const VOLUME_AVG_DAYS = 20;

// ---- parsing ------------------------------------------------------------------------------

const pairs = z.array(z.tuple([z.string(), z.number().nullable()]));
export type Pairs = z.infer<typeof pairs>;

const indicatorSeriesSchema = z
  .object({
    sma20: pairs.optional(),
    sma50: pairs.optional(),
    sma200: pairs.optional(),
    ema20: pairs.optional(),
    ema50: pairs.optional(),
    rsi14: pairs.optional(),
    macd: z.object({ macd: pairs, signal: pairs, hist: pairs }).partial().optional(),
    bollinger: z.object({ upper: pairs, middle: pairs, lower: pairs }).partial().optional(),
    adx14: z.object({ adx: pairs, plus_di: pairs, minus_di: pairs }).partial().optional(),
    stochastic: z.object({ k: pairs, d: pairs }).partial().optional(),
  })
  .passthrough();
export type IndicatorSeries = z.infer<typeof indicatorSeriesSchema>;

const analysisSchema = z
  .object({
    drawdown: pairs.optional(),
    rolling_vol_21: pairs.optional(),
    rolling_vol_63: pairs.optional(),
    rolling_beta_252: pairs.optional(),
    return_histogram: z
      .object({ edges: z.array(z.number()), counts: z.array(z.number()), n: z.number() })
      .nullable()
      .optional(),
    month_year: z.array(z.tuple([z.number(), z.number(), z.number().nullable()])).optional(),
    calendar: z
      .object({ dates: z.array(z.string()), values: z.array(z.number().nullable()) })
      .nullable()
      .optional(),
  })
  .passthrough();
export type AnalysisData = z.infer<typeof analysisSchema>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

export function parseIndicatorSeries(raw: unknown): Parsed<IndicatorSeries> {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "the indicator series have not been computed yet" };
  }
  const r = indicatorSeriesSchema.safeParse(raw);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, reason: "the indicator series came back in an unexpected shape" };
}

export function parseAnalysis(raw: unknown): Parsed<AnalysisData> {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "the analysis series have not been computed yet" };
  }
  const r = analysisSchema.safeParse(raw);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, reason: "the analysis series came back in an unexpected shape" };
}

// ---- alignment ----------------------------------------------------------------------------

/** One value per date; a date with no pair, or a null pair, is null (a warm-up gap). */
export function alignByDate(
  dates: ReadonlyArray<string>,
  p: Pairs | undefined,
): Array<number | null> {
  if (!p) return dates.map(() => null);
  const m = new Map<string, number | null>(p);
  return dates.map((d) => {
    const v = m.get(d);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
}

/** Mean of the last `n` volumes including the current bar; null until `n` bars exist. */
export function rollingVolumeAverage(
  volumes: ReadonlyArray<number>,
  n: number,
): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < volumes.length; i++) {
    sum += volumes[i] ?? 0;
    if (i >= n) sum -= volumes[i - n] ?? 0;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/** Rebase to 100 at the first index where every given series is known. */
export function rebaseTo100(series: ReadonlyArray<ReadonlyArray<number | null>>): {
  values: Array<Array<number | null>>;
  startIndex: number | null;
} {
  const n = series[0]?.length ?? 0;
  let start: number | null = null;
  for (let i = 0; i < n && start === null; i++) {
    if (series.every((s) => typeof s[i] === "number" && (s[i] as number) > 0)) start = i;
  }
  if (start === null) return { values: series.map((s) => s.map(() => null)), startIndex: null };
  return {
    values: series.map((s) => {
      const base = s[start] as number;
      return s.map((v, i) => (i >= start && typeof v === "number" ? (v / base) * 100 : null));
    }),
    startIndex: start,
  };
}

/** Index of the first x date on or after `date` (weekly candles are dated by their last day). */
export function snapIndex(dates: ReadonlyArray<string>, date: string): number | null {
  for (let i = 0; i < dates.length; i++) if ((dates[i] as string) >= date) return i;
  return null;
}

// ---- chart dataset ------------------------------------------------------------------------

export interface OverlayAvailability {
  available: boolean;
  reason: string | null;
}

export function overlayAvailability(
  id: OverlayId,
  series: Parsed<IndicatorSeries>,
  adjusted: boolean,
): OverlayAvailability {
  if (!adjusted) {
    return {
      available: false,
      reason: "indicators are computed on adjusted prices; switch to Adjusted to show them",
    };
  }
  if (!series.ok) return { available: false, reason: series.reason };
  const v = series.value;
  const has = id === "bollinger" ? v.bollinger?.upper : v[id];
  if (!has) {
    return {
      available: false,
      reason:
        id === "ema50"
          ? "EMA 50 is not computed by the analytics job (only EMA 20)"
          : "not computed for this stock",
    };
  }
  return { available: true, reason: null };
}

export interface ChartAction {
  date: string;
  type: string;
  label: string;
}

export interface CompareInput {
  symbol: string;
  bars: ReadonlyArray<Bar>;
}

export interface ChartSelection {
  type: ChartType;
  overlays: ReadonlySet<OverlayId>;
  panes: ReadonlySet<PaneId>;
  log: boolean;
  adjusted: boolean;
}

export interface BuiltChart {
  dataset: ChartDataset;
  /** Rows the page may need to explain (compare start, missing indicators). */
  notes: string[];
  /** Height in px for the stacked panes. */
  height: number;
  paneIds: string[];
}

const PRICE_UNIT = "INR";
const BASE_HEIGHT = 340;
const PANE_HEIGHT = 120;

function line(
  id: string,
  name: string,
  unit: string,
  values: Array<number | null>,
  pane: number,
  extra: Partial<ChartSeries> = {},
): ChartSeries {
  return { id, name, unit, kind: "line", values, pane, ...extra };
}

export function buildChartDataset(input: {
  symbol: string;
  bars: ReadonlyArray<Bar>;
  series: Parsed<IndicatorSeries>;
  actions: ReadonlyArray<ChartAction>;
  support: ReadonlyArray<{ price: number; touches: number }>;
  resistance: ReadonlyArray<{ price: number; touches: number }>;
  selection: ChartSelection;
  compare: CompareInput | null;
  asOf: string | null;
}): BuiltChart {
  const { bars, selection: sel } = input;
  const dates = bars.map((b) => b[0]);
  const x = dates.map((d) => formatDate(d).text);
  const closes = bars.map((b) => b[4]);
  const notes: string[] = [];
  const source = sel.adjusted
    ? "Imported prices (adjusted, price return excludes dividends)"
    : "Imported prices (raw)";
  const series: ChartSeries[] = [];
  const panes: ChartPane[] = [{ id: "price", name: "Price", unit: PRICE_UNIT, weight: 5 }];
  let logScale = sel.log;

  if (input.compare) {
    const cmap = new Map(input.compare.bars.map((b) => [b[0], b[4]]));
    const other = dates.map((d) => cmap.get(d) ?? null);
    const { values, startIndex } = rebaseTo100([closes, other]);
    panes[0] = { id: "price", name: "Rebased", unit: "index (start = 100)", weight: 5 };
    series.push(
      line("close", `${input.symbol} (rebased)`, "index", values[0] ?? [], 0, {
        nullReason: "before the first common date",
      }),
      line("compare", `${input.compare.symbol} (rebased)`, "index", values[1] ?? [], 0, {
        dash: "dashed",
        nullReason: "no bar for this date or before the first common date",
      }),
    );
    notes.push(
      startIndex === null
        ? `${input.compare.symbol} has no bar on a date shared with ${input.symbol}, so nothing can be rebased.`
        : `Both lines start at 100 on ${formatDate(dates[startIndex]).text}, the first date with a bar for both stocks.`,
    );
  } else if (sel.type === "candle") {
    series.push({
      id: "candles",
      name: "Price",
      unit: PRICE_UNIT,
      kind: "candle",
      pane: 0,
      values: closes,
      ohlc: bars.map((b) => [b[1], b[2], b[3], b[4]] as const),
    });
  } else {
    series.push({
      id: "close",
      name: "Close",
      unit: PRICE_UNIT,
      kind: sel.type === "area" ? "area" : "line",
      pane: 0,
      values: closes,
    });
  }

  const ind = input.series.ok ? input.series.value : null;
  if (!input.compare) {
    const add = (id: OverlayId, s: ChartSeries[]) => {
      if (!sel.overlays.has(id)) return;
      const av = overlayAvailability(id, input.series, sel.adjusted);
      if (!av.available) {
        notes.push(`${OVERLAY_LABELS[id]} is not shown: ${av.reason}.`);
        return;
      }
      series.push(...s);
    };
    const p = (k: "sma20" | "sma50" | "sma200" | "ema20" | "ema50") => alignByDate(dates, ind?.[k]);
    const nr = "indicator warm-up or outside the last 750 trading days";
    add("sma20", [line("sma20", "SMA 20", PRICE_UNIT, p("sma20"), 0, { nullReason: nr })]);
    add("sma50", [
      line("sma50", "SMA 50", PRICE_UNIT, p("sma50"), 0, { dash: "dashed", nullReason: nr }),
    ]);
    add("sma200", [
      line("sma200", "SMA 200", PRICE_UNIT, p("sma200"), 0, { dash: "dotted", nullReason: nr }),
    ]);
    add("ema20", [line("ema20", "EMA 20", PRICE_UNIT, p("ema20"), 0, { nullReason: nr })]);
    add("ema50", [
      line("ema50", "EMA 50", PRICE_UNIT, p("ema50"), 0, { dash: "dashed", nullReason: nr }),
    ]);
    add("bollinger", [
      line(
        "bb-upper",
        "Bollinger upper",
        PRICE_UNIT,
        alignByDate(dates, ind?.bollinger?.upper),
        0,
        {
          dash: "dashed",
          nullReason: nr,
        },
      ),
      line(
        "bb-middle",
        "Bollinger middle (SMA 20)",
        PRICE_UNIT,
        alignByDate(dates, ind?.bollinger?.middle),
        0,
        { dash: "dotted", nullReason: nr },
      ),
      line(
        "bb-lower",
        "Bollinger lower",
        PRICE_UNIT,
        alignByDate(dates, ind?.bollinger?.lower),
        0,
        {
          dash: "dashed",
          nullReason: nr,
        },
      ),
    ]);
  }

  const addPane = (id: PaneId, pane: ChartPane, s: (index: number) => ChartSeries[]) => {
    if (!sel.panes.has(id)) return;
    if (id !== "volume") {
      if (!sel.adjusted) {
        notes.push(`${PANE_LABELS[id]} is not shown: indicators are computed on adjusted prices.`);
        return;
      }
      if (!input.series.ok) {
        notes.push(`${PANE_LABELS[id]} is not shown: ${input.series.reason}.`);
        return;
      }
    }
    panes.push(pane);
    series.push(...s(panes.length - 1));
  };
  const nr = "indicator warm-up or outside the last 750 trading days";
  addPane("volume", { id: "volume", name: "Volume", unit: "shares", weight: 1.6 }, (i) => [
    {
      id: "volume",
      name: "Volume",
      unit: "shares",
      kind: "bar",
      pane: i,
      values: bars.map((b) => b[5]),
    },
    line(
      "volume-avg20",
      `Volume, ${VOLUME_AVG_DAYS}-day average incl. today`,
      "shares",
      rollingVolumeAverage(
        bars.map((b) => b[5]),
        VOLUME_AVG_DAYS,
      ),
      i,
      { dash: "dashed", nullReason: `fewer than ${VOLUME_AVG_DAYS} bars so far` },
    ),
  ]);
  addPane("rsi", { id: "rsi", name: "RSI 14", unit: "0-100", weight: 2 }, (i) => [
    line("rsi14", "RSI 14", "0-100", alignByDate(dates, ind?.rsi14), i, { nullReason: nr }),
  ]);
  addPane("macd", { id: "macd", name: "MACD", unit: PRICE_UNIT, weight: 2 }, (i) => [
    {
      id: "macd-hist",
      name: "MACD histogram",
      unit: PRICE_UNIT,
      kind: "bar",
      pane: i,
      values: alignByDate(dates, ind?.macd?.hist),
      nullReason: nr,
    },
    line("macd", "MACD", PRICE_UNIT, alignByDate(dates, ind?.macd?.macd), i, { nullReason: nr }),
    line("macd-signal", "Signal", PRICE_UNIT, alignByDate(dates, ind?.macd?.signal), i, {
      dash: "dashed",
      nullReason: nr,
    }),
  ]);
  addPane("stochastic", { id: "stochastic", name: "Stochastic", unit: "0-100", weight: 2 }, (i) => [
    line("stoch-k", "%K", "0-100", alignByDate(dates, ind?.stochastic?.k), i, { nullReason: nr }),
    line("stoch-d", "%D", "0-100", alignByDate(dates, ind?.stochastic?.d), i, {
      dash: "dashed",
      nullReason: nr,
    }),
  ]);
  addPane("adx", { id: "adx", name: "ADX 14", unit: "0-100", weight: 2 }, (i) => [
    line("adx", "ADX", "0-100", alignByDate(dates, ind?.adx14?.adx), i, { nullReason: nr }),
    line("plus-di", "+DI", "0-100", alignByDate(dates, ind?.adx14?.plus_di), i, {
      dash: "dashed",
      nullReason: nr,
    }),
    line("minus-di", "-DI", "0-100", alignByDate(dates, ind?.adx14?.minus_di), i, {
      dash: "dotted",
      nullReason: nr,
    }),
  ]);

  const markers = input.actions.flatMap((a) => {
    const index = snapIndex(dates, a.date);
    return index === null ? [] : [{ index, label: `${formatDate(a.date).text}: ${a.label}` }];
  });
  const levels = input.compare
    ? []
    : [
        ...input.support.map((s) => ({
          price: s.price,
          label: `Support ${formatInr(s.price).text} (${formatCount(s.touches).text} touches)`,
        })),
        ...input.resistance.map((s) => ({
          price: s.price,
          label: `Resistance ${formatInr(s.price).text} (${formatCount(s.touches).text} touches)`,
        })),
      ];
  if (input.compare) logScale = false;

  const dataset: ChartDataset = {
    xName: "Date",
    x,
    series,
    source,
    asOf: input.asOf ? formatDate(input.asOf).text : null,
    panes,
    markers,
    levels,
    logScale,
    zoom: true,
  };
  return {
    dataset,
    notes,
    height: BASE_HEIGHT + PANE_HEIGHT * (panes.length - 1),
    paneIds: panes.map((p) => p.id),
  };
}

// ---- indicator summary (plain-language reads) ---------------------------------------------

export interface ReadRow {
  id: string;
  label: string;
  /** Formatted value or the reason it is unknown. */
  value: string;
  unknown: boolean;
  read: string;
  definition:
    | "sma"
    | "ema"
    | "rsi"
    | "macd"
    | "bollinger"
    | "atr"
    | "adx"
    | "stochastic"
    | "obv"
    | "volume_z"
    | "wk52"
    | "cross";
}

type Tech = Record<string, unknown>;

function numOf(t: Tech, k: string): number | null {
  const v = t[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function reasonOf(ind: IndicatorsData, k: string): string {
  return humanReason(ind.null_reasons?.[k], "insufficient history");
}

function vs(value: number, other: number, noun: string): string {
  if (value === other) return `equal to ${noun}`;
  return `${value > other ? "above" : "below"} ${noun}`;
}

/**
 * Plain-language reads. Only definitional comparisons are stated (above or below, which line is
 * higher): docs/05 sets no overbought/oversold or trend-strength thresholds, so none is invented
 * (F06-4). Reads are descriptions of today's numbers, not advice.
 */
export function indicatorReads(ind: IndicatorsData): ReadRow[] {
  const t = ind.technicals as Tech;
  const close = typeof ind.last_close === "number" ? ind.last_close : null;
  const rows: ReadRow[] = [];
  const push = (
    id: string,
    label: string,
    definition: ReadRow["definition"],
    v: number | null,
    fmt: (n: number) => string,
    read: (n: number) => string,
    key: string = id,
  ) => {
    rows.push({
      id,
      label,
      definition,
      unknown: v === null,
      value: v === null ? reasonOf(ind, key) : fmt(v),
      read: v === null ? `No read: ${reasonOf(ind, key)}.` : read(v),
    });
  };
  const inr = (n: number) => formatInr(n).text;
  for (const [k, label, def] of [
    ["sma20", "SMA 20", "sma"],
    ["sma50", "SMA 50", "sma"],
    ["sma200", "SMA 200", "sma"],
    ["ema20", "EMA 20", "ema"],
  ] as const) {
    push(k, label, def, numOf(t, k), inr, (n) =>
      close === null
        ? "Last close is not available to compare."
        : `Last close is ${vs(close, n, `the ${label}`)} (${formatPercent((close / n - 1) * 100, { signed: true }).text}).`,
    );
  }
  push(
    "rsi14",
    "RSI 14",
    "rsi",
    numOf(t, "rsi14"),
    (n) => `${formatNumber(n, { decimals: 1 }).text} (0-100)`,
    (n) =>
      n === 50
        ? "Average gains and losses over the last 14 bars are equal."
        : n > 50
          ? "Average gains exceeded average losses over the last 14 bars."
          : "Average losses exceeded average gains over the last 14 bars.",
  );
  const macd = numOf(t, "macd");
  const sig = numOf(t, "macd_signal");
  push(
    "macd",
    "MACD (12, 26, 9)",
    "macd",
    macd,
    (n) => `${formatNumber(n).text} INR`,
    (n) =>
      sig === null
        ? "Signal line is not available yet."
        : `MACD line is ${vs(n, sig, "its signal line")} (histogram ${formatNumber(n - sig).text} INR).`,
  );
  push(
    "bb_pos",
    "Bollinger position",
    "bollinger",
    numOf(t, "bb_pos"),
    (n) => formatPercent(n * 100, { decimals: 0 }).text,
    (n) =>
      n > 1
        ? "Last close is above the upper band."
        : n < 0
          ? "Last close is below the lower band."
          : `Last close is inside the bands, ${formatPercent(n * 100, { decimals: 0 }).text} of the way from the lower to the upper band.`,
  );
  push(
    "atr14",
    "ATR 14",
    "atr",
    numOf(t, "atr14"),
    (n) => `${formatNumber(n).text} INR`,
    (n) =>
      close === null
        ? "Average daily range over 14 bars."
        : `Average daily range over 14 bars, ${formatPercent((n / close) * 100).text} of the last close.`,
  );
  const pdi = numOf(t, "plus_di14");
  const mdi = numOf(t, "minus_di14");
  push(
    "adx14",
    "ADX 14",
    "adx",
    numOf(t, "adx14"),
    (n) => `${formatNumber(n, { decimals: 1 }).text} (0-100)`,
    () =>
      pdi === null || mdi === null
        ? "Direction lines are not available."
        : `+DI is ${vs(pdi, mdi, "-DI")}: ${pdi > mdi ? "upward" : pdi < mdi ? "downward" : "neither"} movement is larger. ADX measures how strong the move is, not its direction.`,
  );
  const k = numOf(t, "stoch_k");
  const d = numOf(t, "stoch_d");
  push(
    "stoch_k",
    "Stochastic %K (14, 3)",
    "stochastic",
    k,
    (n) => `${formatNumber(n, { decimals: 1 }).text} (0-100)`,
    (n) =>
      d === null
        ? "%D is not available yet."
        : `%K is ${vs(n, d, "%D")}. %K shows where the last close sits in the 14-bar high-low range.`,
  );
  push(
    "obv",
    "On-balance volume",
    "obv",
    numOf(t, "obv"),
    (n) => `${formatNumber(n, { decimals: 0 }).text} shares`,
    () =>
      "A running total of volume signed by the close's direction; its direction over time matters, the level alone does not.",
  );
  push(
    "volume_z20",
    "Volume z-score",
    "volume_z",
    numOf(t, "volume_z20"),
    (n) => `${formatNumber(n).text} std devs`,
    (n) =>
      `Latest volume is ${formatNumber(Math.abs(n)).text} standard deviations ${n >= 0 ? "above" : "below"} the average of the prior 20 bars (today excluded). The 20-day volume line on the chart includes today, so the two differ by design.`,
  );
  const hi = numOf(t, "high_52w");
  const lo = numOf(t, "low_52w");
  push(
    "high_52w",
    "52-week range",
    "wk52",
    hi,
    (n) => `${inr(n)} high${lo === null ? "" : `, ${inr(lo)} low`}`,
    () => {
      const dist = numOf(t, "dist_52w_high_pct");
      return dist === null
        ? "Distance from the 52-week high is not available."
        : `Last close is ${formatPercent(Math.abs(dist)).text} ${dist <= 0 ? "below" : "above"} the 52-week high.`;
    },
  );
  const golden = t["golden_cross"];
  const death = t["death_cross"];
  rows.push({
    id: "cross",
    label: "SMA 50 / SMA 200 cross (last 20 bars)",
    definition: "cross",
    unknown: typeof golden !== "boolean" || typeof death !== "boolean",
    value:
      typeof golden !== "boolean" || typeof death !== "boolean"
        ? reasonOf(ind, "golden_cross")
        : golden
          ? "Golden cross"
          : death
            ? "Death cross"
            : "No cross",
    read:
      typeof golden !== "boolean" || typeof death !== "boolean"
        ? `No read: ${reasonOf(ind, "golden_cross")}.`
        : golden
          ? "SMA 50 crossed above SMA 200 within the last 20 bars."
          : death
            ? "SMA 50 crossed below SMA 200 within the last 20 bars."
            : "SMA 50 and SMA 200 did not cross within the last 20 bars.",
  });
  return rows;
}

export function levelsOf(ind: IndicatorsData | null): {
  support: Array<{ price: number; touches: number }>;
  resistance: Array<{ price: number; touches: number }>;
} {
  const pick = (v: unknown) =>
    Array.isArray(v)
      ? v.flatMap((r: unknown) => {
          const o = r as { price?: unknown; touches?: unknown } | null;
          return o && typeof o.price === "number" && typeof o.touches === "number"
            ? [{ price: o.price, touches: o.touches }]
            : [];
        })
      : [];
  const t = (ind?.technicals ?? {}) as Tech;
  return { support: pick(t["support"]), resistance: pick(t["resistance"]) };
}

// ---- Analysis tab -------------------------------------------------------------------------

const SRC = "Imported prices (adjusted, price return excludes dividends)";

function pairDataset(
  name: string,
  unit: string,
  p: Pairs,
  asOf: string | null,
  kind: "line" | "area",
  fmt: (n: number) => string,
  nullReason: string,
): ChartDataset {
  return {
    xName: "Date",
    x: p.map(([d]) => formatDate(d).text),
    series: [{ id: name, name, unit, kind, values: p.map(([, v]) => v), format: fmt, nullReason }],
    source: SRC,
    asOf: asOf ? formatDate(asOf).text : null,
  };
}

export function drawdownDataset(p: Pairs, asOf: string | null): ChartDataset {
  return pairDataset(
    "Drawdown",
    "%",
    p,
    asOf,
    "area",
    (n) => formatPercent(n).text,
    "no drawdown for this date",
  );
}

export function rollingVolDataset(
  v21: Pairs | undefined,
  v63: Pairs | undefined,
  asOf: string | null,
): ChartDataset {
  const base = v21 ?? v63 ?? [];
  const dates = base.map(([d]) => d);
  const fmt = (n: number) => formatPercent(n).text;
  const mk = (id: string, name: string, p: Pairs | undefined, dash?: "dashed"): ChartSeries => ({
    id,
    name,
    unit: "% annualised",
    kind: "line",
    values: alignByDate(dates, p),
    format: fmt,
    nullReason: "fewer rows than the window",
    ...(dash ? { dash } : {}),
  });
  return {
    xName: "Date",
    x: dates.map((d) => formatDate(d).text),
    series: [
      mk("vol21", "21-day volatility", v21),
      mk("vol63", "63-day volatility", v63, "dashed"),
    ],
    source: SRC,
    asOf: asOf ? formatDate(asOf).text : null,
  };
}

export function rollingBetaDataset(p: Pairs, asOf: string | null): ChartDataset {
  const d = pairDataset(
    "Rolling beta (252)",
    "ratio",
    p,
    asOf,
    "line",
    (n) => formatRatio(n).text,
    "beta needs at least 120 overlapping days with the Nifty 50 series",
  );
  return { ...d, source: "Imported prices vs Nifty 50 series (price return)" };
}

function erf(x: number): number {
  // Abramowitz and Stegun 7.1.26 (max error 1.5e-7)
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

const cdf = (x: number, mean: number, sd: number) =>
  0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));

export interface HistogramModel {
  dataset: ChartDataset;
  mean: number | null;
  sd: number | null;
}

/** Daily-return histogram with a normal curve fitted to the binned counts (F06-6). */
export function histogramDataset(
  h: { edges: number[]; counts: number[]; n: number },
  asOf: string | null,
): HistogramModel {
  const bins = h.counts.length;
  const mids = h.counts.map((_, i) => ((h.edges[i] ?? 0) + (h.edges[i + 1] ?? 0)) / 2);
  const n = h.counts.reduce((a, b) => a + b, 0);
  const mean = n > 0 ? h.counts.reduce((a, c, i) => a + c * (mids[i] ?? 0), 0) / n : null;
  const sd =
    mean !== null && n > 1
      ? Math.sqrt(h.counts.reduce((a, c, i) => a + c * ((mids[i] ?? 0) - mean) ** 2, 0) / (n - 1))
      : null;
  const label = (i: number) =>
    `${formatPercent(h.edges[i], { decimals: 2 }).text} to ${formatPercent(h.edges[i + 1], { decimals: 2 }).text}`;
  const expected =
    mean !== null && sd !== null && sd > 0
      ? h.counts.map(
          (_, i) => n * (cdf(h.edges[i + 1] ?? 0, mean, sd) - cdf(h.edges[i] ?? 0, mean, sd)),
        )
      : h.counts.map(() => null);
  return {
    mean,
    sd,
    dataset: {
      xName: "Daily return bin",
      x: Array.from({ length: bins }, (_, i) => label(i)),
      series: [
        {
          id: "days",
          name: "Days",
          unit: "days",
          kind: "bar",
          values: h.counts,
          format: (v) => formatCount(v).text,
        },
        {
          id: "normal",
          name: "Normal curve (expected days)",
          unit: "days",
          kind: "line",
          values: expected,
          dash: "dashed",
          format: (v) => formatNumber(v, { decimals: 1 }).text,
          nullReason: "needs a non-zero spread of returns",
        },
      ],
      source: SRC,
      asOf: asOf ? formatDate(asOf).text : null,
    },
  };
}

export const MONTH_NAMES = [
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

export interface HeatModel {
  rows: string[];
  columns: string[];
  cells: Array<Array<{ value: number | null; text: string | null }>>;
  maxAbs: number;
}

const cell = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v)
    ? { value: v, text: formatPercent(v, { signed: true, decimals: 1 }).text }
    : { value: null, text: null };

/** Years as rows, months as columns; months with no return stay unknown. */
export function monthYearModel(
  data: ReadonlyArray<readonly [number, number, number | null]>,
): HeatModel {
  const years = [...new Set(data.map((r) => r[0]))].sort((a, b) => a - b);
  const m = new Map(data.map((r) => [`${r[0]}-${r[1]}`, r[2]]));
  const cells = years.map((y) => MONTH_NAMES.map((_, i) => cell(m.get(`${y}-${i + 1}`))));
  const maxAbs = Math.max(0, ...data.map((r) => (typeof r[2] === "number" ? Math.abs(r[2]) : 0)));
  return { rows: years.map(String), columns: MONTH_NAMES, cells, maxAbs };
}

/** Months as rows (last 13 at most), day of month as columns; no bar = unknown. */
export function calendarModel(c: { dates: string[]; values: Array<number | null> }): HeatModel {
  const byMonth = new Map<string, Map<number, number | null>>();
  c.dates.forEach((d, i) => {
    const key = d.slice(0, 7);
    const day = Number(d.slice(8, 10));
    const row = byMonth.get(key) ?? new Map<number, number | null>();
    row.set(day, c.values[i] ?? null);
    byMonth.set(key, row);
  });
  const keys = [...byMonth.keys()].sort();
  const columns = Array.from({ length: 31 }, (_, i) => String(i + 1));
  const cells = keys.map((k) => columns.map((_, i) => cell(byMonth.get(k)?.get(i + 1))));
  const maxAbs = Math.max(0, ...c.values.map((v) => (typeof v === "number" ? Math.abs(v) : 0)));
  const label = (k: string) => `${MONTH_NAMES[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
  return { rows: keys.map(label), columns, cells, maxAbs };
}
