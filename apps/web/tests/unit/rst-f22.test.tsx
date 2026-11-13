import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs generator without type declarations
import { buildDefinitions, ENTRIES, SPEC_PATH } from "../../scripts/gen-definitions.mjs";
import { AnalysisTab } from "@/components/stock/chart/AnalysisTab";
import { RelativeStrengthCard } from "@/components/stock/chart/RelativeStrengthCard";
import { definitions } from "@/lib/definitions";
import {
  peerCountText,
  percentileText,
  ppText,
  ratioPlan,
  windowLabel,
  windowReasons,
  yearLabel,
} from "@/lib/stock/rst-model";
import { parseRelativeStrength } from "@/lib/stock/rst-schemas";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";
import { indicatorsWithInv } from "../mocks/inv-fixtures";
import { drawdownPairs, relativeStrength, vsIndex, vsPeers } from "../mocks/rst-fixtures";
import "./dom-matchers";

vi.setConfig({ testTimeout: 30_000 });
const echart = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("@/components/charts/EChart", () => ({
  EChart: ({ label, option }: { label: string; option: unknown }) => {
    echart.options.push(option);
    return <div role="img" aria-label={label} data-testid="chart-canvas" data-ready="true" />;
  },
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const N = 40;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-02-15T10:00:00+05:30"));
});
afterEach(() => vi.useRealTimers());

const READY: Load<IndicatorsData> = {
  state: "ready",
  data: {} as IndicatorsData,
  asOf: "2024-02-15",
  stale: false,
};
const analysisOf = (rs: unknown) => ({ drawdown: drawdownPairs(N), relative_strength: rs });
const renderCard = (rs: unknown, load: Load<IndicatorsData> = READY) =>
  render(<RelativeStrengthCard load={load} analysis={analysisOf(rs)} />);

describe("RST-C01 the card renders both halves", () => {
  it("shows windows, years, chart, beat share, alignment, peers, source, sample and the note", () => {
    renderCard(relativeStrength(N));
    const card = screen.getByTestId("inv-rs");
    expect(within(card).getByRole("heading", { name: /Relative strength/ })).toBeInTheDocument();
    expect(screen.getByTestId("inv-rs-source")).toHaveTextContent(/imported NIFTY50/);
    expect(screen.getByTestId("inv-rs-source")).toHaveTextContent(/15 Feb 2024/);
    const win = within(screen.getByTestId("inv-rs-windows"));
    expect(win.getByTestId("inv-rs-window-1m")).toHaveTextContent("-4.0 pp");
    expect(win.getByTestId("inv-rs-window-3m")).toHaveTextContent("+4.0 pp");
    expect(screen.getByTestId("inv-rs-year-2023")).toHaveTextContent("-7.4 pp");
    expect(screen.getByTestId("inv-rs-year-2024")).toHaveTextContent("year to date");
    expect(screen.getByTestId("inv-rs-chart")).toBeInTheDocument();
    expect(screen.getByTestId("inv-rs-chart-summary")).toHaveTextContent(/moved from 100 to/);
    expect(screen.getByTestId("inv-rs-beat")).toHaveTextContent(
      "In 61.8% of 76 past one-year periods the stock beat the index (median difference +3.2 pp).",
    );
    expect(screen.getByTestId("inv-rs-beat-overlap")).toHaveTextContent(
      "These windows overlap: 76 windows are about 1 independent one-year periods.",
    );
    expect(screen.getByTestId("inv-rs-aligned")).toHaveTextContent(
      "38 dates present in both your stock and your NIFTY50 prices",
    );
    expect(screen.getByTestId("inv-rs-aligned")).toHaveTextContent(
      "2 stock dates and 3 index dates were present in only one series and were left out.",
    );
    expect(screen.getByTestId("inv-rs-note")).toHaveTextContent(
      "Beating the index in the past is not a forecast.",
    );
    expect(screen.getByTestId("inv-rs-note")).toHaveTextContent("Price return only");
    expect(screen.getByTestId("inv-rs-sample")).toHaveTextContent(/38 dates in common/);
  });

  it("the peer strip shows rank of N, percentile, return, median and the stale-rank note", () => {
    renderCard(relativeStrength(N));
    const t3 = screen.getByTestId("inv-rs-peer-3m");
    expect(t3).toHaveTextContent("Rank 2 of 6");
    expect(t3).toHaveTextContent("75th percentile among your tracked Banks stocks");
    expect(t3).toHaveTextContent("peer median +1.9%");
    expect(t3).toHaveTextContent("difference +2.3 pp");
    expect(screen.getByTestId("inv-rs-peer-note")).toHaveTextContent(
      "Peer ranks are as of 15 Feb 2024; they update when this stock is recomputed.",
    );
    expect(screen.getByTestId("inv-rs-peer-note")).toHaveTextContent(
      "1 same-sector stocks were left out",
    );
    expect(screen.getByTestId("inv-rs-peer-note")).toHaveTextContent(
      /sector index is not available/,
    );
  });
});

describe("RST-C02 no index", () => {
  it("shows the owner hint and the Import Center link, no numbers, and keeps the peers half", async () => {
    renderCard(relativeStrength(N, { vs_index: null, vs_index_reason: "no_index_series" }));
    const box = screen.getByTestId("inv-rs-no-index");
    expect(box).toHaveTextContent("Import NIFTY50 history in prices.csv (the reserved symbol)");
    const link = within(box).getByTestId("inv-rs-import-link");
    expect(link).toHaveAttribute("href", "/imports");
    await userEvent.tab(); // reachable by keyboard: it is a plain link in the tab order
    expect(screen.queryByTestId("inv-rs-windows")).toBeNull();
    expect(screen.queryByTestId("inv-rs-chart")).toBeNull();
    expect(screen.getByTestId("inv-rs-peers")).toBeInTheDocument();
  });
});

describe("RST-C03 peers hidden and compute errors", () => {
  it("fewer than 3 peers never shows a rank", () => {
    renderCard(relativeStrength(N));
    const t = screen.getByTestId("inv-rs-peer-1y");
    expect(t).toHaveTextContent(
      "Needs at least 3 peers (you track 2 other Banks stocks with data)",
    );
    expect(screen.queryByTestId("inv-rs-peer-1y-rank")).toBeNull();
    expect(t.textContent).not.toMatch(/Rank/);
  });

  it("no_sector shows its sentence and link; the index half still renders", () => {
    renderCard(relativeStrength(N, { vs_peers: null, vs_peers_reason: "no_sector" }));
    expect(screen.getByTestId("inv-rs-no-sector")).toHaveTextContent(
      "Add a sector for this stock to compare it with your other tracked stocks.",
    );
    expect(screen.getByTestId("inv-rs-sector-link")).toHaveAttribute("href", "/imports");
    expect(screen.getByTestId("inv-rs-windows")).toBeInTheDocument();
  });

  it("compute_error on one half is stated with its reason; the other half renders", () => {
    renderCard(relativeStrength(N, { vs_index: null, vs_index_reason: "compute_error" }));
    expect(screen.getByTestId("inv-rs-index-error")).toHaveTextContent(
      "Not shown: could not be computed for this stock.",
    );
    expect(screen.getByTestId("inv-rs-peer-3m")).toBeInTheDocument();
  });

  it("window reasons are visible text, not hover only", () => {
    renderCard(relativeStrength(N));
    expect(screen.getByTestId("inv-rs-reasons")).toHaveTextContent(
      "12 months (252 trading days): fewer dates in common with the index than this period needs",
    );
    expect(screen.getByTestId("inv-rs-window-1y")).toHaveTextContent("—");
  });

  it("too few one-year periods and short overlap explain themselves", () => {
    const rolling = (reason: string, windows: number) => ({
      windows,
      independent_periods: 0,
      share_beat_pct: null,
      median_excess_pp: null,
      small_sample: false,
      reason,
    });
    const { unmount } = renderCard(
      relativeStrength(N, {
        vs_index: vsIndex(N, { rolling_year: rolling("too_few_windows", 4) }),
      }),
    );
    expect(screen.getByTestId("inv-rs-beat-reason")).toHaveTextContent(
      "Only 4 one-year periods; at least 20 are needed.",
    );
    unmount();
    renderCard(
      relativeStrength(N, {
        vs_index: vsIndex(N, { rolling_year: rolling("insufficient_overlap", 0) }),
      }),
    );
    expect(screen.getByTestId("inv-rs-beat-reason")).toHaveTextContent(
      "Needs at least a year of dates in common with the index.",
    );
    expect(screen.queryByTestId("inv-rs-beat-overlap")).toBeNull();
  });
});

describe("RST-C04 small sample and stale", () => {
  it("shows the chips for few peers and few independent periods", () => {
    renderCard(relativeStrength(N));
    expect(screen.getByTestId("inv-rs-small")).toBeInTheDocument();
    expect(screen.getByTestId("inv-rs-peer-3m-small")).toBeInTheDocument();
    expect(screen.queryByTestId("inv-rs-peer-6m-small")).toBeNull();
    expect(screen.queryByTestId("inv-rs-peer-1y-small")).toBeNull(); // hidden tile: no chip
  });

  it("no small-sample chip when the sample is not small", () => {
    renderCard(
      relativeStrength(N, {
        vs_index: vsIndex(N, {
          rolling_year: {
            windows: 700,
            independent_periods: 5,
            share_beat_pct: 55,
            median_excess_pp: 1,
            small_sample: false,
            reason: null,
          },
        }),
        vs_peers: vsPeers({
          windows: [
            {
              key: "3m",
              rows: 63,
              stock_pct: 1,
              n_peers: 9,
              n_total: 10,
              rank: 4,
              percentile: 66,
              peer_median_pct: 0.5,
              vs_median_pp: 0.5,
              small_sample: false,
              reason: null,
            },
          ],
        }),
      }),
    );
    expect(screen.queryByTestId("inv-rs-small")).toBeNull();
  });

  it("an old as-of marks the card stale", () => {
    renderCard(relativeStrength(N, { as_of: "2024-01-02" }));
    expect(screen.getByTestId("inv-rs").textContent).toMatch(/stale/i);
  });
});

describe("RST-C05 missing and wrong-shaped data", () => {
  it("a missing block says not computed yet", () => {
    render(<RelativeStrengthCard load={READY} analysis={{ drawdown: drawdownPairs(N) }} />);
    expect(screen.getByTestId("inv-rs")).toHaveTextContent(
      "Not computed yet. It will appear after the next price import.",
    );
  });

  it("a block of the wrong type fails alone; a bad field degrades to a dash and never throws", () => {
    const { unmount } = renderCard("oops");
    expect(screen.getByTestId("inv-rs")).toHaveTextContent(/unexpected shape/);
    unmount();
    const rs = relativeStrength(N) as unknown as { vs_index: Record<string, unknown> };
    const first = (rs.vs_index["windows"] as Array<Record<string, unknown>>)[0]!;
    rs.vs_index["windows"] = [{ ...first, excess_pp: "big" }, 42];
    rs.vs_index["years"] = "none";
    renderCard(rs);
    expect(screen.getByTestId("inv-rs-window-1m")).toHaveTextContent("—");
    expect(screen.queryByTestId("inv-rs-years")).toBeNull();
    expect(screen.getByTestId("inv-rs-peers")).toBeInTheDocument();
    expect(screen.getByTestId("inv-rs").textContent).not.toMatch(/NaN|Infinity/);
  });

  it("a half of the wrong shape says so instead of showing zeros", () => {
    renderCard(relativeStrength(N, { vs_peers: "bad" as never }));
    expect(screen.getByTestId("inv-rs-peers-error")).toHaveTextContent(/unexpected shape/);
  });

  it("a ratio line whose length does not match the dates is not drawn", () => {
    render(
      <RelativeStrengthCard
        load={READY}
        analysis={{ drawdown: drawdownPairs(N - 5), relative_strength: relativeStrength(N) }}
      />,
    );
    expect(screen.queryByTestId("inv-rs-chart")).toBeNull();
    expect(screen.getByTestId("inv-rs-chart-none")).toHaveTextContent(
      /chart dates are not available/,
    );
  });

  it("loading, error and unavailable states", async () => {
    const { unmount } = renderCard(relativeStrength(N), {
      state: "loading",
    } as Load<IndicatorsData>);
    expect(screen.getByTestId("inv-rs")).toBeInTheDocument();
    unmount();
    const retry = vi.fn();
    render(
      <RelativeStrengthCard
        load={
          { state: "error", message: "boom", requestId: "req-1", retry } as Load<IndicatorsData>
        }
        analysis={undefined}
      />,
    );
    expect(screen.getByTestId("inv-rs")).toHaveTextContent("boom Request id: req-1.");
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalled();
  });
});

describe("RST-C06 honesty and conventions", () => {
  it("has no verdict wording, no unknown rendered as a number and no ad-hoc colours", () => {
    renderCard(relativeStrength(N));
    const text = screen.getByTestId("inv-rs").textContent ?? "";
    expect(text).not.toMatch(/\b(buy|sell|outperform|underperform|strong|weak|target)\b/i);
    expect(text).not.toMatch(/NaN|Infinity|undefined|null/);
    const src = readFileSync(
      join(process.cwd(), "src/components/stock/chart/RelativeStrengthCard.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|text-(red|green)|bg-(red|green)/);
    expect(src).not.toMatch(/echarts/);
    expect(src).toMatch(/ChartFrame/);
  });

  it("formats through format.ts: signed points, ordinals and the ratio plan", () => {
    expect(ppText(-4)).toBe("-4.0 pp");
    expect(ppText(4)).toBe("+4.0 pp");
    expect(ppText(0)).toBe("0.0 pp");
    expect(ppText(null)).toBe("—");
    expect(percentileText(75)).toBe("75th percentile");
    expect(percentileText(37.5)).toBe("38th percentile");
    expect(percentileText(1)).toBe("1st percentile");
    expect(percentileText(22)).toBe("22nd percentile");
    expect(percentileText(103)).toBe("103rd percentile");
    expect(percentileText(11)).toBe("11th percentile");
    expect(percentileText(null)).toBe("—");
    const parsed = parseRelativeStrength(analysisOf(relativeStrength(N)));
    if (parsed.block.kind !== "ok" || !parsed.block.value.vs_index) throw new Error("fixture");
    const plan = ratioPlan(parsed.block.value.vs_index, parsed.dates, "2024-02-15");
    expect(plan.kind).toBe("chart");
    if (plan.kind === "chart") {
      expect(plan.dataset.series[0]?.values).toHaveLength(N);
      expect(plan.dataset.series[0]?.values.filter((v) => v === null).length).toBeGreaterThan(0);
      expect(plan.dataset.series[1]?.values.every((v) => v === null || v === 100)).toBe(true);
    }
  });

  it("the How to read disclosure is a native details and reasons are plain text", async () => {
    renderCard(relativeStrength(N));
    const how = screen.getByTestId("inv-rs-howto") as HTMLDetailsElement;
    expect(how.tagName).toBe("DETAILS");
    expect(how.open).toBe(false);
    await userEvent.click(within(how).getByText("How to read"));
    expect(how.open).toBe(true);
  });

  it("tables sit in labelled, focusable scroll regions", () => {
    renderCard(relativeStrength(N));
    const regions = screen.getAllByRole("region", { name: /scrollable/ });
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const r of regions) expect(r).toHaveAttribute("tabindex", "0");
  });
});

describe("RST-C07 definitions", () => {
  it("carries the four owner texts, generated from docs/05", () => {
    for (const k of ["relative_return", "relative_line", "beat_share", "peer_rank"] as const) {
      expect(definitions[k].text.length).toBeGreaterThan(40);
      expect(definitions[k].text).not.toMatch(/\*\*|`/);
    }
    expect(definitions.beat_share.text).toMatch(/not a forecast/);
    const spec = readFileSync(SPEC_PATH, "utf8");
    expect(ENTRIES.map((e: string[]) => e[0])).toEqual(
      expect.arrayContaining(["relative_return", "relative_line", "beat_share", "peer_rank"]),
    );
    const fresh = buildDefinitions(spec) as string;
    for (const k of ["relative_return", "relative_line", "beat_share", "peer_rank"]) {
      expect(fresh).toContain(`"${k}"`);
    }
  });
});

describe("the Analysis tab", () => {
  it("places the lazy card in the tab and reads the dates from the drawdown pairs", async () => {
    const reply = indicatorsWithInv((a) => {
      const n = (a["drawdown"] as unknown[]).length;
      return { ...a, relative_strength: relativeStrength(n) };
    });
    const data = (reply.body as { data: IndicatorsData }).data;
    render(<AnalysisTab indicatorsLoad={{ ...READY, data }} />);
    expect(await screen.findByTestId("inv-rs", {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.getByTestId("inv-rs-chart")).toBeInTheDocument();
    await screen.findByTestId("inv-holding", {}, { timeout: 20_000 });
    await screen.findByTestId("inv-entry", {}, { timeout: 20_000 });
    const order = screen
      .getAllByTestId(/^(inv-holding|inv-rs|inv-entry)$/)
      .map((e) => e.dataset["testid"]);
    expect(order).toEqual(["inv-holding", "inv-rs", "inv-entry"]);
  });

  it("an older snapshot without the block shows 'not computed yet' and the other cards stay", async () => {
    const reply = indicatorsWithInv();
    const data = (reply.body as { data: IndicatorsData }).data;
    render(<AnalysisTab indicatorsLoad={{ ...READY, data }} />);
    expect(await screen.findByTestId("inv-rs", {}, { timeout: 20_000 })).toHaveTextContent(
      "Not computed yet",
    );
    expect(await screen.findByTestId("inv-position")).toBeInTheDocument();
  });
});

describe("review fixes (S1, S3 to S7, N4, N7)", () => {
  it("S1: names the index end date and says when the index ends before the stock", () => {
    const short = vsIndex(N, { last_aligned: "2024-02-09", index_as_of: "2024-02-09" });
    renderCard(relativeStrength(N, { vs_index: short }));
    expect(screen.getByTestId("inv-rs-index")).toHaveTextContent(
      "Against the Nifty 50 (to 9 Feb 2024)",
    );
    expect(screen.getByTestId("inv-rs-index-ends")).toHaveTextContent(
      "Index data ends 9 Feb 2024; the stock data ends 15 Feb 2024.",
    );
    expect(screen.getByTestId("inv-rs-chart-summary")).toHaveTextContent(
      /to 9 Feb 2024 the ratio moved/,
    );
    expect(screen.getByTestId("inv-rs-aligned")).toHaveTextContent(
      "Your NIFTY50 series has 2,465 dates and ends 9 Feb 2024.",
    );
    expect(screen.getByTestId("inv-rs-peer-note")).toHaveTextContent(
      "the Nifty figures above run to 9 Feb 2024",
    );
  });

  it("S1: no 'index ends' line when both end together; a stale index marks the card stale", () => {
    const { unmount } = renderCard(relativeStrength(N));
    expect(screen.queryByTestId("inv-rs-index-ends")).toBeNull();
    expect(screen.getByTestId("inv-rs").textContent).not.toMatch(/stale/i);
    unmount();
    renderCard(relativeStrength(N, { vs_index: vsIndex(N, { index_as_of: "2024-01-02" }) }));
    expect(screen.getByTestId("inv-rs").textContent).toMatch(/stale/i);
  });

  it("S3: windows show their trading-day count and base date, in the same words as the peer tiles", () => {
    renderCard(relativeStrength(N));
    expect(screen.getByTestId("inv-rs-window-1m")).toHaveTextContent("1 month (21 trading days)");
    expect(screen.getByTestId("inv-rs-window-1m")).toHaveTextContent("12 Jan 2024");
    expect(screen.getByTestId("inv-rs-window-1y")).toHaveTextContent(
      "12 months (252 trading days)",
    );
    expect(screen.getByTestId("inv-rs-peer-3m")).toHaveTextContent("3 months (63 trading days)");
    expect(screen.getByTestId("inv-rs-peer-1y")).toHaveTextContent("12 months (252 trading days)");
    expect(windowLabel("zz", null)).toBe("zz");
  });

  it("S4: every year row shows its base-to-end dates; ytd only after a December base", () => {
    renderCard(relativeStrength(N));
    expect(screen.getByTestId("inv-rs-year-2023-span")).toHaveTextContent(
      "from 30 Dec 2022 to 29 Dec 2023",
    );
    expect(screen.getByTestId("inv-rs-year-2024")).toHaveTextContent("2024 (year to date)");
    expect(yearLabel({ year: 2024, kind: "ytd", base_date: "2023-11-30" })).toBe(
      "2024 (since 30 Nov 2023)",
    );
    expect(yearLabel({ year: 2023, kind: "full", base_date: "2022-12-30" })).toBe("2023");
  });

  it("S5 and N7: the peer note carries the survivor-bias sentence and the sector count", () => {
    renderCard(relativeStrength(N));
    const note = screen.getByTestId("inv-rs-peer-note");
    expect(note).toHaveTextContent(
      "Stocks you track today; delisted and untracked stocks are not included; the sector label is the one you entered.",
    );
    expect(note).toHaveTextContent("(6 share this label)");
    expect(note).toHaveTextContent("measured over its own trading days up to 15 Feb 2024");
    expect(definitions.peer_rank.text).toMatch(/delisted and untracked stocks are not included/);
  });

  it("S6: the reasons list is a pure function of the windows", () => {
    const parsed = parseRelativeStrength(analysisOf(relativeStrength(N)));
    if (parsed.block.kind !== "ok" || !parsed.block.value.vs_index) throw new Error("fixture");
    const v = parsed.block.value.vs_index;
    expect(windowReasons(v)).toEqual(windowReasons(v));
    expect(windowReasons(v)).toEqual([
      "12 months (252 trading days): fewer dates in common with the index than this period needs",
    ]);
  });

  it("N4: the sample line gives the smallest and largest peer count over the periods", () => {
    expect(
      peerCountText([
        { key: "3m", n_peers: 5 },
        { key: "1y", n_peers: 2 },
      ] as never),
    ).toBe("2 to 5 peers");
    expect(peerCountText([{ key: "3m", n_peers: 4 }] as never)).toBe("4 peers");
    expect(peerCountText([])).toBeNull();
    renderCard(relativeStrength(N));
    expect(screen.getByTestId("inv-rs-sample")).toHaveTextContent("2 to 5 peers");
  });

  it("S7: the chart draws the 100 baseline only where the ratio exists and never connects across gaps", () => {
    echart.options.length = 0;
    renderCard(relativeStrength(N));
    type Opt = {
      series: Array<{ name: string; data: Array<number | null>; connectNulls?: boolean }>;
    };
    const opts = echart.options as Opt[];
    const opt = opts[opts.length - 1]!;
    const ratio = opt.series.find((x) => x.name.startsWith("Stock divided"))!;
    const base = opt.series.find((x) => x.name.startsWith("100 ="))!;
    expect(ratio.data).toHaveLength(N);
    const nulls = ratio.data.flatMap((v, i) => (v === null ? [i] : []));
    expect(nulls).toEqual(Array.from({ length: N }, (_, i) => i).filter((i) => i % 17 === 5));
    expect(ratio.connectNulls).toBe(false);
    expect(base.connectNulls).toBe(false);
    expect(base.data.map((v) => v === null)).toEqual(ratio.data.map((v) => v === null));
    expect(base.data.every((v) => v === null || v === 100)).toBe(true);
  });

  it("S7: the web date mapping of REAL worker output lines up with the API pairs", () => {
    for (const name of ["real_120.json", "real_800.json"]) {
      const raw = JSON.parse(
        readFileSync(join(process.cwd(), "../../fixtures/relative_strength", name), "utf8"),
      ) as { series: { dates: string[] }; analysis: Record<string, unknown> };
      // the API replaces series.dates by [date, value] pairs (apps/api/internal/prices/expand.go)
      const dd = raw.analysis["drawdown"] as Array<number | null>;
      const pairs = dd.map((v, i) => [raw.series.dates[i], v]);
      const analysis = { ...raw.analysis, drawdown: pairs };
      const parsed = parseRelativeStrength(analysis);
      expect(parsed.dates).toEqual(raw.series.dates);
      if (parsed.block.kind !== "ok" || !parsed.block.value.vs_index) throw new Error(name);
      const v = parsed.block.value.vs_index;
      const plan = ratioPlan(v, parsed.dates, parsed.block.value.as_of ?? null);
      expect(plan.kind).toBe("chart");
      if (plan.kind === "chart") {
        expect(plan.dataset.series[0]?.values).toHaveLength(raw.series.dates.length);
        expect(plan.dataset.series[0]?.values.find((x) => x !== null)).toBe(100);
      }
      // a length that differs (one pair lost) is refused with a reason, never mis-aligned
      const short = parseRelativeStrength({ ...analysis, drawdown: pairs.slice(1) });
      expect(ratioPlan(v, short.dates, null).kind).toBe("none");
    }
  });
});
