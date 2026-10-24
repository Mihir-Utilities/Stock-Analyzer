import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOption,
  csvModel,
  SERIES_SYMBOLS,
  seriesSymbol,
  tableModel,
  type ChartDataset,
} from "@/components/charts/chart-data";
import { ChartFrame } from "@/components/charts/ChartFrame";
import * as csv from "@/components/ui/csv";
import { toCsv } from "@/components/ui/csv";
import { applyTheme } from "@/lib/theme/use-theme";

function dataset(n: number, seriesCount = 2): ChartDataset {
  return {
    xName: "Date",
    x: Array.from({ length: n }, (_, i) => `2025-01-${String((i % 28) + 1).padStart(2, "0")}#${i}`),
    series: Array.from({ length: seriesCount }, (_, s) => ({
      id: `s${s}`,
      name: `Series ${s}`,
      unit: "INR",
      kind: "line" as const,
      values: Array.from({ length: n }, (_, i) => (i % 7 === 3 ? null : 100 + s * 10 + (i % 13))),
    })),
    source: "Test source",
    asOf: "2025-01-28",
  };
}

afterEach(() => vi.restoreAllMocks());

// UI-07 / UI-10: jsdom has no layout, so this file covers the model, the empty state and the real
// ECharts SVG renderer; real-browser drawing is in tests/e2e/stories.spec.ts (UI-07, UI-10 tests).
describe("UI-07 charts render with 0, 1, 2, 10 and 2000 points", () => {
  it.each([0, 1, 2, 10, 2000])("buildOption handles %i points", (n) => {
    const opt = buildOption(dataset(n), { theme: "dark" });
    const series = opt["series"] as Array<{ data: unknown[] }>;
    expect(series).toHaveLength(2);
    series.forEach((s) => expect(s.data).toHaveLength(n));
    expect(JSON.stringify(opt)).not.toMatch(/NaN|Infinity/);
  });

  it.each([1, 2, 10, 2000])(
    "ChartFrame draws %i points in the real ECharts SVG renderer",
    async (n) => {
      const errors: unknown[] = [];
      vi.spyOn(console, "error").mockImplementation((e) => errors.push(e));
      render(<ChartFrame title="Price" dataset={dataset(n)} />);
      await waitFor(
        () => expect(screen.getByTestId("chart-canvas").dataset["ready"]).toBe("true"),
        {
          timeout: 10_000,
        },
      );
      await waitFor(() =>
        expect(screen.getByTestId("chart-canvas").querySelector("svg")).not.toBeNull(),
      );
      expect(screen.queryByText(/could not be drawn/)).toBeNull();
      expect(errors).toEqual([]);
    },
    20_000,
  );

  it("0 points shows the empty state instead of an empty plot", () => {
    render(<ChartFrame title="Price" dataset={dataset(0)} />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    expect(screen.queryByTestId("chart-canvas")).toBeNull();
  });

  it("2000 points are flagged as simplified, and Show data keeps all of them", async () => {
    render(<ChartFrame title="Price" dataset={dataset(2000)} />);
    expect(screen.getByTestId("chart-sampled")).toBeTruthy();
    await userEvent.click(screen.getByTestId("chart-show-data"));
    expect(screen.getAllByTestId("chart-data-row")).toHaveLength(2000);
  });
});

describe("UI-10 every chart has a data-table view with parity", () => {
  it("lists every x and every value with unit, using the reason for unknowns", async () => {
    const d = dataset(10);
    render(<ChartFrame title="Price" dataset={d} />);
    await userEvent.click(screen.getByTestId("chart-show-data"));
    const rows = screen.getAllByTestId("chart-data-row");
    expect(rows).toHaveLength(d.x.length);
    const model = tableModel(d);
    expect(model.headers).toEqual(["Date", "Series 0 (INR)", "Series 1 (INR)"]);
    rows.forEach((row, i) => {
      const cells = within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent);
      expect(cells).toEqual(model.rows[i]);
    });
    // Index 3 is unknown: a reason, never 0 or NaN.
    expect(model.rows[3]?.[1]).toBe("No data");
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  });

  it("plotted values and table values come from the same dataset", () => {
    const d = dataset(10);
    const opt = buildOption(d, { theme: "light" });
    const plotted = (opt["series"] as Array<{ data: Array<number | null> }>)[0]?.data;
    const csvRows = csvModel(d).rows.map((r) => r[1]);
    expect(plotted).toEqual(csvRows);
  });

  it("non-finite inputs become unknown, not zero", () => {
    const d: ChartDataset = {
      ...dataset(3, 1),
      series: [
        {
          id: "a",
          name: "A",
          unit: "%",
          kind: "line",
          values: [Number.NaN, Number.POSITIVE_INFINITY, 2],
        },
      ],
    };
    expect(tableModel(d).rows.map((r) => r[1])).toEqual(["No data", "No data", "2.00"]);
  });
});

// UI-17: unknown, NaN or Infinity never reach the screen as 0/NaN/Infinity; the CSV cell is empty.
describe("UI-17 unknown values in a chart", () => {
  const bad: ChartDataset = {
    xName: "Date",
    x: ["d1", "d2", "d3", "d4"],
    series: [
      {
        id: "a",
        name: "A",
        unit: "%",
        kind: "line",
        values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null],
      },
      { id: "b", name: "B", unit: "%", kind: "line", values: [1, 2, 3, 4] },
    ],
    source: "Test source",
    asOf: "2025-01-28",
  };

  it("table cells say No data and the plotted option has no NaN or Infinity", () => {
    expect(tableModel(bad).rows.map((r) => r[1])).toEqual(Array(4).fill("No data"));
    const opt = buildOption(bad, { theme: "dark" });
    const a = (opt["series"] as Array<{ data: unknown[] }>)[0]?.data;
    expect(a).toEqual([null, null, null, null]);
  });

  it("CSV cell is empty (not 0, NaN or Infinity) for unknown values", () => {
    const m = csvModel(bad);
    const lines = toCsv(m.headers, m.rows).split("\r\n");
    expect(lines.slice(1, 5)).toEqual(["d1,,1", "d2,,2", "d3,,3", "d4,,4"]);
    expect(lines.join("\n")).not.toMatch(/NaN|Infinity/);
  });

  it("the rendered table view never shows NaN, Infinity or a bare 0", async () => {
    render(<ChartFrame title="Price" dataset={bad} />);
    await userEvent.click(screen.getByTestId("chart-show-data"));
    const cells = screen
      .getAllByTestId("chart-data-row")
      .map((r) => within(r).getAllByRole("cell")[1]?.textContent);
    expect(cells).toEqual(Array(4).fill("No data"));
  });
});

// UI-19: the chart follows a theme change without reload, also when only the attribute changes.
describe("UI-19 theme changes while a chart is mounted", () => {
  async function ready() {
    await waitFor(() => expect(screen.getByTestId("chart-canvas").dataset["ready"]).toBe("true"), {
      timeout: 10_000,
    });
  }
  it.each([
    ["applyTheme()", () => applyTheme("light")],
    ["attribute set directly", () => document.documentElement.setAttribute("data-theme", "light")],
  ])(
    "re-creates the chart with the new theme (%s)",
    async (_name, change) => {
      document.documentElement.setAttribute("data-theme", "dark");
      render(<ChartFrame title="Price" dataset={dataset(10)} />);
      await ready();
      expect(screen.getByTestId("chart-frame").dataset["themeName"]).toBe("dark");
      const before = screen.getByTestId("chart-canvas").querySelector("svg");
      change();
      await waitFor(() =>
        expect(screen.getByTestId("chart-frame").dataset["themeName"]).toBe("light"),
      );
      await ready();
      await waitFor(() => {
        const after = screen.getByTestId("chart-canvas").querySelector("svg");
        expect(after).not.toBeNull();
        expect(after).not.toBe(before);
      });
    },
    20_000,
  );
});

describe("ChartFrame behaviour", () => {
  it("legend toggles remove a series from the option and mark the button", async () => {
    render(<ChartFrame title="Price" dataset={dataset(10)} />);
    const btn = screen.getByTestId("legend-s1");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    const opt = buildOption(dataset(10), { theme: "dark", hidden: new Set(["s1"]) });
    expect((opt["series"] as unknown[]).length).toBe(1);
  });

  it("UI-16 second encoding: each series has its own marker shape and an end label", () => {
    expect(new Set(SERIES_SYMBOLS.map((_, i) => seriesSymbol(i))).size).toBe(SERIES_SYMBOLS.length);
    const opt = buildOption(dataset(10, 3), { theme: "dark" });
    const series = opt["series"] as Array<{ symbol: string; endLabel: { show: boolean } }>;
    expect(new Set(series.map((s) => s.symbol)).size).toBe(3);
    expect(series.every((s) => s.endLabel.show)).toBe(true);
    expect((opt["aria"] as { decal: { show: boolean } }).decal.show).toBe(true);
  });

  it("UI-16 forecast series are dashed", () => {
    const d = dataset(5, 1);
    const first = d.series[0];
    if (!first) throw new Error("fixture");
    const opt = buildOption({ ...d, series: [{ ...first, forecast: true }] }, { theme: "dark" });
    const s = (opt["series"] as Array<{ lineStyle: { type: string } }>)[0];
    expect(s?.lineStyle.type).toBe("dashed");
  });

  it("tooltip escapes dynamic text", () => {
    const d = dataset(2, 1);
    const first = d.series[0];
    if (!first) throw new Error("fixture");
    const opt = buildOption(
      { ...d, series: [{ ...first, name: "<img src=x onerror=alert(1)>" }] },
      { theme: "dark" },
    );
    const f = (opt["tooltip"] as { formatter: (p: unknown) => string }).formatter;
    const html = f([{ axisValueLabel: "<b>d</b>", dataIndex: 0, seriesId: "s0" }]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });

  it("range chips report the choice", async () => {
    const onChange = vi.fn();
    render(
      <ChartFrame
        title="Price"
        dataset={dataset(5)}
        ranges={{ options: ["1M", "1Y"], value: "1M", onChange }}
      />,
    );
    await userEvent.click(screen.getByTestId("range-1Y"));
    expect(onChange).toHaveBeenCalledWith("1Y");
    expect(screen.getByTestId("range-1M").getAttribute("aria-pressed")).toBe("true");
  });

  it("CSV export writes the dataset with the injection guard", async () => {
    const spy = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
    const d = dataset(2, 1);
    render(<ChartFrame title="Price" dataset={{ ...d, x: ["=evil", "2025-01-02"] }} />);
    await userEvent.click(screen.getByTestId("chart-export-csv"));
    expect(spy).toHaveBeenCalledTimes(1);
    const text = spy.mock.calls[0]?.[0] ?? "";
    expect(text).toContain("'=evil");
    expect(text.split("\r\n")[0]).toBe("Date,Series 0 (INR)");
  });

  it.each(["loading", "empty", "error", "partial", "stale"] as const)(
    "state %s renders",
    (state) => {
      render(
        <ChartFrame
          title="Price"
          dataset={dataset(5)}
          state={state}
          message="Note"
          onRetry={() => {}}
        />,
      );
      expect(screen.getByTestId("chart-frame").dataset["state"]).toBe(state);
      expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
    },
  );

  it("shows source and as-of, and flags stale in words", () => {
    render(<ChartFrame title="Price" dataset={dataset(5)} state="stale" />);
    expect(screen.getByTestId("source-chip").textContent).toContain("Test source");
    expect(screen.getByTestId("asof-chip").textContent).toContain("(stale)");
  });
});
