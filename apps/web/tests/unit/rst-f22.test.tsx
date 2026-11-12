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
import { percentileText, ppText, ratioPlan } from "@/lib/stock/rst-model";
import { parseRelativeStrength } from "@/lib/stock/rst-schemas";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";
import { indicatorsWithInv } from "../mocks/inv-fixtures";
import { drawdownPairs, relativeStrength, vsIndex, vsPeers } from "../mocks/rst-fixtures";
import "./dom-matchers";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("@/components/charts/EChart", () => ({
  EChart: ({ label }: { label: string }) => (
    <div role="img" aria-label={label} data-testid="chart-canvas" data-ready="true" />
  ),
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
      "1 year: fewer dates in common with the index than this period needs",
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
