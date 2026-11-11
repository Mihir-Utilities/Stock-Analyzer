import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs generator without type declarations
import { buildDefinitions, ENTRIES, SPEC_PATH } from "../../scripts/gen-definitions.mjs";
import { AnalysisTab } from "@/components/stock/chart/AnalysisTab";
import { DashboardView } from "@/components/dashboard/DashboardView";
import { SeasonalityCard } from "@/components/dashboard/SeasonalityCard";
import { Heatmap } from "@/components/ui/Heatmap";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { rankSeasonality } from "@/lib/dashboard/seasonality";
import type { SeasonStock } from "@/lib/dashboard/schemas";
import { definitions } from "@/lib/definitions";
import { formatMonthName, formatMonthYear } from "@/lib/format";
import { parseInvBlocks } from "@/lib/stock/inv-schemas";
import type { Load } from "@/lib/stock/load";
import type { IndicatorsData } from "@/lib/stock/schemas";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import {
  indicatorsWithInv,
  seasonalityList,
  seasonalityMany,
  seasonalityRoute,
} from "../mocks/inv-fixtures";
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

const web = process.cwd();
const read = (p: string) => readFileSync(join(web, p), "utf8");
const CARDS = [
  "position",
  "vol",
  "drawdown",
  "holding",
  "entry",
  "sip",
  "risk",
  "context",
] as const;

beforeAll(async () => {
  await Promise.all([
    import("@/components/stock/chart/InvCards"),
    import("@/components/dashboard/SeasonalityCard"),
  ]);
}, 60_000);

// The fixture world is 2024-02-15 IST (VM1): the running month is February 2024.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-02-15T10:00:00+05:30"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function dataOf(patch?: (a: Record<string, unknown>) => Record<string, unknown>): IndicatorsData {
  return (indicatorsWithInv(patch).body as { data: IndicatorsData }).data;
}
const ready = (data: IndicatorsData, stale = false): Load<IndicatorsData> => ({
  state: "ready",
  data,
  asOf: "2024-02-15",
  stale,
});

async function renderTab(load: Load<IndicatorsData> = ready(dataOf())) {
  const r = render(<AnalysisTab indicatorsLoad={load} />);
  if (load.state === "ready") await screen.findByTestId("inv-position");
  return r;
}

// ---- schemas: per-block and per-field degradation (INV-U05, INV-U06) -----------------------------

describe("INV schemas degrade per block and per field", () => {
  it("a missing block is 'missing', a wrong-shaped block is 'error', neighbours are unaffected", () => {
    const a = dataOf().analysis as Record<string, unknown>;
    const blocks = parseInvBlocks({ ...a, vol_regime: "oops", position: undefined });
    expect(blocks.vol.kind).toBe("error");
    expect(blocks.position.kind).toBe("missing");
    expect(blocks.drawdown.kind).toBe("ok");
    expect(blocks.sip.kind).toBe("ok");
    expect(parseInvBlocks(undefined).seasonality.kind).toBe("missing");
  });

  it("a bad scalar becomes null (never 0, NaN or Infinity) and does not blank the block", () => {
    const a = dataOf().analysis as Record<string, unknown>;
    const pos = { ...(a["position"] as object), range_pos_52w_pct: "high", pctile_52w: Infinity };
    const blocks = parseInvBlocks({ ...a, position: pos });
    expect(blocks.position.kind).toBe("ok");
    if (blocks.position.kind === "ok") {
      expect(blocks.position.value.range_pos_52w_pct).toBeNull();
      expect(blocks.position.value.pctile_52w).toBeNull();
      expect(blocks.position.value.pctile_all).toBe(50);
    }
  });

  it("a malformed row inside a table is dropped, the other rows stay", () => {
    const a = dataOf().analysis as Record<string, unknown>;
    const hp = a["holding_periods"] as { windows: unknown[] };
    const blocks = parseInvBlocks({
      ...a,
      holding_periods: { ...hp, windows: [...hp.windows, 42] },
    });
    expect(blocks.holding.kind === "ok" && blocks.holding.value.windows).toHaveLength(5);
  });
});

// ---- heatmap: Year column, summary rows, markers (INV-U01..U03, INV-M10) ------------------------

describe("monthly heatmap with the Year column and summary rows", () => {
  it("INV-U01: header 'Year (price return)', partial/YTD suffixes, every cell prints its value", async () => {
    await renderTab();
    const card = screen.getByTestId("heatmap-month-year");
    const head = within(card).getByTestId("heatmap-year-col");
    expect(head).toHaveTextContent("Year (price return)");
    expect(head).toHaveAttribute("title", "Price return, dividends excluded");
    const rows = Array.from(card.querySelectorAll("tbody tr"));
    const lastCell = (i: number) => rows[i]!.querySelector("td:last-child")!;
    expect(rows.map((r) => r.querySelector("th")?.textContent)).toEqual(["2022", "2023", "2024"]);
    expect(lastCell(0)).toHaveTextContent("+10.0%");
    expect(lastCell(0)).toHaveTextContent("partial");
    expect(lastCell(0)).toHaveTextContent("Only 1 months with a base");
    expect(lastCell(1)).toHaveTextContent("-2.0%");
    expect(lastCell(1).textContent).not.toMatch(/partial|YTD/);
    expect(lastCell(2)).toHaveTextContent("-1.0%");
    expect(lastCell(2)).toHaveTextContent("YTD");
  });

  it("INV-U02: summary rows in order, from seasonality, shares under 3 years show an em dash", async () => {
    await renderTab();
    const card = screen.getByTestId("heatmap-month-year");
    const rows = within(card).getByTestId("heatmap-summary").querySelectorAll("tr");
    expect(Array.from(rows).map((r) => r.querySelector("th")?.textContent)).toEqual([
      "Average",
      "Median",
      "% of years green",
      "Best",
      "Worst",
      "Years",
    ]);
    const cells = (key: string) =>
      Array.from(within(card).getByTestId(`heat-summary-row-${key}`).querySelectorAll("td")).map(
        (c) => c.textContent ?? "",
      );
    expect(cells("green")[0]).toContain("50%"); // January: 2 of 4
    expect(cells("green")[1]).toContain("—"); // February: 2 years, share hidden
    expect(cells("green")[1]).toContain("fewer than 3 years");
    expect(cells("green")[12]).toContain("75%"); // Year column summary
    expect(cells("best")[0]).toContain("+5.0% (2019)");
    expect(cells("worst")[0]).toContain("-2.0% (2020)");
    expect(cells("avg")[12]).toContain("+7.0%");
    expect(cells("years")[0]).toBe("4");
    expect(cells("years")[12]).toBe("4");
    // February has fewer than the minimum years: its statistics carry the small sample marker.
    expect(cells("avg")[1]).toContain("small sample");
    const note = within(card).getByTestId("heatmap-footnote").textContent ?? "";
    expect(note).toContain("Based on 4.9 years of data from Mar 2019.");
    expect(note).toContain("The running month and the partial first year are not counted.");
    expect(note).toContain("Past behaviour is not a forecast.");
    expect(note).toContain("Rows show the last 3 years; the summary uses all 6.");
    expect(within(card).getByTestId("heatmap-best-worst")).toHaveTextContent(
      "March: median +2.0% (3 years)",
    );
    expect(within(card).getByTestId("heatmap-best-worst")).toHaveTextContent(
      "January: median +1.5% (4 years)",
    );
  });

  it("INV-U03: the running month is outlined and suffixed MTD as text with its tooltip", async () => {
    await renderTab();
    const card = screen.getByTestId("heatmap-month-year");
    const feb2024 = card.querySelectorAll("tbody tr")[2]!.querySelectorAll("td")[1]!;
    expect(feb2024).toHaveTextContent("-10.0%");
    expect(feb2024).toHaveTextContent("MTD");
    expect(feb2024.className).toMatch(/ring-2/);
    expect(feb2024.querySelector("[title]")).toHaveAttribute(
      "title",
      "Month still running; not counted below",
    );
    // No other cell is outlined: the running month is counted nowhere.
    expect(card.querySelectorAll("td.ring-2")).toHaveLength(1);
  });

  it("empty cells by reason are readable text, not only a tooltip", async () => {
    await renderTab();
    const card = screen.getByTestId("heatmap-month-year");
    expect(within(card).getByTestId("heatmap-empty-reasons")).toHaveTextContent(
      "the month before has no price; this month's prices stop before its last trading day",
    );
    const empty = card.querySelector('td[data-empty="true"]')!;
    expect(empty).toHaveTextContent("No value: the month before has no price");
  });

  it("Show data lists the Year column and every summary value; no NaN, Infinity or zero filler", async () => {
    const user = userEvent.setup();
    await renderTab();
    const card = screen.getByTestId("heatmap-month-year");
    await user.click(within(card).getByTestId("heat-show-data"));
    const table = within(card).getByTestId("heat-data-table");
    expect(table.textContent).toContain("Year (price return)");
    expect(table.textContent).toContain("% of years green");
    expect(table.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("older snapshots (no INV blocks) keep the plain grid: no Year column, no summary", async () => {
    const data = dataOf((a) => {
      const { year_returns, seasonality, month_year_reasons, ...rest } = a;
      void year_returns;
      void seasonality;
      void month_year_reasons;
      return rest;
    });
    await renderTab(ready(data));
    const card = screen.getByTestId("heatmap-month-year");
    expect(within(card).queryByTestId("heatmap-year-col")).toBeNull();
    expect(within(card).queryByTestId("heatmap-summary")).toBeNull();
    expect(within(card).getAllByTestId("heat-cell").length).toBeGreaterThan(0);
  });

  it("existing callers are unchanged: n/a with the reason as tooltip, no extra columns", () => {
    render(
      <Heatmap
        label="Grid"
        rows={["2025"]}
        columns={["Jan", "Feb"]}
        cells={[
          [
            { value: 1.5, text: "+1.5%" },
            { value: null, text: null },
          ],
        ]}
        maxAbs={2}
        legend={{ negative: "-2%", positive: "+2%" }}
        nullReason="No month-end close"
      />,
    );
    const cells = screen.getAllByTestId("heat-cell");
    expect(cells).toHaveLength(2);
    expect(cells[1]).toHaveTextContent("n/a");
    expect(cells[1]).toHaveAttribute("title", "No month-end close");
    expect(screen.queryByTestId("heat-summary")).toBeNull();
    expect(screen.getByRole("region", { name: "Grid, scrollable" })).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it("INV-M10: the Year label never says 'total return' without 'excludes dividends'", () => {
    const files = [
      "src/components/stock/chart/AnalysisTab.tsx",
      "src/components/stock/chart/InvCards.tsx",
      "src/lib/stock/inv-model.ts",
    ].map(read);
    const texts = [
      ...files,
      ...Object.entries(definitions)
        .filter(([k]) => !k.startsWith("mf_"))
        .map(([, d]) => d.text),
    ];
    for (const t of texts) {
      for (const m of t.matchAll(/total return/gi)) {
        expect(t.slice(Math.max(0, m.index - 80), m.index + 120)).toMatch(/excludes dividends/i);
      }
    }
    expect(definitions.year_price_return.text).toMatch(/dividends you received are not included/);
  });
});

// ---- Analysis cards (INV-U04..U07, INV-C01..C04, H03, E07, L06, R05) ------------------------------

describe("Analysis cards: shared parts, states and wording", () => {
  it("INV-U04: every card has source and as-of chips, a sample size, How to read and the fixed line", async () => {
    await renderTab();
    for (const c of CARDS) {
      const card = screen.getByTestId(`inv-${c}`);
      expect(within(card).getByTestId("source-chip")).toHaveTextContent(
        "Your imported prices, price return, excludes dividends",
      );
      expect(within(card).getByTestId("asof-chip")).toHaveTextContent("15 Feb 2024");
      expect(within(card).getByTestId(`inv-${c}-sample`).textContent?.length).toBeGreaterThan(5);
      const howto = within(card).getByTestId(`inv-${c}-howto`);
      expect(howto.tagName).toBe("DETAILS");
      expect(howto).not.toHaveAttribute("open");
      expect(
        within(card).getByTestId(c === "context" ? "inv-context-past-note" : `inv-${c}-note`),
      ).toHaveTextContent("Past behaviour is not a forecast.");
    }
    expect(screen.getByTestId("inv-position-sample")).toHaveTextContent(
      "Based on 700 daily closes",
    );
    expect(screen.getByTestId("inv-entry-small")).toHaveTextContent("Small sample");
  });

  it("INV-U05: loading, not computed, partial, stale and error render; one bad card does not blank the tab", async () => {
    const { unmount } = await renderTab();
    unmount();

    // loading
    render(<AnalysisTab indicatorsLoad={{ state: "loading" }} />);
    await screen.findByTestId("inv-position");
    for (const c of CARDS)
      expect(screen.getByTestId(`inv-${c}`)).toHaveAttribute("data-state", "loading");
    document.body.innerHTML = "";

    // error with a request id and Retry
    const retry = vi.fn();
    const err = render(
      <AnalysisTab
        indicatorsLoad={{ state: "error", message: "Boom", requestId: "req-9", retry }}
      />,
    );
    await screen.findByTestId("inv-position");
    const card = screen.getByTestId("inv-position");
    expect(card).toHaveAttribute("data-state", "error");
    expect(card).toHaveTextContent("Request id: req-9");
    await userEvent.click(within(card).getByTestId("card-retry"));
    expect(retry).toHaveBeenCalled();
    err.unmount();

    // not computed (older snapshot), partial, error in one block only
    const data = dataOf((a) => {
      const { position, ...rest } = a;
      void position;
      return {
        ...rest,
        vol_regime: "oops",
        risk_adjusted: {
          ...(a["risk_adjusted"] as object),
          calmar_3y: null,
          calmar_3y_reason: "insufficient_history",
        },
      };
    });
    render(<AnalysisTab indicatorsLoad={ready(data)} />);
    await screen.findByTestId("inv-position");
    expect(screen.getByTestId("inv-position")).toHaveAttribute("data-state", "empty");
    expect(screen.getByTestId("inv-position")).toHaveTextContent(
      "Not computed yet. It will appear after the next price import.",
    );
    expect(screen.getByTestId("inv-vol")).toHaveAttribute("data-state", "error");
    expect(screen.getByTestId("inv-drawdown")).toHaveAttribute("data-state", "ready");
    expect(screen.getByTestId("inv-risk")).toHaveAttribute("data-state", "partial");
    expect(screen.getByTestId("inv-risk")).toHaveTextContent("not enough price history");
    // the rest of the tab still draws
    expect(screen.getByTestId("heatmap-month-year")).toHaveAttribute("data-state", "ready");
  });

  it("INV-U05: a block older than the expected trading date shows a stale as-of chip", async () => {
    vi.setSystemTime(new Date("2024-03-20T20:00:00+05:30"));
    await renderTab();
    expect(within(screen.getByTestId("inv-position")).getByTestId("asof-chip")).toHaveTextContent(
      "(stale)",
    );
  });

  it("INV-C01: the strip shows four facts in the fixed order, each with its own as-of, no combined figure", async () => {
    await renderTab();
    const strip = screen.getByTestId("inv-context");
    const facts = Array.from(strip.querySelectorAll('[data-testid^="inv-context-fact-"]'));
    expect(facts.map((f) => f.getAttribute("data-testid"))).toEqual([
      "inv-context-fact-position",
      "inv-context-fact-drawdown",
      "inv-context-fact-volatility",
      "inv-context-fact-month",
    ]);
    for (const f of facts) expect(f).toHaveTextContent("As of 15 Feb 2024");
    expect(facts[0]).toHaveTextContent("Trading in the upper third of its 52-week range");
    expect(facts[1]).toHaveTextContent("4.5% below its highest close (18 Oct 2021)");
    expect(facts[2]).toHaveTextContent(
      "Recent price swings are typical for this stock (percentile 58)",
    );
    expect(facts[3]).toHaveTextContent("February closed green in 2 of 2 years");
    // neutral: no icon in the facts, no red/green fill classes
    for (const f of facts) {
      expect(f.querySelector("svg")).toBeNull();
      expect(f.className).not.toMatch(/bg-up|bg-down|text-up|text-down/);
    }
    expect(strip.textContent).not.toMatch(/\bscore\b|overall/i);
  });

  it("INV-C02: neutral wording for the bands; the only use of the word 'signal' is the negative sentence", async () => {
    const lower = dataOf((a) => ({
      ...a,
      position: { ...(a["position"] as object), range_band: "lower", range_pos_52w_pct: 10 },
      vol_regime: { ...(a["vol_regime"] as object), band: "higher" },
    }));
    await renderTab(ready(lower));
    const strip = screen.getByTestId("inv-context");
    expect(strip).toHaveTextContent("lower third of its 52-week range");
    expect(strip).toHaveTextContent("bigger than usual for this stock");
    expect(screen.getByTestId("inv-context-note")).toHaveTextContent(
      "Context, not advice or a signal.",
    );
    const verdict = /\b(buy|sell|cheap|expensive|bullish|bearish|target|score|rank)\b/i;
    const tab = screen.getByTestId("analysis-tab").textContent ?? "";
    expect(tab).not.toMatch(verdict);
    expect(tab.replace("Context, not advice or a signal.", "")).not.toMatch(/\bsignal\b/i);

    // The same words are absent from the source of the new components (comments included).
    const files = [
      "src/components/stock/chart/InvCards.tsx",
      "src/components/dashboard/SeasonalityCard.tsx",
      "src/lib/stock/inv-model.ts",
      "src/lib/dashboard/seasonality.ts",
    ].map((f) =>
      read(f)
        .replace(/touch-target/g, "")
        .replace(/\be\.target\b/g, "")
        .replace("Context, not advice or a signal.", ""),
    );
    for (const t of files)
      expect(t).not.toMatch(/\b(buy|sell|cheap|expensive|bullish|bearish|signal)\b/i);
    for (const t of files.slice(0, 1)) expect(t).not.toMatch(/\btarget\b/i);
  });

  it("INV-C03: one null fact still shows the other three, with an em dash and its reason", async () => {
    const data = dataOf((a) => ({
      ...a,
      position: {
        ...(a["position"] as object),
        range_pos_52w_pct: null,
        range_band: null,
        range_pos_52w_reason: "flat_range",
      },
    }));
    await renderTab(ready(data));
    const pos = screen.getByTestId("inv-context-fact-position");
    expect(pos).toHaveTextContent("—");
    expect(pos).toHaveTextContent("the price did not move over the range");
    expect(screen.getByTestId("inv-context-fact-drawdown")).toHaveTextContent(
      "below its highest close",
    );
    expect(screen.getByTestId("inv-context-fact-volatility")).toHaveTextContent("typical");
    expect(screen.getByTestId("inv-context-fact-month")).toHaveTextContent("closed green");
  });

  it("INV-C04: the strip uses the IST current month; month so far is separate and not in the share", async () => {
    await renderTab();
    const month = screen.getByTestId("inv-context-fact-month");
    expect(month).toHaveTextContent("February closed green in 2 of 2 years");
    expect(within(month).getByTestId("inv-context-mtd")).toHaveTextContent(
      "February so far: -10.0% (month to date; not in the count)",
    );
    // At 00:00 IST on 1 March the strip switches to March with no data change.
    document.body.innerHTML = "";
    vi.setSystemTime(new Date("2024-03-01T00:00:00+05:30"));
    await renderTab();
    expect(screen.getByTestId("inv-context-fact-month")).toHaveTextContent(
      "March closed green in 2 of 3 years",
    );
    expect(screen.getByTestId("inv-context-fact-month")).not.toHaveTextContent("so far");
  });

  it("INV-U06: no card renders a score, rank or target; null reasons are visible text", async () => {
    await renderTab();
    const text = CARDS.map((c) => screen.getByTestId(`inv-${c}`).textContent ?? "").join(" ");
    expect(text).not.toMatch(/\b(score|rank|ranking|target|sharpe|risk-free)\b/i);
    expect(text).not.toMatch(/NaN|Infinity|undefined|\bnull\b/);
    expect(screen.getByTestId("inv-holding-reasons")).toHaveTextContent(
      "3 years: not enough price history",
    );
    expect(screen.getByTestId("inv-drawdown-reasons")).toHaveTextContent(
      "10% fall: only 2 recovered episodes; at least 3 are needed",
    );
    expect(screen.getByTestId("inv-entry-reasons")).toHaveTextContent("only 1 past episodes");
  });

  it("INV-R05: the risk card shows Calmar and downside risk, never Sharpe or a risk-free rate", async () => {
    await renderTab();
    const risk = screen.getByTestId("inv-risk");
    expect(risk).toHaveTextContent("Calmar");
    expect(risk).toHaveTextContent("0.50");
    expect(risk).toHaveTextContent("35.5%");
    expect(risk.textContent).not.toMatch(/sharpe|risk-free/i);
    expect(read("src/components/stock/chart/InvCards.tsx")).not.toMatch(/sharpe_3y/);
  });

  it("INV-H03: the holding card prints that windows overlap and the independent periods", async () => {
    await renderTab();
    expect(screen.getByTestId("inv-holding-overlap")).toHaveTextContent(
      "Windows overlap, so 448 windows are fewer independent experiences than the count suggests. Returns are totals over the holding period, not per year.",
    );
    expect(screen.getByTestId("inv-holding-row-1y")).toHaveTextContent("2");
    expect(screen.getByTestId("inv-holding-table").querySelectorAll("tbody tr")).toHaveLength(5);
  });

  it("INV-E07: fewer than 10 episodes print the anecdote sentence as text, and pending is explained", async () => {
    await renderTab();
    const list = screen.getByTestId("inv-entry-anecdote");
    expect(list).toHaveTextContent(
      "Only 3 past episodes. This is an anecdote about this stock, not a pattern.",
    );
    expect(list.textContent).not.toContain("Only 12 past episodes");
    expect(screen.getByTestId("inv-entry-pending")).toHaveTextContent(
      "1 recent episodes have not completed the window yet.",
    );
    // the comparison column: all days median next to the conditional one
    expect(screen.getByTestId("inv-entry-row-10")).toHaveTextContent("-5.0%");
  });

  it("INV-L06: the replay banner is shown and the words 'return you will get' never are", async () => {
    await renderTab();
    expect(screen.getByTestId("inv-sip-banner")).toHaveTextContent(
      "A replay of the past with hindsight, not an estimate of the future.",
    );
    expect(screen.getByTestId("inv-sip").textContent).not.toMatch(/return you will get/i);
    expect(screen.getByTestId("inv-sip")).toHaveTextContent("per ₹1,000 a month");
  });

  it("INV-U07: the SIP day selector switches stored variants without a request and announces the result", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no request expected")));
    vi.stubGlobal("fetch", fetchSpy);
    await renderTab();
    const select = screen.getByTestId("inv-sip-day") as HTMLSelectElement;
    expect(select.options).toHaveLength(29);
    expect(select.options[0]).toHaveTextContent("First trading day");
    expect(screen.getByTestId("inv-sip-ratio")).toHaveTextContent("1.05x the lump sum");
    select.focus();
    expect(document.activeElement).toBe(select);
    await user.selectOptions(select, "5");
    expect(screen.getByTestId("inv-sip-ratio")).toHaveTextContent("1.10x the lump sum");
    expect(screen.getByTestId("inv-sip-live")).toHaveTextContent(
      "Day 5: Monthly plan ended at 1.10x the lump sum.",
    );
    expect(screen.getByTestId("inv-sip-live")).toHaveAttribute("aria-live", "polite");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("SIP variants under 12 instalments hide every figure and say why", async () => {
    const data = dataOf((a) => {
      const s = a["sip_backtest"] as { variants: Array<Record<string, unknown>> };
      return {
        ...a,
        sip_backtest: {
          ...s,
          variants: s.variants.map((v) => ({
            day: v["day"],
            installments: 9,
            reason: "history_under_12_months",
          })),
        },
      };
    });
    await renderTab(ready(data));
    expect(screen.getByTestId("inv-sip-hidden")).toHaveTextContent(
      "fewer than 12 monthly instalments",
    );
    expect(screen.getByTestId("inv-sip-table").textContent).not.toMatch(/₹|0\.00%|NaN/);
  });
});

// ---- definitions (INV-U09) -------------------------------------------------------------------------

describe("INV-U09 definitions", () => {
  const KEYS = [
    "year_price_return",
    "month_green_share",
    "price_position",
    "drawdown_profile",
    "holding_period",
    "entry_study",
    "vol_regime",
    "sip_vs_lump",
    "calmar",
    "downside_risk",
  ] as const;

  it("the ten owner-text keys exist, are generated (not stale) and name no ids or section numbers", () => {
    const spec = readFileSync(SPEC_PATH as string, "utf8");
    expect(read("src/lib/definitions.ts").replace(/\r\n/g, "\n")).toBe(buildDefinitions(spec));
    expect((ENTRIES as unknown[][]).map((e) => e[0])).toEqual(expect.arrayContaining([...KEYS]));
    for (const k of KEYS) {
      const t = definitions[k].text;
      expect(t.length).toBeGreaterThan(30);
      expect(t).not.toMatch(
        /\bINV\b|INV-\d|\bsection\b|\d+\.\d+\.\d+|docs\/|\b[a-z]+_[a-z_]+\b|\*\*|`/,
      );
    }
  });

  it("the tooltip prints no spec section number for these keys", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DefinitionTip term="calmar" />);
    await user.click(screen.getByTestId("definition-calmar"));
    const panel = screen.getByTestId("definition-calmar-panel");
    expect(panel).toHaveTextContent("Yearly price growth over the last 3 years");
    expect(panel.textContent).not.toMatch(/section|analytics spec/i);
  });
});

// ---- Home tile (INV-T01..T05, T08) -----------------------------------------------------------------

function mountTile(routes: Record<string, Handler>, ui: ReactNode = <SeasonalityCard />) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
const rowOrder = () =>
  Array.from(document.querySelectorAll('a[data-testid^="dash-seasonality-row-"]')).map((a) =>
    a.getAttribute("data-testid")!.replace("dash-seasonality-row-", ""),
  );

describe("Home tile: This month, across the years", () => {
  beforeEach(() => {
    // The tile's fixtures are November 2026; only the stale chip depends on the clock.
    vi.setSystemTime(new Date("2026-11-11T12:00:00+05:30"));
  });

  it("INV-T01: default order is share, then years, then symbol; sort and minimum years move rows", async () => {
    const user = userEvent.setup();
    mountTile({ "GET /stocks/seasonality": seasonalityRoute });
    await screen.findByTestId("dash-seasonality-list");
    expect(rowOrder()).toEqual(["BBB", "CCC", "AAA"]);
    expect(screen.getByTestId("dash-seasonality-month")).toHaveTextContent("November");
    const th = screen.getByRole("columnheader", { name: /Stock, years November ended higher/ });
    expect(th).toHaveAttribute("aria-sort", "descending");

    await user.selectOptions(screen.getByTestId("dash-seasonality-sort"), "years");
    expect(rowOrder()).toEqual(["BBB", "AAA", "CCC"]);
    await user.selectOptions(screen.getByTestId("dash-seasonality-sort"), "symbol");
    expect(rowOrder()).toEqual(["AAA", "BBB", "CCC"]);
    expect(
      screen.getByRole("columnheader", { name: /Stock, years November ended higher/ }),
    ).toHaveAttribute("aria-sort", "ascending");
    await user.selectOptions(screen.getByTestId("dash-seasonality-sort"), "mtd");
    expect(rowOrder()).toEqual(["AAA", "BBB", "CCC"]); // CCC has no month so far: last

    await user.selectOptions(screen.getByTestId("dash-seasonality-min-years"), "5");
    expect(rowOrder()).toEqual(["AAA", "BBB"]);
    expect(screen.getByTestId("dash-seasonality-short")).toHaveTextContent(
      "Not enough years yet (3)",
    );
    expect(screen.getByTestId("dash-seasonality-short-row-CCC")).toHaveTextContent(
      "4 years of this month so far; at least 5 are needed",
    );
    await user.selectOptions(screen.getByTestId("dash-seasonality-min-years"), "8");
    expect(rowOrder()).toEqual(["BBB"]);
    expect(screen.getByTestId("dash-seasonality-live")).toHaveTextContent("1 stocks shown");
  });

  it("ranking ties: equal share goes to more years, then to the symbol", () => {
    const mk = (symbol: string, pct: number, n: number): SeasonStock => ({
      symbol,
      name: symbol,
      seasonality: {
        month: 11,
        month_name: "November",
        as_of: "2026-11-10",
        data_since: "2019-01-01",
        years_of_history: 7,
        n_years: n,
        n_green: Math.round((pct / 100) * n),
        green_pct: pct,
        green_pct_reason: null,
        small_sample: n < 5,
        min_years: 3,
        avg_pct: 1,
        median_pct: 1,
        mtd_return_pct: null,
        mtd_reason: "no_bar_this_month",
        mtd_as_of: null,
      },
    });
    const { ranked } = rankSeasonality(
      [mk("ZED", 50, 4), mk("ABC", 50, 4), mk("MID", 50, 8), mk("TOP", 80, 5)],
      "share",
      3,
    );
    expect(ranked.map((r) => r.stock.symbol)).toEqual(["TOP", "MID", "ABC", "ZED"]);
  });

  it("INV-T02: the main line and the sub-line use the history start, never 'since listing'", async () => {
    mountTile({ "GET /stocks/seasonality": seasonalityRoute });
    await screen.findByTestId("dash-seasonality-list");
    expect(screen.getByTestId("dash-seasonality-main-AAA")).toHaveTextContent(
      "4 of 6 years green (67%)",
    );
    const row = screen.getByTestId("dash-seasonality-row-AAA");
    expect(row).toHaveTextContent("6 years of this month, history starts Mar 2019");
    expect(row).toHaveAttribute("href", "/stocks/AAA?tab=analysis");
    expect(screen.getByTestId("dash-seasonality").textContent).not.toMatch(/since listing/i);
    expect(screen.getByTestId("dash-seasonality")).toHaveTextContent(
      "History starts at your first imported price, which may be later than the listing date",
    );
  });

  it("INV-T03: month to date is shown separately with sign and arrow, or an em dash with the reason", async () => {
    mountTile({ "GET /stocks/seasonality": seasonalityRoute });
    await screen.findByTestId("dash-seasonality-list");
    const aaa = screen.getByTestId("dash-seasonality-mtd-AAA");
    expect(aaa).toHaveTextContent("November so far:");
    expect(aaa).toHaveTextContent("+1.23% (as of 10 Nov 2026)");
    expect(aaa.querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("dash-seasonality-mtd-BBB")).toHaveTextContent("-2.50%");
    expect(screen.getByTestId("dash-seasonality-mtd-CCC")).toHaveTextContent(
      "— (no price bar yet this month)",
    );
    // never inside the share
    expect(screen.getByTestId("dash-seasonality-main-AAA").textContent).not.toMatch(/1\.23/);
  });

  it("INV-T05: fewer than 5 years shows the Small sample chip and the rough-guide sentence", async () => {
    mountTile({ "GET /stocks/seasonality": seasonalityRoute });
    await screen.findByTestId("dash-seasonality-list");
    const ccc = screen.getByTestId("dash-seasonality-row-CCC");
    expect(within(ccc).getByTestId("dash-seasonality-small-CCC")).toHaveTextContent("Small sample");
    expect(ccc).toHaveTextContent("Only 4 years: a rough guide");
    expect(screen.getByTestId("dash-seasonality-row-AAA").textContent).not.toMatch(/Small sample/);
  });

  it("INV-T08: the footnote is always present; stocks without enough years are in the collapsed group with reasons", async () => {
    mountTile({ "GET /stocks/seasonality": seasonalityRoute });
    await screen.findByTestId("dash-seasonality-list");
    expect(screen.getByTestId("dash-seasonality-note")).toHaveTextContent(
      "Past behaviour is not a forecast. Counts only closed past months from your imported prices (price change, dividends excluded).",
    );
    const group = screen.getByTestId("dash-seasonality-short");
    expect(group.tagName).toBe("DETAILS");
    expect(group).not.toHaveAttribute("open");
    expect(group).toHaveTextContent("Not enough years yet (2)");
    expect(screen.getByTestId("dash-seasonality-short-row-DDD")).toHaveTextContent(
      "2 years of this month so far; at least 3 are needed",
    );
    expect(screen.getByTestId("dash-seasonality-short-row-EEE")).toHaveTextContent(
      "No prices imported",
    );
    const tile = screen.getByTestId("dash-seasonality").textContent ?? "";
    expect(tile).not.toMatch(/NaN|Infinity|undefined/);
    expect(tile).not.toMatch(/\b(buy|sell|target|score)\b/i);
  });

  it("INV-T04: loading, empty, nothing ranked, partial, stale and error each render with their copy", async () => {
    // loading
    const pending = mountTile({
      "GET /stocks/seasonality": () => new Promise(() => undefined) as never,
    });
    expect(screen.getByTestId("dash-seasonality")).toHaveAttribute("data-state", "loading");
    pending.unmount();
    vi.unstubAllGlobals();

    // empty: no tracked stocks
    const empty = mountTile({
      "GET /stocks/seasonality": {
        status: 200,
        body: {
          data: { month: 11, month_name: "November", as_of: null, scope: "all", stocks: [] },
          meta: {},
          warnings: [],
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("dash-seasonality")).toHaveAttribute("data-state", "empty"),
    );
    expect(screen.getByTestId("dash-seasonality")).toHaveTextContent(
      "No stocks are tracked yet. Import prices for a stock to see how this month has behaved in past years.",
    );
    expect(screen.getByTestId("dash-seasonality-browse")).toHaveAttribute("href", "/stocks");
    empty.unmount();
    vi.unstubAllGlobals();

    // nothing ranked: every stock is short; the group is still listed
    const body = seasonalityList().body as { data: { stocks: unknown[] } };
    const short = {
      status: 200,
      body: { ...body, data: { ...body.data, stocks: body.data.stocks.slice(3) } },
    };
    const none = mountTile({ "GET /stocks/seasonality": short });
    await screen.findByTestId("dash-seasonality-none");
    expect(screen.getByTestId("dash-seasonality-none")).toHaveTextContent(
      "No tracked stock has 3 years of this month yet. Import more price history.",
    );
    expect(screen.getByTestId("dash-seasonality-short")).toHaveTextContent(
      "Not enough years yet (2)",
    );
    // partial: EEE has no snapshot
    expect(screen.getByTestId("dash-seasonality")).toHaveAttribute("data-state", "partial");
    none.unmount();
    vi.unstubAllGlobals();

    // stale: an old snapshot gets the amber stale chip, and the share is still shown
    const stale = JSON.parse(JSON.stringify(seasonalityList())) as {
      body: { data: { stocks: Array<{ seasonality: { as_of: string } | null }> } };
    };
    for (const s of stale.body.data.stocks) if (s.seasonality) s.seasonality.as_of = "2026-09-01";
    (stale.body.data as unknown as { as_of: string }).as_of = "2026-09-01";
    const st = mountTile({ "GET /stocks/seasonality": stale as never });
    await screen.findByTestId("dash-seasonality-list");
    expect(
      within(screen.getByTestId("dash-seasonality")).getByTestId("asof-chip"),
    ).toHaveTextContent("(stale)");
    expect(screen.getByTestId("dash-seasonality-main-AAA")).toHaveTextContent("4 of 6");
    st.unmount();
    vi.unstubAllGlobals();

    // error: message + Retry; the tile failing leaves the Dashboard standing
    mountTile(
      {
        "GET /stocks/seasonality": {
          status: 500,
          body: { error: { code: "INTERNAL", message: "x", request_id: "req-77" } },
        },
      },
      <DashboardView />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("dash-seasonality")).toHaveAttribute("data-state", "error"),
    );
    expect(screen.getByTestId("dashboard-title")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("dash-seasonality")).getByTestId("card-retry"),
    ).toBeInTheDocument();
  });

  it("INV-T06 (unit part): the controls are labelled native selects reachable by keyboard", async () => {
    const user = userEvent.setup();
    mountTile({ "GET /stocks/seasonality": seasonalityRoute });
    await screen.findByTestId("dash-seasonality-list");
    await user.tab();
    const sort = screen.getByLabelText("Sort");
    const min = screen.getByLabelText("Minimum years");
    expect(sort.tagName).toBe("SELECT");
    expect(min.tagName).toBe("SELECT");
    let guard = 0;
    while (document.activeElement !== sort && guard++ < 30) await user.tab();
    expect(document.activeElement).toBe(sort);
    await user.tab();
    expect(document.activeElement).toBe(min);
    expect(screen.getByTestId("dash-seasonality-live")).toHaveAttribute("aria-live", "polite");
  });

  it("INVA-11/12: All stocks is the default; the scope control is a radio group that refetches with the scope", async () => {
    const user = userEvent.setup();
    const mock = createMockFetch({ "GET /stocks/seasonality": seasonalityRoute });
    vi.stubGlobal("fetch", mock.impl);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SeasonalityCard />
      </QueryClientProvider>,
    );
    await screen.findByTestId("dash-seasonality-list");
    expect(mock.calls.at(-1)!.query.get("scope")).toBe("all");
    const group = screen.getByRole("radiogroup", { name: "Stocks to show" });
    const all = within(group).getByTestId("dash-seasonality-scope-all");
    const wl = within(group).getByTestId("dash-seasonality-scope-watchlist");
    expect(all).toHaveAttribute("aria-checked", "true");
    expect(wl).toHaveAttribute("aria-checked", "false");
    expect(all).toHaveAttribute("tabindex", "0");
    expect(wl).toHaveAttribute("tabindex", "-1");
    expect(rowOrder()).toEqual(["BBB", "CCC", "AAA"]);
    // INVA-12: the chip (text and icon) marks watchlisted stocks in All mode only
    expect(screen.getByTestId("dash-seasonality-watch-AAA")).toHaveTextContent("Watchlist");
    expect(screen.getByTestId("dash-seasonality-watch-CCC")).toBeInTheDocument();
    expect(screen.queryByTestId("dash-seasonality-watch-BBB")).toBeNull();

    all.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(mock.calls.at(-1)!.query.get("scope")).toBe("watchlist"));
    await waitFor(() => expect(rowOrder()).toEqual(["CCC", "AAA"]));
    expect(wl).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(wl);
    expect(screen.queryByTestId("dash-seasonality-watch-AAA")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("dash-seasonality-live")).toHaveTextContent("2 stocks shown"),
    );
    await user.keyboard("{Home}");
    await waitFor(() => expect(rowOrder()).toEqual(["BBB", "CCC", "AAA"]));
    expect(screen.getByTestId("dash-seasonality-scope")).toHaveAttribute("data-scope", "all");
  });

  it("INVA-13: the empty copy and the caption follow the scope; the switch stays reachable when empty", async () => {
    const user = userEvent.setup();
    const emptyWatch = {
      status: 200,
      body: {
        data: { month: 11, month_name: "November", as_of: null, scope: "watchlist", stocks: [] },
        meta: {},
        warnings: [],
      },
    };
    mountTile({
      "GET /stocks/seasonality": (c) =>
        c.query.get("scope") === "watchlist" ? emptyWatch : seasonalityList(),
    });
    await screen.findByTestId("dash-seasonality-list");
    expect(screen.getByRole("table")).toHaveTextContent(
      "Tracked stocks by how often November ended higher in past years",
    );
    await user.click(screen.getByTestId("dash-seasonality-scope-watchlist"));
    await waitFor(() =>
      expect(screen.getByTestId("dash-seasonality")).toHaveAttribute("data-state", "empty"),
    );
    expect(screen.getByTestId("dash-seasonality")).toHaveTextContent(
      "Add stocks to your watchlist to see how this month has behaved in past years.",
    );
    // the control is still there to go back
    await user.click(screen.getByTestId("dash-seasonality-scope-all"));
    await screen.findByTestId("dash-seasonality-list");
  });

  it("INVA-14 (unit part): 48 tracked stocks rank, sort, filter and group; the footnote stays", async () => {
    const user = userEvent.setup();
    mountTile({ "GET /stocks/seasonality": seasonalityMany(48) });
    await screen.findByTestId("dash-seasonality-list");
    const total = () =>
      rowOrder().length +
      document.querySelectorAll('[data-testid^="dash-seasonality-short-row-"]').length;
    expect(total()).toBe(48);
    await user.selectOptions(screen.getByTestId("dash-seasonality-sort"), "symbol");
    expect(rowOrder().slice(0, 2)).toEqual(["S000", "S001"]);
    await user.selectOptions(screen.getByTestId("dash-seasonality-min-years"), "8");
    expect(screen.getByTestId("dash-seasonality-short")).toBeInTheDocument();
    expect(total()).toBe(48);
    expect(screen.getByTestId("dash-seasonality-note")).toBeInTheDocument();
  });

  it("INVA: a wrong-typed on_watchlist degrades to no chip; the row still renders", async () => {
    const body = seasonalityList().body as { data: { stocks: Array<Record<string, unknown>> } };
    body.data.stocks[0]!.on_watchlist = "yes";
    mountTile({ "GET /stocks/seasonality": { status: 200, body } });
    await screen.findByTestId("dash-seasonality-list");
    expect(screen.getByTestId("dash-seasonality-row-AAA")).toBeInTheDocument();
    expect(screen.queryByTestId("dash-seasonality-watch-AAA")).toBeNull();
  });

  it("format helpers: month names and Mon YYYY come from format.ts and are unknown-safe", () => {
    expect(formatMonthName(11).text).toBe("November");
    expect(formatMonthName(13).text).toBe("—");
    expect(formatMonthYear("2019-03-01").text).toBe("Mar 2019");
    expect(formatMonthYear(null).reason).not.toBeNull();
  });
});
