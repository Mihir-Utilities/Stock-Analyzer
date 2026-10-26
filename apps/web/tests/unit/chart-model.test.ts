import { describe, expect, it } from "vitest";
import {
  buildOption,
  csvModel,
  tableModel,
  type ChartDataset,
} from "@/components/charts/chart-data";
import { buildPaneOption, paneLayout } from "@/components/charts/pane-option";
import { formatInr, formatNumber } from "@/lib/format";
import {
  alignByDate,
  buildChartDataset,
  calendarModel,
  histogramDataset,
  indicatorReads,
  levelsOf,
  monthYearModel,
  overlayAvailability,
  parseAnalysis,
  parseIndicatorSeries,
  rebaseTo100,
  rollingVolumeAverage,
  snapIndex,
  type ChartSelection,
  type Parsed,
  type IndicatorSeries,
} from "@/lib/stock/chart-model";
import type { Bar, IndicatorsData } from "@/lib/stock/schemas";
import { indicatorsWithSeries, manyBars } from "../mocks/chart-fixtures";
import * as fx from "../mocks/stock-fixtures";

const sel = (over: Partial<ChartSelection> = {}): ChartSelection => ({
  type: "candle",
  overlays: new Set(["sma20", "sma50"]),
  panes: new Set(["volume", "rsi", "macd", "stochastic", "adx"]),
  log: false,
  adjusted: true,
  ...over,
});

function indicatorsData(n = 70): IndicatorsData {
  const reply = indicatorsWithSeries(n);
  return (reply.body as { data: IndicatorsData }).data;
}

function build(bars: Bar[], over: Partial<ChartSelection> = {}, series?: Parsed<IndicatorSeries>) {
  const ind = indicatorsData(Math.max(bars.length, 1));
  const lv = levelsOf(ind);
  return buildChartDataset({
    symbol: "TCS",
    bars,
    series: series ?? parseIndicatorSeries(ind.series),
    actions: [],
    support: lv.support,
    resistance: lv.resistance,
    selection: sel(over),
    compare: null,
    asOf: "2026-10-09",
  });
}

describe("alignment and warm-ups (indicator alignment with null warm-ups)", () => {
  it("maps pairs onto the bar dates; warm-up and missing dates are null, never 0", () => {
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03"];
    expect(
      alignByDate(dates, [
        ["2026-01-02", null],
        ["2026-01-03", 5],
      ]),
    ).toEqual([null, null, 5]);
    expect(alignByDate(dates, undefined)).toEqual([null, null, null]);
  });

  it("volume average includes today (D-T) and is null until 20 bars exist", () => {
    const v = Array.from({ length: 25 }, (_, i) => i + 1);
    const a = rollingVolumeAverage(v, 20);
    expect(a.slice(0, 19).every((x) => x === null)).toBe(true);
    expect(a[19]).toBe(10.5); // mean of 1..20 includes bar 20
    expect(a[24]).toBe(15.5); // mean of 6..25
  });

  it("rebases to 100 at the first date both series are known", () => {
    const r = rebaseTo100([
      [null, 10, 20, 40],
      [5, 5, 10, null],
    ]);
    expect(r.startIndex).toBe(1);
    expect(r.values[0]).toEqual([null, 100, 200, 400]);
    expect(r.values[1]).toEqual([null, 100, 200, null]);
    expect(rebaseTo100([[null], [null]]).startIndex).toBeNull();
  });

  it("snaps an action date to the first plotted date on or after it (weekly candles)", () => {
    expect(snapIndex(["2026-01-02", "2026-01-09"], "2026-01-05")).toBe(1);
    expect(snapIndex(["2026-01-02"], "2026-02-01")).toBeNull();
  });
});

describe("chart dataset (every pane aligned with the price pane)", () => {
  it("all series have one value per x entry and every pane shares one x axis", () => {
    const bars = fx.bars(70);
    const { dataset, height } = build(bars);
    expect(dataset.panes?.map((p) => p.id)).toEqual([
      "price",
      "volume",
      "rsi",
      "macd",
      "stochastic",
      "adx",
    ]);
    for (const s of dataset.series) {
      expect(s.values).toHaveLength(dataset.x.length);
      if (s.ohlc) expect(s.ohlc).toHaveLength(dataset.x.length);
    }
    const opt = buildPaneOption(dataset, { theme: "dark" });
    const xs = opt["xAxis"] as Array<{ data: string[] }>;
    expect(xs).toHaveLength(6);
    xs.forEach((a) => expect(a.data).toEqual(dataset.x));
    const grids = opt["grid"] as Array<{ left: number; right: number }>;
    expect(new Set(grids.map((g) => `${g.left}/${g.right}`)).size).toBe(1);
    expect(height).toBeGreaterThan(340);
  });

  it("the warm-up of SMA 20 is null for the first 19 bars", () => {
    const { dataset } = build(fx.bars(70));
    const sma = dataset.series.find((s) => s.id === "sma20");
    expect(sma?.values.slice(0, 19).every((v) => v === null)).toBe(true);
    expect(sma?.values[19]).not.toBeNull();
  });

  it("UI-07: renders with < 10 bars, 1 bar and 0 bars without NaN", () => {
    for (const n of [0, 1, 2, 3, 9]) {
      const { dataset } = build(fx.bars(n));
      const opt = buildOption(dataset, { theme: "light" });
      expect(JSON.stringify(opt)).not.toMatch(/NaN|Infinity/);
      expect(dataset.x).toHaveLength(n);
    }
  });

  it("UI-07: 2,000 points keep every series length (no silent dropping)", () => {
    const bars = manyBars(2000);
    const { dataset } = build(bars, {}, { ok: false, reason: "test" });
    const opt = buildPaneOption(dataset, { theme: "dark" });
    const candle = (opt["series"] as Array<{ type: string; data: unknown[] }>).find(
      (s) => s.type === "candlestick",
    );
    expect(candle?.data).toHaveLength(2000);
  });

  it("UI-10: the data table has every plotted value, OHLC columns and the CSV matches", () => {
    const bars = fx.bars(12);
    const { dataset } = build(bars, { panes: new Set(["volume"]), overlays: new Set() });
    const t = tableModel(dataset);
    expect(t.rows).toHaveLength(12);
    expect(t.headers).toEqual(
      expect.arrayContaining([
        "Price open (INR)",
        "Price high (INR)",
        "Price low (INR)",
        "Price close (INR)",
        "Volume (shares)",
      ]),
    );
    const iClose = t.headers.indexOf("Price close (INR)");
    t.rows.forEach((r, i) => {
      expect(r[iClose]).toBe(formatNumber(bars[i]?.[4]).text);
    });
    const csv = csvModel(dataset);
    expect(csv.rows).toHaveLength(12);
    expect(csv.rows[0]?.[csv.headers.indexOf("Price close (INR)")]).toBe(bars[0]?.[4]);
  });

  it("UI-10: markers add an Event column so the table matches the plotted markers", () => {
    const bars = fx.bars(10);
    const out = buildChartDataset({
      symbol: "TCS",
      bars,
      series: { ok: false, reason: "x" },
      actions: [{ date: bars[4]?.[0] ?? "", type: "split", label: "1:2 split" }],
      support: [],
      resistance: [],
      selection: sel({ panes: new Set(), overlays: new Set() }),
      compare: null,
      asOf: null,
    });
    const t = tableModel(out.dataset);
    expect(t.headers.at(-1)).toBe("Event");
    expect(t.rows[4]?.at(-1)).toContain("1:2 split");
    expect(t.rows[3]?.at(-1)).toBe("");
  });

  it("BRK-17: tiny and huge prices format correctly (no exponent, no overflow text)", () => {
    const bars: Bar[] = [
      ["2026-10-01", 0.0001, 0.0002, 0.0001, 0.0001, 10],
      ["2026-10-02", 12345678.5, 99999999.99, 12345678.5, 99999999.99, 10],
    ];
    const { dataset } = build(bars, { panes: new Set(), overlays: new Set() });
    const t = tableModel(dataset);
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/e[+-]\d|NaN|Infinity/);
    expect(formatInr(99999999.99).text).toBe("₹9,99,99,999.99");
    expect(formatInr(0.0001).text).toBe("₹0.00");
    const opt = buildPaneOption(dataset, { theme: "dark" });
    expect(JSON.stringify(opt)).not.toMatch(/NaN|Infinity/);
  });

  it("compare overlay: both lines rebased to 100 on the first shared date, overlays hidden", () => {
    const bars = fx.bars(10);
    const other = bars.slice(3).map((b) => [b[0], b[1], b[2], b[3], b[4] * 2, b[5]] as Bar);
    const out = buildChartDataset({
      symbol: "TCS",
      bars,
      series: { ok: false, reason: "x" },
      actions: [],
      support: [],
      resistance: [],
      selection: sel({ panes: new Set(), overlays: new Set(["sma20"]) }),
      compare: { symbol: "INFY", bars: other },
      asOf: null,
    });
    const [a, b] = out.dataset.series;
    expect(a?.values[3]).toBe(100);
    expect(b?.values[3]).toBe(100);
    expect(a?.values[0]).toBeNull();
    expect(out.dataset.series.some((s) => s.id === "sma20")).toBe(false);
    expect(out.notes.join(" ")).toContain("start at 100");
    expect(out.dataset.levels).toEqual([]);
  });

  it("raw prices hide the adjusted-basis indicators with a reason, never plot them", () => {
    const { dataset, notes } = build(fx.bars(70), { adjusted: false });
    expect(dataset.series.some((s) => s.id === "sma20" || s.id === "rsi14")).toBe(false);
    expect(notes.join(" ")).toMatch(/adjusted prices/);
    expect(dataset.source).toMatch(/raw/);
  });

  it("EMA 50 is reported as not computed; it is never invented", () => {
    const ind = indicatorsData();
    const s = parseIndicatorSeries(ind.series);
    expect(overlayAvailability("ema50", s, true)).toEqual({
      available: false,
      reason: expect.stringContaining("EMA 50 is not computed"),
    });
    expect(overlayAvailability("sma50", s, true).available).toBe(true);
    expect(overlayAvailability("sma50", s, false).reason).toMatch(/adjusted/);
  });

  it("without indicator series the pane toggles say why instead of drawing empty panes", () => {
    const { dataset, notes } = build(fx.bars(20), {}, { ok: false, reason: "no snapshot" });
    expect(dataset.panes?.map((p) => p.id)).toEqual(["price", "volume"]);
    expect(notes.join(" ")).toMatch(/RSI 14 is not shown: no snapshot/);
  });
});

describe("pane option (pure)", () => {
  it("pane heights add up and never overlap", () => {
    const l = paneLayout([5, 1.6, 2]);
    expect(l[0]?.top).toBe(3);
    for (let i = 1; i < l.length; i++) {
      expect((l[i]?.top ?? 0) >= (l[i - 1]?.top ?? 0) + (l[i - 1]?.height ?? 0)).toBe(true);
    }
    const end = (l.at(-1)?.top ?? 0) + (l.at(-1)?.height ?? 0);
    expect(end).toBeLessThanOrEqual(86.0001);
  });

  it("candles use hollow-up / filled-down (second encoding) and ECharts order", () => {
    const { dataset } = build(fx.bars(5), { panes: new Set(), overlays: new Set() });
    const opt = buildPaneOption(dataset, { theme: "dark" });
    const c = (opt["series"] as Array<Record<string, unknown>>)[0] as {
      itemStyle: { color: string; color0: string };
      data: number[][];
    };
    expect(c.itemStyle.color).not.toBe(c.itemStyle.color0);
    const bar = fx.bars(5)[0] as Bar;
    expect(c.data[0]).toEqual([bar[1], bar[4], bar[3], bar[2]]);
  });

  it("log scale applies to the price pane only; zoom adds inside and slider", () => {
    const { dataset } = build(fx.bars(30), { log: true });
    const opt = buildPaneOption(dataset, { theme: "dark" });
    const y = opt["yAxis"] as Array<{ type: string }>;
    expect(y[0]?.type).toBe("log");
    expect(y[1]?.type).toBe("value");
    const z = opt["dataZoom"] as Array<{ type: string }>;
    expect(z.map((d) => d.type)).toEqual(["inside", "slider"]);
  });

  it("tooltip escapes every dynamic string and shows unit, date and source", () => {
    const bars = fx.bars(5);
    const { dataset } = build(bars, { panes: new Set(), overlays: new Set() });
    const evil: ChartDataset = {
      ...dataset,
      source: "<img src=x onerror=alert(1)>",
    };
    const opt = buildPaneOption(evil, { theme: "dark" });
    const fmt = (opt["tooltip"] as { formatter: (p: unknown) => string }).formatter;
    const html = fmt([{ axisValueLabel: "<b>d</b>", dataIndex: 2, seriesId: "candles" }]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>d");
    expect(html).toContain("INR");
  });

  it("hidden series are dropped from the option", () => {
    const { dataset } = build(fx.bars(30));
    const opt = buildPaneOption(dataset, { theme: "dark", hidden: new Set(["sma20"]) });
    const ids = (opt["series"] as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain("sma20");
    expect(ids).toContain("sma50");
  });
});

describe("indicator reads (plain language, no invented thresholds)", () => {
  it("states definitional comparisons and shows the reason for unknown values", () => {
    const rows = indicatorReads(indicatorsData());
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["sma50"]?.read).toMatch(/above the SMA 50/);
    expect(by["sma200"]?.unknown).toBe(true);
    expect(by["sma200"]?.value).toBe("insufficient history");
    expect(by["sma200"]?.read).toMatch(/^No read: insufficient history/);
    expect(by["macd"]?.read).toMatch(/above its signal line/);
    expect(by["volume_z20"]?.read).toMatch(/prior 20 bars \(today excluded\)/);
    expect(by["volume_z20"]?.read).toMatch(/includes today/);
    const all = rows.map((r) => `${r.value} ${r.read}`).join(" ");
    expect(all).not.toMatch(/overbought|oversold|NaN|Infinity|\b0\b undefined/i);
  });

  it("an empty snapshot gives reasons everywhere and no zeros", () => {
    const ind = {
      as_of: "2026-10-09",
      returns: { calendar: {} },
      technicals: {},
      null_reasons: {},
    } as IndicatorsData;
    const rows = indicatorReads(ind);
    expect(rows.every((r) => r.unknown)).toBe(true);
    expect(rows.every((r) => r.value.length > 0 && r.value !== "0")).toBe(true);
  });
});

describe("analysis models", () => {
  it("parses the stored analysis and rejects a wrong shape with a reason", () => {
    const ind = indicatorsData();
    expect(parseAnalysis(ind.analysis).ok).toBe(true);
    const bad = parseAnalysis({ drawdown: "nope" });
    expect(bad.ok).toBe(false);
    expect(parseAnalysis(undefined)).toEqual({
      ok: false,
      reason: expect.stringContaining("not been computed"),
    });
  });

  it("histogram: bins, counts and a fitted normal curve that sums close to n", () => {
    const m = histogramDataset({ edges: [-2, -1, 0, 1, 2], counts: [3, 20, 25, 5], n: 53 }, null);
    expect(m.dataset.x).toHaveLength(4);
    expect(m.dataset.series[0]?.values).toEqual([3, 20, 25, 5]);
    const exp = m.dataset.series[1]?.values as number[];
    expect(exp.every((v) => Number.isFinite(v))).toBe(true);
    expect(exp.reduce((a, b) => a + b, 0)).toBeGreaterThan(40);
    expect(exp.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(53.01);
    expect(m.mean).toBeCloseTo((3 * -1.5 + 20 * -0.5 + 25 * 0.5 + 5 * 1.5) / 53, 6);
  });

  it("histogram with zero spread has a null curve and a reason, not a flat zero line", () => {
    const m = histogramDataset({ edges: [0, 1], counts: [5], n: 5 }, null);
    expect(m.sd).toBe(0);
    expect(m.dataset.series[1]?.values).toEqual([null]);
    expect(m.dataset.series[1]?.nullReason).toBeTruthy();
  });

  it("month x year: years as rows, missing months unknown", () => {
    const m = monthYearModel([
      [2025, 12, -1.25],
      [2026, 1, 4.1],
      [2026, 2, null],
    ]);
    expect(m.rows).toEqual(["2025", "2026"]);
    expect(m.columns).toHaveLength(12);
    expect(m.cells[0]?.[11]?.text).toBe("-1.3%");
    expect(m.cells[1]?.[1]?.value).toBeNull();
    expect(m.cells[1]?.[5]?.value).toBeNull();
    expect(m.maxAbs).toBe(4.1);
  });

  it("calendar heatmap: months as rows, day of month as columns, no bar is unknown", () => {
    const m = calendarModel({
      dates: ["2026-09-30", "2026-10-01", "2026-10-02"],
      values: [1, null, -0.5],
    });
    expect(m.rows).toEqual(["Sep 2026", "Oct 2026"]);
    expect(m.columns).toHaveLength(31);
    expect(m.cells[0]?.[29]?.text).toBe("+1.0%");
    expect(m.cells[1]?.[0]?.value).toBeNull();
    expect(m.cells[1]?.[1]?.text).toBe("-0.5%");
  });
});
