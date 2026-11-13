import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadBeforeAll } from "./preload";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";
import { RiskSection } from "@/components/portfolio/RiskSection";
import { getDefinition } from "@/lib/definitions";
import { readRisk } from "@/lib/portfolio/risk-schemas";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as pf from "../mocks/portfolio-fixtures";
import * as mfx from "../mocks/mf-portfolio-fixtures";
import * as rf from "../mocks/risk-fixtures";
import "./dom-matchers";

// F20: the Portfolio risk section (docs/06 6.7b). PRK-U01..U07. Synthetic data only.

vi.setConfig({ testTimeout: 30_000 });

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function mountSection(handler: Handler, view: "all" | "equity" | "mf" = "all") {
  const mock = createMockFetch({ "GET /portfolio/risk": handler });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RiskSection view={view} />
    </QueryClientProvider>,
  );
  return mock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());
preloadBeforeAll("portfolio");

const text = (id: string) => screen.getByTestId(id).textContent ?? "";
const reply = (data: unknown) =>
  pf.envelope(data, [], 200, { as_of: "2024-01-05T09:00:00Z", source: "mixed", stale: false });

describe("PRK-U01 the section in each state", () => {
  it("renders concentration, stress and history from the vectors C1, S1 and TW1", async () => {
    mountSection(reply(rf.risk("all")));
    await screen.findByTestId("pf-risk-body");
    expect(text("pf-risk-top1")).toContain("50.00%");
    expect(text("pf-risk-top3")).toContain("95.00%");
    expect(text("pf-risk-top5")).toContain("100.00%");
    expect(text("pf-risk-top5")).toContain("of 4 holdings");
    expect(text("pf-risk-effective")).toContain("2.7");
    expect(text("pf-risk-hhi")).toContain("0.365");
    expect(text("pf-risk-total")).toContain("10,000.00");
    // the weights table lists every holding; Unclassified is an ordinary visible row with its hint
    for (const k of ["A", "B", "C", "D"]) {
      expect(screen.getByTestId(`pf-risk-weight-row-${k}`)).toBeInTheDocument();
    }
    expect(text("pf-risk-weight-row-D")).toContain("Unclassified");
    expect(text("pf-risk-weight-row-D")).toContain("no sector imported for these holdings");
    expect(text("pf-risk-group-row-Unclassified")).toContain("5.00%");
    expect(text("pf-risk-group-summary")).toContain("80.00%");
    // stress: a what-if label and the vector S1 numbers
    expect(text("pf-risk-stress-label")).toContain("What if this one holding fell");
    const a = text("pf-risk-stress-row-A");
    expect(a).toContain("-₹500.00");
    expect(a).toContain("-5.00%");
    expect(a).toContain("-₹1,000.00");
    expect(a).toContain("-10.00%");
    // history: TW1, the raw value never falls but the return line falls 10%
    expect(text("pf-risk-current-dd")).toContain("-1.00%");
    expect(text("pf-risk-max-dd")).toContain("-10.00%");
    expect(text("pf-risk-max-dd")).toContain("not recovered yet");
    expect(text("pf-risk-underwater")).toContain("3");
    expect(text("pf-risk-twr")).toContain("+8.90%");
    expect(screen.getByTestId("pf-risk-index-chart")).toBeInTheDocument();
    expect(screen.getByTestId("pf-risk-drawdown-chart")).toBeInTheDocument();
    expect(screen.getByTestId("pf-risk-howto").tagName).toBe("DETAILS");
    expect(text("pf-risk-past-note")).toContain("Past behaviour is not a forecast.");
    expect(text("pf-risk-past-note")).toContain("not looked through"); // All view only
    expect(text("pf-risk-asof")).toContain("as of");
    expect(text("pf-risk")).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("an unpriced holding blanks every weight with a visible reason (never a partial total)", async () => {
    mountSection(reply(rf.risk("all", { concentration: rf.unpriced })));
    await screen.findByTestId("pf-risk-body");
    for (const id of ["pf-risk-top1", "pf-risk-top3", "pf-risk-top5", "pf-risk-effective"]) {
      expect(text(id)).toContain("—");
      expect(text(id)).toContain("D has no imported price yet");
    }
    expect(text("pf-risk-reason")).toContain("Weights unavailable: D has no imported price yet");
    expect(text("pf-risk-total")).toContain("unavailable");
    expect(text("pf-risk-hhi")).toContain("unavailable");
    // a priced holding still shows its own value; its share is a dash with the reason
    const b = text("pf-risk-weight-row-B");
    expect(b).toContain("3,000.00");
    expect(b).toContain("—");
    // the group holding the unpriced stock has no value either
    expect(text("pf-risk-group-row-Unclassified")).toContain("—");
    expect(text("pf-risk")).not.toMatch(/NaN|Infinity/);
  });

  it("lists the gaps and the skipped steps as visible text", async () => {
    mountSection(reply(rf.risk("all", { history: rf.historyWithGaps })));
    await screen.findByTestId("pf-risk-body");
    const gaps = text("pf-risk-gaps");
    expect(gaps).toContain("No value on 1 date");
    expect(gaps).toContain("C has no imported price yet");
    expect(gaps).toContain("No value on 6 dates");
    expect(gaps).toContain("the latest NAV of Fund One is more than 4 days old");
    expect(text("pf-risk-skipped")).toContain("1 price move could not be counted");
  });

  it("an empty portfolio says so and shows the reasons, never zeros", async () => {
    mountSection(
      reply(
        rf.risk("equity", {
          concentration: rf.emptyConcentration,
          stress: { ...rf.stress, items: [] },
          history: rf.historyEmpty,
        }),
      ),
      "equity",
    );
    await screen.findByTestId("pf-risk-body");
    expect(text("pf-risk-concentration")).toContain("Nothing to show yet");
    expect(text("pf-risk-stress")).toContain("Nothing to show yet");
    expect(text("pf-risk-series-reason")).toContain("there are no transactions in this view yet");
    expect(text("pf-risk-past-note")).not.toContain("not looked through"); // only in All
    expect(text("pf-risk")).not.toMatch(/NaN|Infinity/);
  });

  it("shows the error card with Retry when the request fails", async () => {
    const user = userEvent.setup();
    let n = 0;
    mountSection(() => {
      n += 1;
      return n === 1
        ? { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }
        : reply(rf.risk("all"));
    });
    const err = await screen.findByTestId("pf-risk-error");
    await user.click(within(err).getByTestId("card-retry"));
    await screen.findByTestId("pf-risk-body");
  });
});

describe("PRK-U02 per-field degradation", () => {
  it("a wrong-typed field becomes a dash; the other blocks still render", async () => {
    const bad = { ...rf.concentration, top1_pct: "fifty", hhi: { x: 1 } };
    mountSection(reply(rf.risk("all", { concentration: bad })));
    await screen.findByTestId("pf-risk-body");
    expect(text("pf-risk-top1")).toContain("—");
    expect(text("pf-risk-top3")).toContain("95.00%");
    expect(text("pf-risk-stress-row-A")).toContain("-₹500.00");
  });

  it("an unreadable block says so without crashing the section", async () => {
    mountSection(
      reply(
        rf.risk("all", { concentration: { ...rf.concentration, by_holding: "x" }, history: 5 }),
      ),
    );
    await screen.findByTestId("pf-risk-body");
    expect(text("pf-risk-concentration")).toContain("could not be read");
    expect(text("pf-risk-history")).toContain("could not be read");
    expect(screen.getByTestId("pf-risk-stress-row-A")).toBeInTheDocument();
  });

  it("readRisk drops unreadable rows and counts them", () => {
    const r = readRisk(
      rf.risk("all", { stress: { ...rf.stress, items: [...rf.stress.items, { nope: 1 }] } }),
    );
    expect(r.stress?.rows).toHaveLength(4);
    expect(r.stress?.bad).toBe(1);
    expect(readRisk(null).concentration).toBeNull();
    expect(readRisk({ concentration: 3 }).concentration).toBeNull();
  });
});

describe("PRK-U03 the page switcher drives the section", () => {
  it("sends the view explicitly, keeps the old answer while loading and announces the change", async () => {
    window.history.replaceState(null, "", "/portfolio?view=all");
    const user = userEvent.setup();
    const mock = createMockFetch({
      "GET /portfolio/summary": mfx.byView(),
      "GET /portfolio/txns": pf.envelope(pf.txns),
      "GET /portfolio/mf/txns": pf.envelope({ items: [mfx.mfTxn], next_cursor: null }),
      "GET /portfolio/mf/fund-mappings": pf.envelope({ items: [] }),
      "GET /portfolio/adjustments": pf.envelope(pf.adjustments),
      "GET /market/holidays": pf.envelope({ year_loaded: false, items: [] }),
      "GET /portfolio/risk": rf.riskByView(),
    });
    vi.stubGlobal("fetch", mock.impl);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PortfolioPage />
      </QueryClientProvider>,
    );
    await screen.findByTestId("pf-risk-body");
    expect(mock.calls.find((c) => c.path === "/portfolio/risk")?.query.get("view")).toBe("all");
    expect(screen.getByTestId("pf-risk")).toHaveAttribute("data-view", "all");
    await user.click(screen.getByTestId("pf-view-mf"));
    await waitFor(() =>
      expect(
        mock.calls.some((c) => c.path === "/portfolio/risk" && c.query.get("view") === "mf"),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("pf-risk")).toHaveAttribute("data-view", "mf"));
    await waitFor(() =>
      expect(text("pf-risk-live")).toContain("Portfolio risk updated for Mutual funds"),
    );
    // one switcher only: the section adds none
    expect(screen.getAllByTestId("pf-view-switcher")).toHaveLength(1);
  });
});

describe("PRK-S03 / PRK-U06 / PRK-U07 wording, definitions and tokens", () => {
  it("contains no verdict, advice or forecast wording", async () => {
    mountSection(reply(rf.risk("all")));
    await screen.findByTestId("pf-risk-body");
    const words =
      /\b(buy|sell|recommend\w*|should|you must|too concentrated|dangerous|risky|safe)\b/i;
    expect(text("pf-risk")).not.toMatch(words);
  });

  it("the five owner texts exist and carry no ids or section numbers", () => {
    for (const k of ["pf_concentration", "pf_hhi", "pf_stress", "pf_twr", "pf_drawdown"] as const) {
      const d = getDefinition(k);
      expect(d.text.length).toBeGreaterThan(40);
      expect(d.text).not.toMatch(/docs?\/|PRK|_pct|testid|\bsection\b/i);
    }
  });

  it("uses tokens, format.ts and ChartFrame only", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/portfolio/RiskSection.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // no ad-hoc colours
    expect(src).not.toMatch(/from "echarts|toFixed\(|toLocaleString|Intl\./);
    expect(src).toMatch(/ChartFrame/);
  });
});
