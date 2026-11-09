import { describe, expect, it } from "vitest";
import type { ChartDataset } from "@/components/charts/chart-data";
import {
  buildPaneOption,
  categoryCount,
  keyboardZoom,
  withZoomWindow,
} from "@/components/charts/pane-option";
import {
  buildChartDataset,
  levelsOf,
  parseIndicatorSeries,
  priceText,
  type ChartSelection,
} from "@/lib/stock/chart-model";
import type { Bar, IndicatorsData } from "@/lib/stock/schemas";
import { indicatorsWithSeries } from "../mocks/chart-fixtures";
import * as fx from "../mocks/stock-fixtures";

// Review fixes for F06 (F06R-1..6): deterministic, no clock, no random data.

const sel = (over: Partial<ChartSelection> = {}): ChartSelection => ({
  type: "candle",
  overlays: new Set(),
  panes: new Set(["volume"]),
  log: false,
  adjusted: true,
  ...over,
});

const ind = (n = 70): IndicatorsData =>
  (indicatorsWithSeries(n).body as { data: IndicatorsData }).data;

function build(
  bars: Bar[],
  over: Partial<ChartSelection> = {},
  extra: { interval?: string | null; compare?: { symbol: string; bars: Bar[] } } = {},
) {
  const data = ind(bars.length);
  const lv = levelsOf(data);
  return buildChartDataset({
    symbol: "TCS",
    bars,
    series: parseIndicatorSeries(data.series),
    actions: [],
    support: lv.support,
    resistance: lv.resistance,
    selection: sel(over),
    compare: extra.compare ?? null,
    asOf: "2026-10-09",
    interval: extra.interval ?? null,
  });
}

type Axis = { scale?: boolean; min?: number; type: string };
const yAxes = (d: ChartDataset): Axis[] => buildPaneOption(d, { theme: "dark" })["yAxis"] as Axis[];

describe("F06 review: volume average label follows the interval", () => {
  it("daily bars: 20-day average incl. today", () => {
    const s = build(fx.bars(30)).dataset.series.find((x) => x.id === "volume-avg20");
    expect(s?.name).toBe("Volume, 20-day average incl. today");
    expect(s?.nullReason).toMatch(/20 days/);
  });
  it("weekly bars: 20-week average incl. current week", () => {
    const s = build(fx.bars(30), {}, { interval: "1w" }).dataset.series.find(
      (x) => x.id === "volume-avg20",
    );
    expect(s?.name).toBe("Volume, 20-week average incl. current week");
    expect(s?.name).not.toMatch(/day|today/);
    expect(s?.nullReason).toMatch(/20 weeks/);
    expect(s?.values.slice(0, 19).every((v) => v === null)).toBe(true);
    expect(typeof s?.values[19]).toBe("number");
  });
});

describe("F06 review: bar panes start at zero", () => {
  it("volume axis is not fitted (scale false, min 0); price is fitted; MACD histogram stays zero-centred", () => {
    const d = build(fx.bars(40), { panes: new Set(["volume", "macd"]) }).dataset;
    const [price, volume, macd] = yAxes(d);
    expect(price?.scale).toBe(true);
    expect(volume?.scale).toBe(false);
    expect(volume?.min).toBe(0);
    expect(macd?.scale).toBe(false);
    expect(macd).not.toHaveProperty("min");
  });
});

describe("F06 review: markers never sit at 0", () => {
  const line = (id: string, values: Array<number | null>) => ({
    id,
    name: id,
    unit: "INR",
    kind: "line" as const,
    values,
  });
  const base = (over: Partial<ChartDataset> = {}): ChartDataset => ({
    xName: "Date",
    x: ["a", "b", "c", "d"],
    source: "s",
    asOf: null,
    panes: [{ id: "price", name: "Price", unit: "INR", weight: 1 }],
    series: [line("sma", [null, null, 5, 6]), line("close", [10, 11, 12, 13])],
    markers: [{ index: 1, label: "split" }],
    ...over,
  });
  const points = (d: ChartDataset, hidden: string[] = []) => {
    const opt = buildPaneOption(d, { theme: "dark", hidden: new Set(hidden) });
    return (opt["series"] as Array<{ markPoint?: { data: Array<{ coord: number[] }> } }>).flatMap(
      (s) => s.markPoint?.data.map((p) => p.coord) ?? [],
    );
  };
  it("anchors to the close even when an overlay with a null at that index is drawn first", () => {
    expect(
      points(base({ series: [line("sma", [null, null, 5, 6]), line("close", [10, 11, 12, 13])] })),
    ).toEqual([[1, 11]]);
  });
  it("uses the candle close when candles are hidden and the SMA is null at the marker", () => {
    const d = base({
      series: [
        {
          id: "candles",
          name: "Price",
          unit: "INR",
          kind: "candle",
          values: [10, 11, 12, 13],
          ohlc: [10, 11, 12, 13].map((c) => [c, c, c, c] as const),
        },
        line("sma", [null, null, 5, 6]),
      ],
    });
    expect(points(d, ["candles"])).toEqual([[1, 11]]);
  });
  it("snaps to the nearest valid close when the close itself is null there", () => {
    expect(points(base({ series: [line("close", [null, null, 12, 13])] }))).toEqual([[1, 12]]);
  });
  it("omits the marker with no valid value, and on a log axis for non-positive values", () => {
    expect(points(base({ series: [line("close", [null, null, null, null])] }))).toEqual([]);
    expect(points(base({ logScale: true, series: [line("close", [0, 0, -1, 0])] }))).toEqual([]);
    expect(points(base({ logScale: true, series: [line("close", [0, 7, 0, 0])] }))).toEqual([
      [1, 7],
    ]);
  });
});

describe("F06 review: tiny prices (BRK-17)", () => {
  it("shows significant digits below 0.01 and leaves normal prices alone", () => {
    expect(priceText(0.0001)).toBe("0.000100");
    expect(priceText(0.00345)).toBe("0.00345");
    expect(priceText(-0.0001)).toBe("-0.000100");
    expect(priceText(0.00000001)).toBe("0.00000001");
    expect(priceText(0.000000001)).toBe("below 0.00000001");
    expect(priceText(-0.000000001)).toBe("above -0.00000001");
    expect(priceText(0.01)).toBe("0.01");
    expect(priceText(0)).toBe("0.00");
    expect(priceText(1234567.891)).toBe("12,34,567.89");
  });
});

describe("F06 review: compare keeps log scale working", () => {
  it("log stays on with compare and the rebased values are positive or null", () => {
    const bars = fx.bars(10);
    const other = bars.slice(3).map((b) => [b[0], b[1], b[2], b[3], b[4] * 2, b[5]] as Bar);
    const { dataset } = build(bars, { log: true }, { compare: { symbol: "INFY", bars: other } });
    expect(dataset.logScale).toBe(true);
    for (const s of dataset.series) {
      expect(s.values.every((v) => v === null || v > 0)).toBe(true);
    }
    expect(yAxes(dataset)[0]?.type).toBe("log");
  });
});

describe("F06 review: gap reason when a pane series is absent", () => {
  const withRsi = (drop: boolean) => {
    const data = ind(40);
    const series = { ...(data.series as Record<string, unknown>) };
    if (drop) delete series["rsi14"];
    return buildChartDataset({
      symbol: "TCS",
      bars: fx.bars(40),
      series: parseIndicatorSeries(series),
      actions: [],
      support: [],
      resistance: [],
      selection: sel({ panes: new Set(["rsi"]) }),
      compare: null,
      asOf: null,
    }).dataset.series.find((s) => s.id === "rsi14");
  };
  it("rsi14 missing from the stored block is not called warm-up", () => {
    expect(withRsi(true)?.nullReason).toBe("not in the stored indicator series");
  });
  it("rsi14 present keeps the warm-up reason", () => {
    expect(withRsi(false)?.nullReason).toMatch(/warm-up/);
  });
});

describe("F06 review: keyboard zoom and zoom carry-over", () => {
  it("+ narrows, - widens, arrows pan, 0 resets, other keys are ignored", () => {
    const full = { start: 0, end: 100 };
    const zin = keyboardZoom(full, "+");
    expect((zin?.end ?? 0) - (zin?.start ?? 0)).toBeLessThan(100);
    expect(keyboardZoom({ start: 20, end: 60 }, "ArrowRight")).toEqual({ start: 30, end: 70 });
    expect(keyboardZoom({ start: 20, end: 60 }, "ArrowLeft")).toEqual({ start: 10, end: 50 });
    expect(keyboardZoom({ start: 80, end: 100 }, "ArrowRight")).toEqual({ start: 80, end: 100 });
    expect(keyboardZoom({ start: 40, end: 60 }, "-")).toEqual({ start: 35, end: 65 });
    expect(keyboardZoom({ start: 40, end: 60 }, "0")).toEqual(full);
    expect(keyboardZoom(full, "-")).toEqual(full);
    expect(keyboardZoom(full, "a")).toBeNull();
    const tight = keyboardZoom({ start: 10, end: 12 }, "+");
    expect((tight?.end ?? 0) - (tight?.start ?? 0)).toBeGreaterThanOrEqual(5);
  });
  it("withZoomWindow carries a window into every dataZoom entry; categoryCount reads x", () => {
    const d = build(fx.bars(30)).dataset;
    const opt = buildPaneOption(d, { theme: "dark" });
    expect(categoryCount(opt)).toBe(30);
    const next = withZoomWindow(opt, { start: 25, end: 75 });
    for (const z of next["dataZoom"] as Array<{ start: number; end: number }>) {
      expect([z.start, z.end]).toEqual([25, 75]);
    }
  });
  it("every pane shares one x category array", () => {
    const d = build(fx.bars(30), { panes: new Set(["volume", "rsi"]) }).dataset;
    const xs = buildPaneOption(d, { theme: "dark" })["xAxis"] as Array<{ data: unknown }>;
    expect(xs).toHaveLength(3);
    expect(xs[1]?.data).toBe(xs[0]?.data);
  });
});
