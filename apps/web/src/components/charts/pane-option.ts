import { colorTokens } from "@/lib/theme/tokens";
import { echartsTheme } from "@/lib/theme/echarts-theme";
import { formatNumber, formatPercent } from "@/lib/format";
import {
  escapeHtml,
  isKnown,
  seriesColor,
  valueText,
  type BuildOptions,
  type ChartDataset,
  type ChartSeries,
} from "./chart-data";

// Stacked-pane option builder (F06): a price pane plus volume / indicator panes that share ONE
// category x axis, identical left/right grid margins and a linked axis pointer, so every pane is
// aligned with the price pane by construction. Pure function, unit-tested without a DOM.
// Candles carry a second encoding next to colour: up = hollow body, down = filled body.

const LEFT = 64;
const RIGHT = 24;
const TOP_PCT = 3;
const BOTTOM_PCT = 14; // room for the x labels and the zoom slider
const GAP_PCT = 3;

const DASH: Record<string, number[] | undefined> = {
  solid: undefined,
  dashed: [6, 4],
  dotted: [2, 3],
};

export interface ZoomWindow {
  start: number;
  end: number;
}

const MIN_SPAN = 5; // percent of the data; keeps at least a handful of bars in view

/**
 * Keyboard zoom and pan for the focusable chart (F06R-1). `+`/`=` zoom in, `-` zooms out,
 * arrow left/right pan by a quarter of the visible window, `0` shows everything.
 * Returns null for any other key. Pure: the caller dispatches the result to ECharts.
 */
export function keyboardZoom(win: ZoomWindow, key: string): ZoomWindow | null {
  const span = win.end - win.start;
  const centre = (win.start + win.end) / 2;
  const clamp = (start: number, end: number): ZoomWindow => {
    const width = Math.min(100, Math.max(MIN_SPAN, end - start));
    const s = Math.min(100 - width, Math.max(0, start));
    return { start: s, end: s + width };
  };
  switch (key) {
    case "+":
    case "=":
      return clamp(centre - span / 3, centre + span / 3);
    case "-":
    case "_":
      return clamp(centre - span * 0.75, centre + span * 0.75);
    case "ArrowLeft":
      return clamp(win.start - span / 4, win.end - span / 4);
    case "ArrowRight":
      return clamp(win.start + span / 4, win.end + span / 4);
    case "0":
      return { start: 0, end: 100 };
    default:
      return null;
  }
}

/** Number of category entries on the first x axis (used to decide whether a zoom still applies). */
export function categoryCount(option: Record<string, unknown>): number {
  const ax = option["xAxis"];
  const first = Array.isArray(ax) ? (ax[0] as { data?: unknown[] } | undefined) : undefined;
  return first?.data?.length ?? 0;
}

/** Carry a zoom window into a rebuilt option (pane toggles keep the visible range). */
export function withZoomWindow(
  option: Record<string, unknown>,
  win: ZoomWindow,
): Record<string, unknown> {
  const dz = option["dataZoom"];
  if (!Array.isArray(dz) || dz.length === 0) return option;
  return {
    ...option,
    dataZoom: dz.map((z) => ({
      ...(z as Record<string, unknown>),
      start: win.start,
      end: win.end,
    })),
  };
}

export function paneLayout(weights: ReadonlyArray<number>): Array<{ top: number; height: number }> {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const usable = 100 - TOP_PCT - BOTTOM_PCT - GAP_PCT * Math.max(0, weights.length - 1);
  let top = TOP_PCT;
  return weights.map((w) => {
    const height = (usable * w) / total;
    const out = { top, height };
    top += height + GAP_PCT;
    return out;
  });
}

function candleChange(s: ChartSeries, i: number): string {
  const o = s.ohlc?.[i];
  const prev = s.ohlc?.[i - 1];
  if (!o || !prev || prev[3] === 0) return "";
  return ` (${formatPercent((o[3] / prev[3] - 1) * 100, { signed: true }).text} vs previous bar)`;
}

export function buildPaneOption(data: ChartDataset, opts: BuildOptions): Record<string, unknown> {
  const theme = echartsTheme(opts.theme);
  const hidden = opts.hidden ?? new Set<string>();
  const panes = data.panes ?? [];
  const layout = paneLayout(panes.map((p) => p.weight));
  const up = colorTokens.up[opts.theme];
  const down = colorTokens.down[opts.theme];
  const hollow = colorTokens["surface-1"][opts.theme];
  const lastPane = panes.length - 1;

  const grid = layout.map((l) => ({
    left: LEFT,
    right: RIGHT,
    top: `${l.top}%`,
    height: `${l.height}%`,
  }));
  const xData = [...data.x]; // one array shared by every pane
  const xAxis = panes.map((_, i) => ({
    type: "category",
    gridIndex: i,
    data: xData,
    boundaryGap: true,
    name: i === lastPane ? data.xName : undefined,
    nameLocation: "middle",
    nameGap: 28,
    axisLabel: { show: i === lastPane, hideOverlap: true },
    axisTick: { show: i === lastPane },
    axisPointer: { show: true, label: { show: i === lastPane } },
  }));
  const yAxis = panes.map((p, i) => {
    // Bars must start at zero: a pane with bars never uses the fitted (scale) axis; volume-like
    // panes (no negative bar) also pin the minimum at 0. A MACD histogram stays zero-centred.
    const bars = data.series.filter(
      (s) => Math.min(s.pane ?? 0, lastPane) === i && s.kind === "bar",
    );
    const hasBars = bars.length > 0;
    const nonNegative = bars.every((s) => s.values.every((v) => !isKnown(v) || v >= 0));
    return {
      type: i === 0 && data.logScale ? "log" : "value",
      gridIndex: i,
      scale: !hasBars,
      ...(hasBars && nonNegative ? { min: 0 } : {}),
      name: p.unit ? `${p.name} (${p.unit})` : p.name,
      nameLocation: "end",
      nameGap: 6,
      nameTextStyle: { align: "left" },
      splitNumber: i === 0 ? 5 : 2,
    };
  });

  const firstOfMain = data.series.find((s) => (s.pane ?? 0) === 0 && !hidden.has(s.id));
  // Markers sit on the close (or rebased close), not on whichever overlay is first visible.
  const anchor =
    data.series.find((s) => (s.pane ?? 0) === 0 && (s.kind === "candle" || s.id === "close")) ??
    firstOfMain;
  const usable = (v: number | null | undefined): v is number =>
    isKnown(v) && (!data.logScale || v > 0);
  const markerData = (data.markers ?? []).flatMap((m) => {
    const values = anchor?.values ?? [];
    let v = values[m.index];
    for (let d = 1; !usable(v) && d < values.length; d++) {
      const before = values[m.index - d];
      const after = values[m.index + d];
      v = usable(before) ? before : usable(after) ? after : undefined;
    }
    // No valid value anywhere on the series: omit the pin rather than drawing it at 0.
    return usable(v) ? [{ name: m.label, coord: [m.index, v], value: m.label }] : [];
  });

  const series = data.series.flatMap((s, position): Array<Record<string, unknown>> => {
    if (hidden.has(s.id)) return [];
    const pane = Math.min(s.pane ?? 0, lastPane);
    const axes = { xAxisIndex: pane, yAxisIndex: pane };
    const color = seriesColor(s, position, opts.theme);
    const decorations: Record<string, unknown> = {};
    if (s === firstOfMain) {
      if (markerData.length > 0) {
        decorations["markPoint"] = {
          symbol: "pin",
          symbolSize: 34,
          itemStyle: { color: colorTokens.accent[opts.theme] },
          label: { color: colorTokens["text-1"][opts.theme], fontSize: 10, position: "top" },
          data: markerData,
          silent: true,
        };
      }
      if ((data.levels ?? []).length > 0) {
        decorations["markLine"] = {
          symbol: "none",
          silent: true,
          lineStyle: { type: "dashed", color: colorTokens["text-2"][opts.theme], width: 1 },
          label: {
            formatter: (p: { name?: string }) => p.name ?? "",
            color: colorTokens["text-2"][opts.theme],
            position: "insideEndTop",
            fontSize: 10,
          },
          data: (data.levels ?? []).map((l) => ({ yAxis: l.price, name: l.label })),
        };
      }
    }
    if (s.kind === "candle") {
      return [
        {
          id: s.id,
          name: s.name,
          type: "candlestick",
          ...axes,
          // ECharts order: open, close, lowest, highest. Null bars are gaps.
          data: (s.ohlc ?? []).map((o) => (o ? [o[0], o[3], o[2], o[1]] : "-")),
          itemStyle: { color: hollow, color0: down, borderColor: up, borderColor0: down },
          large: data.x.length > 2000,
          ...decorations,
        },
      ];
    }
    const values = s.values.map((v) => (isKnown(v) ? v : null));
    if (s.kind === "bar") {
      return [
        {
          id: s.id,
          name: s.name,
          type: "bar",
          ...axes,
          data: values,
          itemStyle: { color },
          large: data.x.length > 2000,
          ...decorations,
        },
      ];
    }
    const dash = DASH[s.dash ?? "solid"];
    return [
      {
        id: s.id,
        name: s.name,
        type: "line",
        ...axes,
        data: values,
        showSymbol: false,
        connectNulls: false,
        itemStyle: { color },
        lineStyle: { color, width: 2, type: s.forecast ? "dashed" : (dash ?? "solid") },
        areaStyle: s.kind === "area" ? { color, opacity: 0.18 } : undefined,
        emphasis: { focus: "series" },
        ...decorations,
      },
    ];
  });

  const zoomAxes = panes.map((_, i) => i);
  const dataZoom = data.zoom
    ? [
        { type: "inside", xAxisIndex: zoomAxes, filterMode: "filter", zoomOnMouseWheel: true },
        {
          type: "slider",
          xAxisIndex: zoomAxes,
          filterMode: "filter",
          height: 18,
          bottom: 4,
          borderColor: colorTokens.border[opts.theme],
          textStyle: { color: theme.textStyle.color },
        },
      ]
    : [];

  return {
    animation: !opts.reducedMotion && data.x.length <= 500,
    aria: { enabled: true, decal: { show: true } },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid,
    xAxis,
    yAxis,
    dataZoom,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      confine: true,
      formatter: (params: unknown) => {
        const list = Array.isArray(params)
          ? (params as Array<{ axisValueLabel?: string; dataIndex: number; seriesId?: string }>)
          : [];
        const head = escapeHtml(list[0]?.axisValueLabel ?? "");
        const lines = list.map((p) => {
          const s = data.series.find((x) => x.id === p.seriesId);
          if (!s) return "";
          if (s.kind === "candle") {
            const o = s.ohlc?.[p.dataIndex];
            if (!o) return `${escapeHtml(s.name)}: ${escapeHtml(s.nullReason ?? "No data")}`;
            const t = (k: number) =>
              s.format ? s.format(o[k] as number) : formatNumber(o[k]).text;
            return `${escapeHtml(s.name)}: O ${t(0)} H ${t(1)} L ${t(2)} C ${t(3)} ${escapeHtml(s.unit)}${escapeHtml(candleChange(s, p.dataIndex))}`;
          }
          const v = s.values[p.dataIndex];
          return `${escapeHtml(s.name)}: ${escapeHtml(valueText(s, v))} ${isKnown(v) ? escapeHtml(s.unit) : ""}`;
        });
        const marks = (data.markers ?? [])
          .filter((m) => m.index === list[0]?.dataIndex)
          .map((m) => `<br/>Event: ${escapeHtml(m.label)}`)
          .join("");
        return `${head}<br/>${lines.filter(Boolean).join("<br/>")}${marks}<br/><small>${escapeHtml(data.source)}${data.asOf ? `, as of ${escapeHtml(data.asOf)}` : ""}</small>`;
      },
    },
    series,
  };
}
