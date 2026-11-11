import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadBeforeAll } from "./preload";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";
import { PortfolioCard } from "@/components/dashboard/PortfolioCard";
import { MfTxnSection } from "@/components/portfolio/MfTxnSection";
import { ToastProvider } from "@/components/ui/overlays";
import { definitions } from "@/lib/definitions";
import { draftFromTxn, uneditableReason } from "@/lib/portfolio/mf-form";
import { mfHoldingSchema, readView, viewSummarySchema } from "@/lib/portfolio/mf-schemas";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as pf from "../mocks/portfolio-fixtures";
import * as fx from "../mocks/mf-portfolio-fixtures";
import "./dom-matchers";

// F16 review follow-ups (MFHW-*): the All view keeps stock sections stock-only, honest dashes and
// reasons, focus handling, estimates. Synthetic data only.

vi.setConfig({ testTimeout: 30_000 });

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

type Routes = Record<string, Handler>;

function setUrl(search: string) {
  window.history.replaceState(null, "", `/portfolio${search}`);
}

function mount(ui: React.ReactElement, routes: Routes = {}, wrap?: typeof fetch) {
  const mock = createMockFetch({
    "GET /portfolio/summary": fx.byView(),
    "GET /portfolio/txns": pf.envelope(pf.txns),
    "GET /portfolio/mf/txns": pf.envelope({ items: [fx.mfTxn], next_cursor: null }),
    "GET /portfolio/mf/fund-mappings": pf.envelope({ items: [] }),
    "GET /portfolio/adjustments": pf.envelope(pf.adjustments),
    "GET /market/holidays": pf.envelope({ year_loaded: false, items: [] }),
    ...routes,
  });
  vi.stubGlobal("fetch", wrap ?? mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return mock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  setUrl("");
});
afterEach(() => vi.unstubAllGlobals());

preloadBeforeAll("portfolio");

const text = (id: string) => screen.getByTestId(id).textContent ?? "";

/** The "all" summary with some totals changed (the combined totals the API sends for All). */
function allWith(
  totals: Record<string, unknown>,
  over: Record<string, unknown> = {},
  rows?: unknown[],
) {
  const base = fx.viewSummary("all", {}, rows);
  return fx.viewSummary("all", { totals: { ...base.totals, ...totals }, ...over }, rows);
}

async function chartRows(user: ReturnType<typeof userEvent.setup>, id: string): Promise<string> {
  const chart = await screen.findByTestId(id);
  await user.click(within(chart).getByTestId("chart-show-data"));
  return within(chart).getByTestId("chart-data-table").textContent ?? "";
}

describe("MFHW-01 All view: stock sections show only the stock sleeve", () => {
  it("the P&L breakdown chart and the realised sentence use the stock row, not the combined totals", async () => {
    const user = userEvent.setup();
    mount(<PortfolioPage />);
    const note = await screen.findByTestId("pf-ltp-note");
    // combined realised is 1,534.50 (stocks 1,234.50 + funds 300.00); the stock sentence says 1,234.50
    expect(note).toHaveTextContent("+₹1,234.50");
    expect(note.textContent).not.toContain("1,534.50");
    expect(note.textContent).toMatch(/stock totals/);
    const data = await chartRows(user, "pf-chart-breakdown");
    expect(data).toContain("5,000.00"); // stock unrealised (combined: 6,510.00)
    expect(data).toContain("1,234.50");
    expect(data).not.toContain("6,510");
    expect(data).not.toContain("1,534.50");
    expect(data).not.toContain("Total");
  });

  it("readView in All builds the stock totals from the breakdown row; Equity keeps the API totals", () => {
    const all = readView(viewSummarySchema.parse(fx.viewSummary("all")), "all");
    expect(all.legacy.totals.realized_pnl).toBe("1234.5000");
    expect(all.legacy.totals.unrealized_pnl).toBe("5000.0000");
    expect(all.legacy.totals.invested).toBe("45000.0000");
    const eq = readView(viewSummarySchema.parse(fx.viewSummary("equity")), "equity");
    expect(eq.legacy.totals.realized_pnl).toBe("1234.5000");
    // no stock row in the breakdown: unknown (null / empty), never the combined number
    const none = readView(viewSummarySchema.parse(fx.viewSummary("all", { breakdown: [] })), "all");
    expect(none.legacy.totals.unrealized_pnl).toBeNull();
    expect(none.legacy.totals.realized_pnl).toBe("");
  });
});

describe("MFHW-02 an unpriced fund does not blank the stock chart", () => {
  it("All with one MF without NAV: the stock P&L chart stays ready and the stock weights are not partial", async () => {
    const user = userEvent.setup();
    const base = fx.viewSummary("all");
    const breakdown = base.breakdown.map((r) =>
      r.asset_class === "mf"
        ? {
            ...r,
            market_value: null,
            market_value_reason: "missing_nav: Example Gamma Fund",
            unrealized_pnl: null,
          }
        : r,
    );
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": pf.envelope(
        allWith(
          {
            market_value: null,
            market_value_reason: "missing_nav: Example Gamma Fund",
            unrealized_pnl: null,
            unrealized_pct: null,
          },
          { breakdown, allocation_excludes_unpriced: true },
          [fx.alphaGrowth, fx.gammaNoNav],
        ),
      ),
    });
    const data = await chartRows(user, "pf-chart-breakdown");
    expect(data).toContain("5,000.00");
    expect(text("pf-chart-breakdown")).not.toMatch(/unknown until/);
    expect(text("pf-chart-sector")).not.toMatch(/without a price are left out/);
    expect(screen.getByTestId("pf-holdings")).not.toHaveTextContent(/Some holdings have no price/);
    // the fund side still says so, in the summary banner
    expect(screen.getByTestId("pf-unpriced-banner")).toHaveTextContent("Example Gamma Fund");
  });
});

describe("MFHW-03 no added-up total and no browser-computed Total", () => {
  it("the 'added up' line is gone even though total_pnl is parsed; the chart has no Total bar", async () => {
    const user = userEvent.setup();
    mount(<PortfolioPage />);
    await screen.findByTestId("pf-card-realized");
    expect(screen.queryByTestId("pf-card-total-pnl")).toBeNull();
    expect(document.body.textContent).not.toMatch(/added up/);
    expect(document.body.textContent).not.toContain("8,244.50"); // the API total_pnl of All
    const chart = await screen.findByTestId("pf-chart-breakdown");
    await user.click(within(chart).getByTestId("chart-show-data"));
    expect(within(chart).getAllByTestId("chart-data-row")).toHaveLength(2); // Unrealized, Realized
    expect(viewSummarySchema.parse(fx.viewSummary("all")).totals.total_pnl).toBe("8244.5000"); // still parsed
  });
});

describe("MFHW-04 definitions are owner text", () => {
  it("xirr_pooled, absolute_return and mf_total_return carry no ids, headings or spec numbers", () => {
    for (const k of ["xirr_pooled", "absolute_return", "mf_total_return"] as const) {
      const t = definitions[k].text;
      expect(t).not.toMatch(/MFH-\d|B15R|F16R|D-MF|docs\/|\bsection\b|\b8\.5|\b6\.7|\*\*|`/);
      expect(t).not.toMatch(/^\d/); // no spec heading such as "8.5.4 Cash flows"
      expect(t).not.toMatch(/:\s*$/); // no colon without content
      expect(t.length).toBeGreaterThan(40);
      expect(t.length).toBeLessThan(420);
    }
    // the maths text of docs/05 stays: only the owner marker lines are used
    const spec = readFileSync(join(process.cwd(), "../../docs/05-analytics-spec.md"), "utf8");
    expect(spec).toContain("8.5.4 Cash flows for XIRR (exact rules).");
  });
});

describe("MFHW-05 a missing absolute return is a dash with a generic reason", () => {
  const under = {
    returns: {
      xirr_pct: null,
      xirr_reason: "under_one_year",
      absolute_return_pct: null,
      absolute_return_basis: null,
      span_days: 200,
      first_flow_date: "2026-04-08",
    },
  };

  it("card: 'absolute return not available', the first-year sentence only in the note, span via format.ts", async () => {
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": pf.envelope(fx.viewSummary("all", under)),
    });
    const card = await screen.findByTestId("pf-card-absolute-return");
    expect(within(card).getByTestId("stat-null")).toHaveTextContent(
      "absolute return not available",
    );
    expect(within(card).getByTestId("stat-null")).not.toHaveTextContent(/after the first year/);
    expect(text("pf-card-absolute-return-note")).toContain("XIRR is shown after the first year");
    expect(text("pf-card-absolute-return-note")).toContain("200 days since 8 Apr 2026");
  });

  it("MF row: the dash reason is generic, the chip says under 1 year with its span and first transaction", async () => {
    setUrl("?view=mf");
    const row = { ...fx.betaIdcw, absolute_return_pct: null, first_txn_date: "2026-04-08" };
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": pf.envelope(fx.viewSummary("mf", {}, [fx.alphaGrowth, row])),
    });
    const tr = await screen.findByTestId("pf-mf-row-100002");
    const reasons = within(tr)
      .getAllByTestId("cell-reason")
      .map((n) => n.textContent ?? "");
    expect(reasons.some((t) => t.includes("absolute return not available"))).toBe(true);
    expect(reasons.some((t) => t.includes("after the first year"))).toBe(false);
    expect(within(tr).getByTestId("pf-mf-under-year-chip")).toHaveTextContent(
      "under 1 year: 200 days since 8 Apr 2026",
    );
  });

  it("dashboard card: the dash says not available, the definition keeps the first-year sentence", async () => {
    mount(<PortfolioCard />, {
      "GET /portfolio/summary": pf.envelope(fx.viewSummary("all", under)),
    });
    const stat = await screen.findByTestId("stat-null", {}, { timeout: 5000 });
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
    const nulls = screen.getAllByTestId("stat-null").map((n) => n.textContent ?? "");
    expect(nulls.some((t) => t.includes("absolute return not available"))).toBe(true);
    expect(nulls.some((t) => t.includes("after the first year"))).toBe(false);
    expect(stat).toBeInTheDocument();
  });
});

describe("MFHW-06 period_too_short keeps the XIRR label and shows its reason", () => {
  it("the reason is visible under the XIRR label; no absolute-return card replaces it", async () => {
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": pf.envelope(
        fx.viewSummary("all", {
          returns: {
            xirr_pct: null,
            xirr_reason: "period_too_short",
            absolute_return_pct: 1.5,
            absolute_return_basis: "simple, not annualised",
            span_days: 12,
            first_flow_date: "2026-10-12",
          },
        }),
      ),
    });
    const card = await screen.findByTestId("pf-card-xirr");
    expect(card).toHaveTextContent("XIRR");
    expect(within(card).getByTestId("stat-null")).toHaveTextContent(/under 30 days/);
    expect(within(card).getByTestId("stat-null")).toHaveTextContent(/Absolute return \+1\.50%/);
    expect(screen.queryByTestId("pf-card-absolute-return")).toBeNull();
  });
});

describe("MFHW-07 every null with a reason is reachable without a mouse", () => {
  it("Cell has hidden text for screen readers and the unpriced row shows its reason in plain sight", async () => {
    setUrl("?view=mf");
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": pf.envelope(
        fx.viewSummary("mf", {}, [fx.alphaGrowth, fx.gammaNoNav]),
      ),
    });
    const tr = await screen.findByTestId("pf-mf-row-100003");
    const unknown = within(tr).getAllByTestId("cell-unknown")[0]!;
    expect(unknown.firstElementChild).toHaveAttribute("aria-hidden", "true"); // the dash itself
    const hidden = within(unknown).getByTestId("cell-reason");
    expect(hidden.className).toContain("sr-only");
    expect(hidden.textContent).toMatch(/^Not available: /);
    // plus a visible line (not a tooltip) under the dash
    expect(within(tr).getByTestId("pf-mf-nav-reason")).toHaveTextContent(
      "No NAV for this fund yet",
    );
    expect(within(tr).getByTestId("pf-mf-nav-reason").className).not.toContain("sr-only");
  });
});

describe("MFHW-08 the .xlsx sentence appears only after the server says so", () => {
  // The import wizard side is in mf-import.test.tsx (MFHW-S10); here the lib rule.
  it("a 422 with the xlsx text is matched, the same text on another status or another 422 is not", async () => {
    const { ApiError } = await import("@/lib/api/client");
    const { describeMfError, isXlsxNotEnabled } = await import("@/lib/imports/mf");
    expect(
      isXlsxNotEnabled(new ApiError("UNPROCESSABLE", "xlsx not enabled: save as CSV", 422)),
    ).toBe(true);
    expect(isXlsxNotEnabled(new ApiError("INTERNAL", "xlsx not enabled", 500))).toBe(false);
    expect(isXlsxNotEnabled(new ApiError("UNPROCESSABLE", "the file has too many rows", 422))).toBe(
      false,
    );
    expect(describeMfError(new ApiError("INTERNAL", "xlsx not enabled", 500))).not.toMatch(
      /Excel files are not enabled/,
    );
  });
});

describe("MFHW-09 dashboard All shows the date of each part of the day change", () => {
  it("lists Stocks (close) and Mutual funds (NAV) with their own as-of dates", async () => {
    const base = fx.viewSummary("all");
    const breakdown = base.breakdown.map((r) =>
      r.asset_class === "mf" ? { ...r, as_of: "2026-10-22" } : r,
    );
    mount(<PortfolioCard />, {
      "GET /portfolio/summary": pf.envelope(fx.viewSummary("all", { breakdown })),
    });
    const line = await screen.findByTestId("dash-day-parts");
    expect(line).toHaveTextContent("Stocks (close) as of 23 Oct 2026");
    expect(line).toHaveTextContent("Mutual funds (NAV) as of 22 Oct 2026");
  });
});

describe("MFHW-10 switching views never labels old data with the new view", () => {
  it("while the next view loads: dimmed body, 'Updating Mutual funds...' in a polite status, old data label", async () => {
    const user = userEvent.setup();
    const inner = createMockFetch({
      "GET /portfolio/summary": fx.byView({ all: { ...fx.viewSummary("all"), view: undefined } }),
      "GET /portfolio/txns": pf.envelope(pf.txns),
      "GET /portfolio/mf/txns": pf.envelope({ items: [], next_cursor: null }),
      "GET /portfolio/adjustments": pf.envelope(pf.adjustments),
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("view=mf")) await gate;
      return inner.impl(input, init);
    }) as typeof fetch;
    mount(<PortfolioPage />, {}, wrapped);
    await screen.findByTestId("pf-card-xirr");
    const status = screen.getByTestId("pf-updating");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toBe("");
    await user.click(screen.getByTestId("pf-view-mf"));
    expect(screen.getByTestId("pf-updating")).toHaveTextContent("Updating Mutual funds...");
    const body = screen.getByTestId("pf-view-body");
    expect(body).toHaveAttribute("aria-busy", "true");
    expect(body.className).toContain("opacity-60");
    // the answer carried no `view` field at all: it is still labelled with the view it was asked for
    expect(body).toHaveAttribute("data-view", "all");
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByTestId("pf-view-body")).toHaveAttribute("data-view", "mf"),
    );
    expect(screen.getByTestId("pf-updating").textContent).toBe("");
    expect(screen.getByTestId("pf-view-body")).toHaveAttribute("aria-busy", "false");
  });
});

describe("MFHW-14 breakdown", () => {
  it("N13: a stale row says so and keeps its real reason text", async () => {
    const base = fx.viewSummary("all");
    const breakdown = base.breakdown.map((r) =>
      r.asset_class === "mf"
        ? { ...r, stale: true, as_of: "2026-10-15", xirr_pct: null, xirr_reason: "no_sign_change" }
        : r,
    );
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": pf.envelope(fx.viewSummary("all", { breakdown })),
    });
    const row = await screen.findByTestId("pf-breakdown-row-mf");
    expect(within(row).getByTestId("pf-breakdown-stale-mf")).toHaveTextContent("stale");
    expect(row).toHaveTextContent("15 Oct 2026");
    expect(within(row).getByTestId("cell-reason")).toHaveTextContent(/no sign change/);
    expect(
      within(screen.getByTestId("pf-breakdown-row-equity")).queryByTestId(
        "pf-breakdown-stale-equity",
      ),
    ).toBeNull();
  });
});

describe("MFHW-15 wording", () => {
  it("N15: All and Equity name only the cards they really have", async () => {
    mount(<PortfolioPage />);
    expect(await screen.findByTestId("pf-chart-growth-unavailable")).toHaveTextContent(
      "The XIRR card above uses your dated cash flows.",
    );
    expect(text("pf-chart-growth-unavailable")).not.toMatch(/benchmark/);
  });
  it("N15: Equity keeps the benchmark card in the sentence", async () => {
    setUrl("?view=equity");
    mount(<PortfolioPage />);
    expect(await screen.findByTestId("pf-chart-growth-unavailable")).toHaveTextContent(
      "The XIRR and benchmark cards above use your dated cash flows.",
    );
  });
});

describe("MFHW-16 sorting", () => {
  it("N5: Unrealized P&L sorts by the amount, XIRR and absolute return sort separately", async () => {
    const user = userEvent.setup();
    setUrl("?view=mf");
    // Alpha: unrealised 2,010 (+20%), XIRR 15.2, abs 20. Beta: unrealised -500 (-10%), no XIRR, abs -5.5.
    // Delta: unrealised 900 (+30%, a small cost base), XIRR 40, abs 5.
    const delta = {
      ...fx.alphaGrowth,
      scheme_code: 100004,
      scheme_name: "Example Delta Fund - Direct Plan - Growth",
      unrealized_pnl: "900.0000",
      unrealized_pct: 30,
      xirr_pct: 40,
      absolute_return_pct: 5,
    };
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": pf.envelope(
        fx.viewSummary("mf", {}, [fx.alphaGrowth, fx.betaIdcw, delta]),
      ),
    });
    await screen.findByTestId("pf-mf-holdings-table");
    const order = () =>
      within(screen.getByTestId("pf-mf-holdings-table"))
        .getAllByRole("row")
        .map((r) => r.getAttribute("data-testid"))
        .filter((x): x is string => !!x && x.startsWith("pf-mf-row-"))
        .map((x) => x.replace("pf-mf-row-", ""));
    await user.click(screen.getByTestId("pf-mf-sort-unrealized"));
    expect(order()).toEqual(["100002", "100004", "100001"]); // by amount: -500, 900, 2,010 (by % it would be 100002, 100001, 100004)
    await user.click(screen.getByTestId("pf-mf-sort-xirr"));
    expect(order()[0]).toBe("100001"); // 15.2 before 40 (ascending), the one without XIRR last
    expect(order()).toEqual(["100001", "100004", "100002"]);
    await user.click(screen.getByTestId("pf-mf-sort-absolute"));
    expect(order()).toEqual(["100002", "100004", "100001"]); // -5.5, 5, 20
  });
});

describe("MFHW-17 exited rows are per table", () => {
  it("N6: each table has its own switch; in All the server is asked when either is on", async () => {
    const user = userEvent.setup();
    const exitedMf = { ...fx.betaIdcw, exited: true, units: "0.0000", market_value: null };
    const mock = mount(<PortfolioPage />, {
      "GET /portfolio/summary": (c) =>
        pf.envelope(
          fx.viewSummary(
            "all",
            {},
            c.query.get("include_exited") === "true"
              ? [fx.alphaGrowth, exitedMf]
              : [fx.alphaGrowth],
          ),
        ),
    });
    await screen.findByTestId("pf-mf-holdings-table");
    expect(screen.queryByTestId("pf-mf-row-100002")).toBeNull();
    await user.click(screen.getByTestId("pf-mf-show-exited"));
    await screen.findByTestId("pf-mf-row-100002");
    expect((screen.getByTestId("pf-show-exited") as HTMLInputElement).checked).toBe(false);
    expect(mock.calls.some((c) => c.query.get("include_exited") === "true")).toBe(true);
    // turning the stock table's switch on does not turn the fund table's off
    await user.click(screen.getByTestId("pf-show-exited"));
    expect((screen.getByTestId("pf-mf-show-exited") as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByTestId("pf-mf-show-exited"));
    await waitFor(() => expect(screen.queryByTestId("pf-mf-row-100002")).toBeNull());
    expect((screen.getByTestId("pf-show-exited") as HTMLInputElement).checked).toBe(true);
  });

  it("N6: the scheme filter keeps an exited scheme (asked with include_exited)", async () => {
    const exitedMf = mfHoldingSchema.parse({ ...fx.betaIdcw, exited: true });
    const mock = createMockFetch({
      "GET /portfolio/mf/txns": pf.envelope({ items: [fx.mfTxn], next_cursor: null }),
      "GET /portfolio/mf/fund-mappings": pf.envelope({ items: [] }),
      "GET /portfolio/mf/holdings": pf.envelope({ items: [fx.alphaGrowth, fx.betaIdcw] }),
    });
    vi.stubGlobal("fetch", mock.impl);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MfTxnSection schemes={[mfHoldingSchema.parse(fx.alphaGrowth)]} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const select = await screen.findByTestId("pf-mf-filter-scheme");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    expect(select).toHaveTextContent("Example Beta Fund");
    expect(
      mock.calls.find((c) => c.path === "/portfolio/mf/holdings")?.query.get("include_exited"),
    ).toBe("true");
    expect(exitedMf.exited).toBe(true);
  });
});

describe("MFHW-18 transactions section", () => {
  const schemes = [mfHoldingSchema.parse(fx.alphaGrowth)];
  function mountTxns(routes: Routes = {}) {
    const mock = createMockFetch({
      "GET /portfolio/mf/txns": pf.envelope({ items: [fx.mfTxn], next_cursor: null }),
      "GET /portfolio/mf/fund-mappings": pf.envelope({ items: [fx.mfMapping] }),
      "GET /portfolio/mf/holdings": pf.envelope({ items: [] }),
      "GET /mf/schemes": pf.envelope(fx.mfSchemeSearch),
      "GET /market/holidays": pf.envelope({ year_loaded: false, items: [] }),
      ...routes,
    });
    vi.stubGlobal("fetch", mock.impl);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MfTxnSection schemes={schemes} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    return mock;
  }

  it("N7: fund-name mappings are fetched only when the panel is opened", async () => {
    const user = userEvent.setup();
    const mock = mountTxns();
    await screen.findByTestId("pf-mf-txn-row-501");
    expect(mock.calls.some((c) => c.path === "/portfolio/mf/fund-mappings")).toBe(false);
    await user.click(screen.getByTestId("pf-mf-mappings-toggle"));
    await screen.findByTestId("pf-mf-mapping-list");
    expect(mock.calls.filter((c) => c.path === "/portfolio/mf/fund-mappings")).toHaveLength(1);
  });

  it("N7: typing in the folio filter asks the list once, after a pause", async () => {
    const user = userEvent.setup();
    const mock = mountTxns();
    await screen.findByTestId("pf-mf-txn-row-501");
    const before = mock.calls.filter((c) => c.path === "/portfolio/mf/txns").length;
    await user.type(screen.getByTestId("pf-mf-filter-folio"), "TEST-F1");
    await waitFor(() => {
      const calls = mock.calls.filter((c) => c.path === "/portfolio/mf/txns");
      expect(calls.at(-1)?.query.get("folio")).toBe("TEST-F1");
    });
    const after = mock.calls.filter((c) => c.path === "/portfolio/mf/txns");
    expect(after.length - before).toBe(1); // not one request per keystroke
  });

  it("N8: after a re-map the panel says old -> new and the form is closed", async () => {
    const user = userEvent.setup();
    mountTxns({
      "PUT /portfolio/mf/fund-mappings": (c) =>
        pf.envelope({
          ...fx.mfMapping,
          scheme_code: (c.body as { scheme_code: number }).scheme_code,
          scheme_name: "Example Alpha Fund - Regular Plan - Growth",
        }),
    });
    await user.click(await screen.findByTestId("pf-mf-mappings-toggle"));
    await screen.findByTestId("pf-mf-mapping-list");
    await user.click(screen.getByTestId("pf-mf-mapping-change"));
    await user.type(screen.getByTestId("pf-mf-map-scheme-search"), "alpha");
    await user.click(await screen.findByTestId("pf-mf-map-scheme-pick-100009"));
    await user.click(screen.getByTestId("pf-mf-mapping-save"));
    const saved = await screen.findByTestId("pf-mf-mapping-saved");
    expect(saved).toHaveTextContent(
      "Example Alpha Fund: Example Alpha Fund - Direct Plan - Growth -> Example Alpha Fund - Regular Plan - Growth",
    );
    expect(screen.queryByTestId("pf-mf-mapping-form")).toBeNull();
  });

  it("N1 and N2: units go through format.ts; an unreadable stamp duty or folio is a dash, never 0 or empty", async () => {
    mountTxns({
      "GET /portfolio/mf/txns": pf.envelope({
        items: [
          { ...fx.mfTxn, id: 601, units: "1234567.5000" },
          { ...fx.mfTxn, id: 602, stamp_duty: undefined, folio: undefined },
        ],
        next_cursor: null,
      }),
    });
    const ok = await screen.findByTestId("pf-mf-txn-row-601");
    expect(ok.textContent).toContain("12,34,567.5");
    const bad = screen.getByTestId("pf-mf-txn-row-602");
    expect(bad.textContent).not.toContain("₹0.00");
    expect(within(bad).getAllByTestId("cell-unknown").length).toBeGreaterThanOrEqual(2);
    expect(
      within(bad)
        .getAllByTestId("cell-reason")
        .map((n) => n.textContent)
        .join(" "),
    ).toMatch(/stamp duty could not be read/);
    // such a row cannot be edited (the save would invent a folio or a zero charge)
    expect(within(bad).getByTestId("pf-mf-txn-edit-602")).toBeDisabled();
    expect(within(bad).getByTestId("pf-mf-txn-locked-602")).toHaveTextContent(/cannot be edited/i);
  });

  it("N3: an entry of a type the form does not offer is shown as it is and cannot be edited", async () => {
    const user = userEvent.setup();
    mountTxns({
      "GET /portfolio/mf/txns": pf.envelope({
        items: [{ ...fx.mfTxn, id: 603, txn_type: "switch_in" }],
        next_cursor: null,
      }),
    });
    const row = await screen.findByTestId("pf-mf-txn-row-603");
    expect(row).toHaveTextContent("Switch in");
    expect(within(row).getByTestId("pf-mf-txn-edit-603")).toBeDisabled();
    await user.click(within(row).getByTestId("pf-mf-txn-edit-603")).catch(() => undefined);
    expect(screen.queryByTestId("pf-mf-txn-form")).toBeNull();
    expect(draftFromTxn({ ...fx.mfTxn, txn_type: "switch_in" })).toBeNull();
    expect(uneditableReason({ ...fx.mfTxn, txn_type: "bonus_merger" })).toMatch(/cannot be edited/);
    expect(uneditableReason(fx.mfTxn)).toBeNull();
  });

  it("S13: the heading of the form takes focus on Add and on Edit; after a delete focus goes to Add", async () => {
    const user = userEvent.setup();
    mountTxns({
      "DELETE /portfolio/mf/txns/501": pf.envelope({ deleted: 501, warnings: [] }),
    });
    await user.click(await screen.findByTestId("pf-mf-txn-add"));
    expect(document.activeElement).toBe(screen.getByTestId("pf-mf-txn-form-heading"));
    await user.click(screen.getByTestId("pf-mf-txn-cancel"));
    await user.click(await screen.findByTestId("pf-mf-txn-edit-501"));
    expect(document.activeElement).toBe(screen.getByTestId("pf-mf-txn-form-heading"));
    expect(screen.getByTestId("pf-mf-txn-form-heading")).toHaveTextContent(
      "Edit mutual fund transaction",
    );
    await user.click(screen.getByTestId("pf-mf-txn-cancel"));
    await user.click(await screen.findByTestId("pf-mf-txn-delete-501"));
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("pf-mf-txn-add")));
  });

  it("N1: the delete question and the saved toast show units through format.ts", async () => {
    const user = userEvent.setup();
    mountTxns({
      "GET /portfolio/mf/txns": pf.envelope({
        items: [{ ...fx.mfTxn, units: "1234567.5000" }],
        next_cursor: null,
      }),
    });
    await user.click(await screen.findByTestId("pf-mf-txn-delete-501"));
    expect(document.body.textContent).toContain("12,34,567.5 units");
  });

  async function fillAndSave(user: ReturnType<typeof userEvent.setup>, units: string) {
    await user.click(await screen.findByTestId("pf-mf-txn-add"));
    await user.type(screen.getByTestId("pf-mf-scheme-search"), "alpha");
    await user.click(await screen.findByTestId("pf-mf-scheme-pick-100001"));
    await user.type(screen.getByTestId("pf-mf-txn-folio"), "TEST-F1");
    fireEvent.change(screen.getByTestId("pf-mf-txn-date"), { target: { value: "2026-09-04" } });
    await user.type(screen.getByTestId("pf-mf-txn-units"), units);
    await user.type(screen.getByTestId("pf-mf-txn-nav"), "81");
    await user.type(screen.getByTestId("pf-mf-txn-amount"), "999.95");
    await user.click(screen.getByTestId("pf-mf-txn-save"));
  }

  it("N4: the 'sent as a new transaction' warning appears after a lost try, not after a definite 422", async () => {
    const user = userEvent.setup();
    let n = 0;
    mountTxns({
      "POST /portfolio/mf/txns": () => {
        n += 1;
        return {
          status: 422,
          body: { error: { code: "VALIDATION_FAILED", message: "units must be positive" } },
        };
      },
    });
    await fillAndSave(user, "12.3450");
    await screen.findByTestId("pf-mf-txn-error");
    await user.clear(screen.getByTestId("pf-mf-txn-units"));
    await user.type(screen.getByTestId("pf-mf-txn-units"), "12");
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    await waitFor(() => expect(n).toBe(2));
    expect(screen.queryByTestId("pf-mf-txn-notice")).toBeNull();
  });

  it("N4: after a lost try (network failure) a changed body carries the duplicate warning", async () => {
    const user = userEvent.setup();
    let n = 0;
    const mock = mountTxns({
      "POST /portfolio/mf/txns": () => ({
        status: 422,
        body: { error: { code: "VALIDATION_FAILED", message: "no" } },
      }),
    });
    const real = mock.impl;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        n += 1;
        if (n === 1) throw new TypeError("Failed to fetch");
      }
      return real(input, init);
    }) as typeof fetch);
    await fillAndSave(user, "12.3450");
    await screen.findByTestId("pf-mf-txn-error");
    await user.clear(screen.getByTestId("pf-mf-txn-units"));
    await user.type(screen.getByTestId("pf-mf-txn-units"), "12");
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    await waitFor(() => expect(n).toBe(2));
    expect(await screen.findByTestId("pf-mf-txn-notice")).toHaveTextContent(/exists twice/);
  });

  it("S8: the amount hint no longer claims a redemption amount is the net credited", async () => {
    const user = userEvent.setup();
    mountTxns();
    await user.click(await screen.findByTestId("pf-mf-txn-add"));
    const form = screen.getByTestId("pf-mf-txn-form");
    expect(form.textContent).not.toMatch(/net amount credited/i);
    expect(form.textContent).toContain("Units x NAV, without stamp duty");
  });
});
