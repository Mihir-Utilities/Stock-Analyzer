import { categoricalPalette, colorTokens, type ThemeName } from "@/lib/theme/tokens";
import { echartsTheme } from "@/lib/theme/echarts-theme";
import { formatNumber } from "@/lib/format";
import { buildPaneOption } from "./pane-option";

// Chart data model and ECharts option builder (docs/06a sections 4-5). Everything here is pure
// so it can be unit tested without a DOM. The same dataset feeds the chart and the "Show data"
// table, which is how UI-10 (every chart has a data-table view) holds by construction.

export interface ChartSeries {
  id: string;
  name: string;
  /** Unit for tooltips, table headers and CSV, e.g. "INR" or "%". */
  unit: string;
  kind: "line" | "area" | "bar" | "candle";
  /** Pane index (0 = main price pane). Only used when the dataset declares `panes`. */
  pane?: number;
  /** Candle series: [open, high, low, close] per x entry (null = no bar); `values` holds the close. */
  ohlc?: ReadonlyArray<readonly [number, number, number, number] | null>;
  /** Second encoding for overlapping lines next to colour. */
  dash?: "solid" | "dashed" | "dotted";
  /** One value per x entry; null (or non-finite) = unknown, drawn as a gap and shown as a reason. */
  values: ReadonlyArray<number | null>;
  /** Forecast series are dashed, hatched and drawn in --exp. */
  forecast?: boolean;
  /** Estimated values are marked in the table and tooltip. */
  estimated?: boolean;
  /** Index into the categorical palette; defaults to the series position (stable identity). */
  colorIndex?: number;
  /** Per-series formatter from format.ts; defaults to format.ts formatNumber. */
  format?: (value: number) => string;
  nullReason?: string;
}

/** One stacked panel sharing the x axis (price, volume, RSI ...). `weight` = relative height. */
export interface ChartPane {
  id: string;
  name: string;
  unit: string;
  weight: number;
}

/** A labelled event on the price pane (corporate action); `index` points into `x`. */
export interface ChartMarker {
  index: number;
  label: string;
}

/** A horizontal reference level on the price pane (support / resistance). */
export interface ChartLevel {
  price: number;
  label: string;
}

export interface ChartDataset {
  xName: string;
  x: ReadonlyArray<string>;
  series: ReadonlyArray<ChartSeries>;
  source: string;
  asOf: string | null;
  /** Set when the plotted points are fewer than the source points. */
  downsampledFrom?: number;
  /** Stacked panes sharing one x axis; when set the pane builder draws the chart. */
  panes?: ReadonlyArray<ChartPane>;
  markers?: ReadonlyArray<ChartMarker>;
  levels?: ReadonlyArray<ChartLevel>;
  /** Logarithmic price axis (main pane). */
  logScale?: boolean;
  /** Mouse wheel, drag and touch pinch zoom plus a slider. */
  zoom?: boolean;
}

/** Marker shapes: the second encoding next to colour (OQ-16). Used in lines, legend and table. */
export const SERIES_SYMBOLS = [
  "circle",
  "rect",
  "triangle",
  "diamond",
  "roundRect",
  "pin",
  "arrow",
  "emptyCircle",
] as const;

export const SHOW_SYMBOL_BELOW = 61;
export const SAMPLE_ABOVE = 1000;

export function isKnown(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export function seriesColor(s: ChartSeries, position: number, theme: ThemeName): string {
  if (s.forecast) return colorTokens.exp[theme];
  const i = s.colorIndex ?? position;
  return categoricalPalette[i % categoricalPalette.length] ?? categoricalPalette[0];
}

export function seriesSymbol(position: number): (typeof SERIES_SYMBOLS)[number] {
  return SERIES_SYMBOLS[position % SERIES_SYMBOLS.length] ?? "circle";
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Text shown in a table cell or tooltip for a value, or the reason when unknown. */
export function valueText(s: ChartSeries, v: number | null | undefined): string {
  if (!isKnown(v)) return s.nullReason ?? "No data";
  const t = s.format ? s.format(v) : formatNumber(v).text;
  return s.estimated ? `${t} (est.)` : t;
}

export interface BuildOptions {
  theme: ThemeName;
  hidden?: ReadonlySet<string>;
  logScale?: boolean;
  /** prefers-reduced-motion: no animation at all. */
  reducedMotion?: boolean;
}

/** Plain option object (typed loosely on purpose: it is handed straight to echarts.setOption). */
export function buildOption(data: ChartDataset, opts: BuildOptions): Record<string, unknown> {
  if (data.panes && data.panes.length > 0) return buildPaneOption(data, opts);
  const theme = echartsTheme(opts.theme);
  const hidden = opts.hidden ?? new Set<string>();
  const many = data.x.length >= SHOW_SYMBOL_BELOW;
  const sampling = data.x.length > SAMPLE_ABOVE;
  const visible = data.series.filter((s) => !hidden.has(s.id));
  const hasBars = visible.some((s) => s.kind === "bar");

  const series = data.series.flatMap((s, position) => {
    if (hidden.has(s.id)) return [];
    const color = seriesColor(s, position, opts.theme);
    const symbol = seriesSymbol(position);
    const values = s.values.map((v) => (isKnown(v) ? v : null));
    if (s.kind === "bar") {
      return [
        {
          id: s.id,
          name: s.name,
          type: "bar",
          data: values,
          // Bars get a per-series decal pattern from aria.decal (second encoding).
          itemStyle: { color },
        },
      ];
    }
    return [
      {
        id: s.id,
        name: s.name,
        type: "line",
        data: values,
        symbol,
        symbolSize: 6,
        showSymbol: !many,
        sampling: sampling ? "lttb" : undefined,
        connectNulls: false,
        itemStyle: { color },
        lineStyle: { color, width: 2, type: s.forecast ? "dashed" : "solid" },
        areaStyle: s.kind === "area" ? { color, opacity: s.forecast ? 0.12 : 0.18 } : undefined,
        // End label: the series name sits at the last point, a non-colour identity cue.
        endLabel: { show: true, formatter: s.name, color: theme.textStyle.color, distance: 6 },
        emphasis: { focus: "series" },
      },
    ];
  });

  return {
    animation: !opts.reducedMotion && data.x.length <= 500,
    aria: { enabled: true, decal: { show: true } },
    grid: { left: 8, right: 96, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      confine: true,
      // Every dynamic string is escaped before it reaches ECharts' HTML tooltip.
      formatter: (params: unknown) => {
        const list = Array.isArray(params)
          ? (params as Array<{ axisValueLabel?: string; dataIndex: number; seriesId?: string }>)
          : [];
        const first = list[0];
        const head = escapeHtml(first?.axisValueLabel ?? "");
        const lines = list.map((p) => {
          const s = data.series.find((x) => x.id === p.seriesId);
          if (!s) return "";
          return `${escapeHtml(s.name)}: ${escapeHtml(valueText(s, s.values[p.dataIndex]))} ${isKnown(s.values[p.dataIndex]) ? escapeHtml(s.unit) : ""}`;
        });
        return `${head}<br/>${lines.join("<br/>")}<br/><small>${escapeHtml(data.source)}${data.asOf ? `, as of ${escapeHtml(data.asOf)}` : ""}</small>`;
      },
    },
    xAxis: { type: "category", name: data.xName, data: [...data.x], boundaryGap: hasBars },
    yAxis: {
      type: opts.logScale ? "log" : "value",
      scale: !hasBars,
      name: unitsOf(visible),
    },
    series,
  };
}

export function unitsOf(series: ReadonlyArray<ChartSeries>): string {
  return [...new Set(series.map((s) => s.unit).filter(Boolean))].join(" / ");
}

const OHLC_LABELS = ["Open", "High", "Low", "Close"] as const;

function columnsOf(s: ChartSeries): string[] {
  if (s.kind === "candle")
    return OHLC_LABELS.map((l) => `${s.name} ${l.toLowerCase()} (${s.unit})`);
  return [s.unit ? `${s.name} (${s.unit})` : s.name];
}

function cellsOf(s: ChartSeries, i: number): string[] {
  if (s.kind === "candle") {
    const o = s.ohlc?.[i];
    return OHLC_LABELS.map((_, k) => valueText(s, o ? o[k] : null));
  }
  return [valueText(s, s.values[i])];
}

function markerText(data: ChartDataset, i: number): string {
  return (data.markers ?? [])
    .filter((m) => m.index === i)
    .map((m) => m.label)
    .join("; ");
}

/** Everything the "Show data" table and CSV export need (UI-10 parity): every plotted value. */
export function tableModel(data: ChartDataset): { headers: string[]; rows: string[][] } {
  const hasMarkers = (data.markers ?? []).length > 0;
  const headers = [data.xName, ...data.series.flatMap(columnsOf), ...(hasMarkers ? ["Event"] : [])];
  const rows = data.x.map((x, i) => [
    x,
    ...data.series.flatMap((s) => cellsOf(s, i)),
    ...(hasMarkers ? [markerText(data, i)] : []),
  ]);
  return { headers, rows };
}

/** Raw numbers for CSV (nulls stay empty). */
export function csvModel(data: ChartDataset): {
  headers: string[];
  rows: Array<Array<string | number | null>>;
} {
  const hasMarkers = (data.markers ?? []).length > 0;
  const headers = tableModel(data).headers;
  const num = (v: number | null | undefined) => (isKnown(v) ? v : null);
  const rows = data.x.map((x, i) => [
    x,
    ...data.series.flatMap((s): Array<number | null> => {
      if (s.kind === "candle") {
        const o = s.ohlc?.[i];
        return [0, 1, 2, 3].map((k) => num(o ? o[k] : null));
      }
      return [num(s.values[i])];
    }),
    ...(hasMarkers ? [markerText(data, i)] : []),
  ]);
  return { headers, rows };
}
