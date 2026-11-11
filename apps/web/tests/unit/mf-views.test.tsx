import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadBeforeAll } from "./preload";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";
import { PortfolioCard } from "@/components/dashboard/PortfolioCard";
import { Footer } from "@/components/shell/Footer";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as pf from "../mocks/portfolio-fixtures";
import * as fx from "../mocks/mf-portfolio-fixtures";
import "./dom-matchers";

// F16: the All / Equity / Mutual funds views (docs/06 6.7a). MFH-U70..U74, U77, U78. Synthetic data only.

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

describe("MFH-U70 view switcher", () => {
  it("defaults to All, sends view explicitly and the segments carry test ids", async () => {
    const mock = mount(<PortfolioPage />);
    await screen.findByTestId("pf-card-xirr");
    const group = screen.getByTestId("pf-view-switcher");
    expect(group).toHaveAttribute("role", "radiogroup");
    expect(group.getAttribute("data-view")).toBe("all");
    for (const id of ["pf-view-all", "pf-view-equity", "pf-view-mf"]) {
      expect(screen.getByTestId(id)).toHaveAttribute("role", "radio");
    }
    expect(screen.getByTestId("pf-view-all")).toHaveAttribute("aria-checked", "true");
    const summaryCalls = mock.calls.filter((c) => c.path === "/portfolio/summary");
    expect(summaryCalls[0]?.query.get("view")).toBe("all");
  });

  it("the URL is the state: ?view=mf opens Mutual funds, an unknown value falls back to All", async () => {
    setUrl("?view=mf");
    const first = mount(<PortfolioPage />);
    await screen.findByTestId("pf-mf-holdings-table");
    expect(screen.getByTestId("pf-view-mf")).toHaveAttribute("aria-checked", "true");
    expect(first.calls.find((c) => c.path === "/portfolio/summary")?.query.get("view")).toBe("mf");
  });

  it("an unknown ?view= falls back to All", async () => {
    setUrl("?view=bogus");
    const mock = mount(<PortfolioPage />);
    await screen.findByTestId("pf-card-xirr");
    expect(screen.getByTestId("pf-view-all")).toHaveAttribute("aria-checked", "true");
    expect(mock.calls.find((c) => c.path === "/portfolio/summary")?.query.get("view")).toBe("all");
  });

  it("is operable by keyboard: arrows move and select, the URL follows, one tab stop", async () => {
    const user = userEvent.setup();
    const mock = mount(<PortfolioPage />);
    await screen.findByTestId("pf-card-xirr");
    expect(screen.getByTestId("pf-view-all")).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("pf-view-equity")).toHaveAttribute("tabindex", "-1");
    screen.getByTestId("pf-view-all").focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("pf-view-equity")).toHaveAttribute("aria-checked", "true");
    // (jsdom lets the autoFocus of a closed dialog steal focus after the section remounts; a
    // browser does not, so focus is put back by hand before the next key.)
    screen.getByTestId("pf-view-equity").focus();
    expect(window.location.search).toContain("view=equity");
    await waitFor(() =>
      expect(mock.calls.some((c) => c.query.get("view") === "equity")).toBe(true),
    );
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("pf-view-mf")).toHaveAttribute("aria-checked", "true");
    screen.getByTestId("pf-view-mf").focus();
    await user.keyboard("{ArrowRight}"); // wraps to All
    expect(screen.getByTestId("pf-view-all")).toHaveAttribute("aria-checked", "true");
    screen.getByTestId("pf-view-all").focus();
    await user.keyboard("{End}");
    expect(screen.getByTestId("pf-view-mf")).toHaveAttribute("aria-checked", "true");
    screen.getByTestId("pf-view-mf").focus();
    await user.keyboard("{Home}");
    expect(screen.getByTestId("pf-view-all")).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the previous view's data on screen while the next view loads (no blank flash)", async () => {
    const user = userEvent.setup();
    const inner = createMockFetch({
      "GET /portfolio/summary": fx.byView(),
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
    await user.click(screen.getByTestId("pf-view-mf"));
    // The switcher already shows Mutual funds, the body still shows the All data (never blank).
    expect(screen.getByTestId("pf-view-mf")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("pf-view-body")).toHaveAttribute("data-view", "all");
    expect(screen.getByTestId("pf-card-xirr")).toBeInTheDocument();
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByTestId("pf-view-body")).toHaveAttribute("data-view", "mf"),
    );
  });
});

describe("MFH-U71 cards of each view", () => {
  it("All: breakdown with the no-average footnote, both return-basis labels, no Nifty card", async () => {
    mount(<PortfolioPage />);
    await screen.findByTestId("pf-breakdown-table");
    expect(screen.getByTestId("pf-breakdown-row-equity")).toBeInTheDocument();
    expect(screen.getByTestId("pf-breakdown-row-mf")).toBeInTheDocument();
    expect(text("pf-breakdown-footnote")).toBe(
      "XIRR cannot be added or averaged; each row uses only its own cash flows.",
    );
    const table = text("pf-breakdown-table");
    expect(table).toContain("price return (excludes dividends)");
    expect(table).toContain("total return (includes IDCW payouts)");
    expect(text("pf-basis-line")).toBe("Stocks: price return. Mutual funds: total return.");
    expect(screen.queryByTestId("pf-card-benchmark")).toBeNull(); // hidden, not zero
    expect(screen.getByTestId("pf-card-idcw-income")).toBeInTheDocument();
    // two tables, Stocks then Mutual funds, each with its own totals
    expect(screen.getByTestId("pf-holdings")).toBeInTheDocument();
    expect(await screen.findByTestId("pf-mf-holdings-table")).toBeInTheDocument();
    expect(screen.getByTestId("pf-mf-totals-row")).toBeInTheDocument();
    expect(screen.getByTestId("pf-stocks-totals")).toBeInTheDocument();
    // allocation by asset class and by scheme/category
    await screen.findByTestId("pf-allocation-class");
    expect(screen.getByTestId("pf-allocation-mf")).toBeInTheDocument();
    expect(screen.getByTestId("pf-allocation-category")).toBeInTheDocument();
    // the one-sentence reason why the three views need not add up
    expect(text("pf-not-add-up")).toMatch(/need not add up/);
    // tabs for the two transaction lists
    expect(screen.getByRole("tab", { name: "Stock transactions" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "MF transactions" })).toBeInTheDocument();
    expect(screen.getByTestId("pf-dividends")).toBeInTheDocument(); // equity dividends, labelled
  });

  it("Equity: no IDCW card, no breakdown, Nifty comparison and dividends stay", async () => {
    setUrl("?view=equity");
    mount(<PortfolioPage />);
    await screen.findByTestId("pf-card-benchmark");
    expect(screen.queryByTestId("pf-card-idcw-income")).toBeNull();
    expect(screen.queryByTestId("pf-breakdown")).toBeNull();
    expect(screen.queryByTestId("pf-mf-holdings-table")).toBeNull();
    expect(screen.getByTestId("pf-dividends")).toBeInTheDocument();
    expect(text("pf-card-benchmark")).toContain("Nifty 50");
    expect(text("pf-basis-line")).toMatch(/price return/);
  });

  it("Mutual funds: no Nifty comparison, no estimated dividends, no adjustments; IDCW income card stays", async () => {
    setUrl("?view=mf");
    mount(<PortfolioPage />);
    await screen.findByTestId("pf-mf-holdings-table");
    expect(screen.queryByTestId("pf-card-benchmark")).toBeNull();
    expect(screen.queryByTestId("pf-dividends")).toBeNull();
    expect(screen.queryByTestId("pf-adjustments")).toBeNull();
    expect(screen.queryByTestId("pf-breakdown")).toBeNull();
    expect(screen.queryByTestId("pf-holdings")).toBeNull(); // no stock table
    expect(text("pf-card-idcw-income")).toContain("₹200.00");
    expect(text("pf-card-invested")).toContain("₹15,050.00");
    expect(text("pf-basis-line")).toMatch(/total return/);
    // the MF holdings row: plan and option chips, folio, scheme link, IDCW warning chip
    const row = screen.getByTestId("pf-mf-row-100002");
    expect(within(row).getByTestId("pf-mf-plan-chip")).toHaveTextContent("Regular");
    expect(within(row).getByTestId("pf-mf-option-chip")).toHaveTextContent("IDCW");
    expect(within(row).getByTestId("pf-mf-idcw-chip")).toHaveTextContent(
      "IDCW: returns include payouts you entered",
    );
    expect(within(row).getByTestId("pf-mf-folios")).toHaveTextContent("TEST-F2");
    expect(within(row).getByTestId("pf-mf-link-100002")).toHaveAttribute("href", "/mf/100002");
    const alpha = screen.getByTestId("pf-mf-row-100001");
    expect(within(alpha).getByTestId("pf-mf-plan-chip")).toHaveTextContent("Direct");
    expect(within(alpha).getByTestId("pf-mf-option-chip")).toHaveTextContent("Growth");
  });

  it("a malformed field or section degrades alone and never blanks the view", async () => {
    setUrl("?view=mf");
    const bad = fx.viewSummary("mf", {
      allocation_by_category: "not a list",
      mf_holdings: [fx.alphaGrowth, { scheme_code: "oops" }, fx.betaIdcw],
      totals: { ...fx.viewSummary("mf").totals, unrealized_pct: "bad" },
    });
    mount(<PortfolioPage />, { "GET /portfolio/summary": pf.envelope(bad) });
    await screen.findByTestId("pf-mf-holdings-table");
    expect(screen.getByTestId("pf-mf-row-100001")).toBeInTheDocument();
    expect(screen.getByTestId("pf-mf-bad-rows")).toHaveTextContent(
      "1 holding rows could not be read",
    );
    expect(text("pf-summary")).toMatch(/Could not read: category allocation/);
    expect(text("pf-card-invested")).toContain("₹15,050.00");
    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("stock rows keep showing when the MF part of All is unreadable", async () => {
    const bad = fx.viewSummary("all", { mf_holdings: { broken: true }, breakdown: 7 });
    mount(<PortfolioPage />, { "GET /portfolio/summary": pf.envelope(bad) });
    await screen.findByTestId("pf-holdings");
    expect(screen.getByTestId("pf-summary")).toHaveTextContent(
      /Could not read: .*mutual fund holdings/,
    );
    expect(screen.getByTestId("pf-card-invested")).toBeInTheDocument();
  });
});

describe("MFH-U72 honesty: unknown, stale and partial MF values", () => {
  const noNav = fx.viewSummary(
    "mf",
    {
      totals: {
        ...fx.viewSummary("mf").totals,
        market_value: null,
        market_value_reason: "missing_nav: Example Gamma Fund - Direct Plan - Growth",
        unrealized_pnl: null,
        unrealized_pct: null,
        total_pnl: null,
        total_pnl_reason: "missing_nav: Example Gamma Fund - Direct Plan - Growth",
        day_change: null,
        day_change_reason: "unavailable for Example Gamma Fund",
      },
      returns: {
        xirr_pct: null,
        xirr_reason: "no_nav",
        absolute_return_pct: null,
        absolute_return_basis: "x",
        span_days: 900,
        first_flow_date: "2024-01-05",
      },
    },
    [fx.alphaGrowth, fx.gammaNoNav],
  );

  it("a total with an unpriced holding is a dash with the exact reason, never a partial sum", async () => {
    setUrl("?view=mf");
    mount(<PortfolioPage />, { "GET /portfolio/summary": pf.envelope(noNav) });
    await screen.findByTestId("pf-mf-holdings-table");
    const value = screen.getByTestId("pf-card-value");
    expect(within(value).getByTestId("stat-null")).toHaveTextContent(
      "Value unavailable: Example Gamma Fund - Direct Plan - Growth have no NAV yet.",
    );
    expect(within(value).queryByTestId("stat-value")).toBeNull();
    expect(screen.getByTestId("pf-unpriced-banner")).toHaveTextContent("Example Gamma Fund");
    // the totals row of the table does not sum the priced funds either
    const totals = screen.getByTestId("pf-mf-totals-row");
    expect(totals.textContent).not.toContain("12,060");
    expect(within(totals).getAllByTestId("cell-unknown").length).toBeGreaterThan(0);
    // the unpriced row: NAV, value and P&L are dashes with the reason as tooltip, units stay
    const row = screen.getByTestId("pf-mf-row-100003");
    const unknown = within(row).getAllByTestId("cell-unknown");
    expect(unknown.some((c) => c.getAttribute("title") === "No NAV for this fund yet")).toBe(true);
    expect(row.textContent).toContain("10.00");
    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
    // XIRR is unknown with its reason, not 0
    expect(within(screen.getByTestId("pf-card-xirr")).getByTestId("stat-null")).toHaveTextContent(
      "No NAV for this fund yet",
    );
  });

  it("a stale NAV keeps its value and shows the amber chip 'NAV as of {date}' on the row and the card", async () => {
    setUrl("?view=mf");
    const stale = { ...fx.alphaGrowth, nav_stale: true, nav_date: "2026-10-15" };
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": pf.envelope(
        fx.viewSummary("mf", {}, [stale, fx.betaIdcw]),
        [],
        200,
        {
          as_of: "2026-10-24T09:00:00Z",
          source: "mfapi.in",
          stale: true,
        },
      ),
    });
    await screen.findByTestId("pf-mf-holdings-table");
    const chip = within(screen.getByTestId("pf-mf-row-100001")).getByTestId("pf-mf-stale-chip");
    expect(chip).toHaveTextContent("NAV as of 15 Oct 2026");
    expect(screen.getByTestId("pf-nav-stale-chip")).toHaveTextContent("NAV as of 15 Oct 2026");
    expect(text("pf-mf-row-100001")).toContain("₹12,060.00"); // the value is still shown
    expect(screen.getAllByTestId("asof-chip").some((c) => /stale/.test(c.textContent ?? ""))).toBe(
      true,
    );
  });
});

describe("MFH-U73 under one year", () => {
  it("the return card reads Absolute return, says why, and shows no annualised number", async () => {
    setUrl("?view=mf");
    const young = fx.viewSummary("mf", {
      returns: {
        xirr_pct: 99.99, // must never be shown while under a year
        xirr_reason: "under_one_year",
        absolute_return_pct: 4.5,
        absolute_return_basis: "simple, not annualised",
        span_days: 120,
        first_flow_date: "2026-06-26",
      },
    });
    mount(<PortfolioPage />, { "GET /portfolio/summary": pf.envelope(young) });
    const card = await screen.findByTestId("pf-card-absolute-return");
    expect(card).toHaveTextContent("Absolute return");
    expect(card).toHaveTextContent("+4.50%");
    expect(card).toHaveTextContent(
      "XIRR is shown after the first year. Absolute return is shown instead.",
    );
    expect(screen.queryByTestId("pf-card-xirr")).toBeNull();
    expect(card.textContent).not.toContain("99.99");
    // no tooltip text on the card carries the annualised figure either
    expect(document.body.innerHTML).not.toContain("99.99");
    // a holding row under a year: absolute return and the 'under 1 year' chip, never the XIRR
    const row = screen.getByTestId("pf-mf-row-100002");
    expect(within(row).getByTestId("pf-mf-under-year-chip")).toHaveTextContent("under 1 year");
    expect(row.textContent).toContain("-5.50%");
  });

  it("at a year or more both XIRR and the simple absolute return are shown, labelled", async () => {
    setUrl("?view=mf");
    mount(<PortfolioPage />);
    const card = await screen.findByTestId("pf-card-xirr");
    expect(card).toHaveTextContent("9.50%");
    expect(screen.getByTestId("pf-card-xirr-abs")).toHaveTextContent("simple, not annualised");
  });
});

describe("MFH-U74 empty states", () => {
  const onlyEquity = {
    mf: fx.viewSummary("mf", {
      asset_classes_present: ["equity"],
      mf_holdings: [],
      allocation_by_scheme: [],
      allocation_by_category: [],
    }),
    all: fx.viewSummary("all", {
      asset_classes_present: ["equity"],
      mf_holdings: [],
      breakdown: [],
      allocation_by_scheme: [],
      allocation_by_category: [],
      allocation_by_asset_class: [],
    }),
  };

  it("Mutual funds with no MF transactions shows the exact copy with Import and Add actions", async () => {
    setUrl("?view=mf");
    mount(<PortfolioPage />, { "GET /portfolio/summary": fx.byView(onlyEquity) });
    const empty = await screen.findByTestId("pf-empty-mf");
    expect(empty).toHaveTextContent(
      "No mutual fund transactions yet. Import your broker's MF statement or add a transaction.",
    );
    expect(screen.getByTestId("pf-empty-import-mf")).toHaveAttribute(
      "href",
      "/imports?kind=mf_statement",
    );
    expect(screen.getByTestId("pf-empty-add-mf")).toBeInTheDocument();
  });

  it("All with only equity shows the stocks and a hint card for mutual funds", async () => {
    mount(<PortfolioPage />, { "GET /portfolio/summary": fx.byView(onlyEquity) });
    await screen.findByTestId("pf-holdings");
    expect(screen.getByTestId("pf-empty-hints")).toHaveTextContent(
      "No mutual fund transactions yet. Import your broker's MF statement or add a transaction.",
    );
    expect(screen.queryByTestId("pf-mf-holdings-table")).toBeNull();
    expect(screen.queryByTestId("pf-breakdown")).toBeNull();
  });

  it("All with only mutual funds shows the MF table and a hint card for stocks", async () => {
    const onlyMf = fx.viewSummary("all", {
      asset_classes_present: ["mf"],
      holdings: [],
      breakdown: [],
      allocation_by_stock: [],
      allocation_by_sector: [],
    });
    mount(<PortfolioPage />, { "GET /portfolio/summary": pf.envelope(onlyMf) });
    await screen.findByTestId("pf-mf-holdings-table");
    expect(screen.getByTestId("pf-empty-hints")).toHaveTextContent("No stock transactions yet");
    expect(screen.queryByTestId("pf-holdings")).toBeNull();
  });

  it("nothing at all keeps the existing empty copy", async () => {
    const none = fx.viewSummary("all", {
      asset_classes_present: [],
      holdings: [],
      mf_holdings: [],
      breakdown: [],
      allocation_by_stock: [],
      allocation_by_sector: [],
      allocation_by_scheme: [],
      allocation_by_category: [],
      allocation_by_asset_class: [],
    });
    mount(<PortfolioPage />, { "GET /portfolio/summary": pf.envelope(none) });
    await screen.findByTestId("pf-holdings");
    expect(screen.getByTestId("pf-holdings")).toHaveTextContent(
      "No open holdings. Add a transaction below, or import your transactions.",
    );
  });

  it("states: loading skeleton, then error with Retry that refetches", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mount(<PortfolioPage />, {
      "GET /portfolio/summary": () => {
        calls += 1;
        return calls === 1
          ? { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }
          : pf.envelope(fx.viewSummary("all"));
      },
    });
    expect(screen.getByTestId("pf-summary")).toHaveAttribute("data-state", "loading");
    const err = await screen.findByTestId("card-retry");
    expect(screen.getByTestId("pf-summary")).toHaveAttribute("data-state", "error");
    await user.click(err);
    await screen.findByTestId("pf-breakdown-table");
  });
});

describe("MFH-U77 attribution and source lines", () => {
  it("MF value cards carry the NAV attribution; units and amounts say where they come from", async () => {
    setUrl("?view=mf");
    mount(<PortfolioPage />);
    await screen.findByTestId("pf-mf-holdings-table");
    expect(text("pf-summary")).toContain("NAV data: AMFI, via mfapi.in");
    expect(text("pf-summary")).toContain("your statement or entries");
    expect(text("pf-mf-attribution")).toBe("NAV data: AMFI, via mfapi.in");
    expect(text("pf-mf-note")).toContain("your statement or entries");
    expect(text("pf-mf-note")).toContain("total return (includes IDCW payouts)");
    expect(text("pf-basis-line")).toContain("total return (includes IDCW payouts)");
  });

  it("stock figures say price return; the All cards say both, and mixed sources", async () => {
    mount(<PortfolioPage />);
    await screen.findByTestId("pf-basis-line");
    expect(text("pf-breakdown-row-equity")).toContain("price return (excludes dividends)");
    expect(text("pf-mixed-source")).toContain("mix sources");
    expect(text("pf-summary")).toContain("NAV data: AMFI, via mfapi.in");
  });

  it("the shell footer disclaimer is still present (SAF-03)", () => {
    render(<Footer pathname="/portfolio" />);
    expect(screen.getByTestId("app-disclaimer")).toHaveTextContent(
      "Personal research tool. Data may be delayed, incomplete or wrong. Not investment advice.",
    );
  });
});

describe("MFH-U78 no new network from the browser", () => {
  it("the views call only the app API, and the page has no iframe or external link", async () => {
    const urls: string[] = [];
    const inner = createMockFetch({
      "GET /portfolio/summary": fx.byView(),
      "GET /portfolio/txns": pf.envelope(pf.txns),
      "GET /portfolio/mf/txns": pf.envelope({ items: [fx.mfTxn], next_cursor: null }),
      "GET /portfolio/mf/fund-mappings": pf.envelope({ items: [fx.mfMapping] }),
      "GET /portfolio/adjustments": pf.envelope(pf.adjustments),
    });
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return inner.impl(input, init);
    }) as typeof fetch;
    const user = userEvent.setup();
    mount(<PortfolioPage />, {}, spy);
    await screen.findByTestId("pf-breakdown-table");
    await user.click(screen.getByTestId("pf-view-mf"));
    await screen.findByTestId("pf-view-body");
    await user.click(screen.getByTestId("pf-view-equity"));
    await waitFor(() =>
      expect(urls.filter((u) => u.includes("view=equity")).length).toBeGreaterThan(0),
    );
    expect(urls.length).toBeGreaterThan(2);
    expect(urls.every((u) => u.startsWith("/api/v1/"))).toBe(true);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    const external = [...document.querySelectorAll("a[href]")].filter((a) =>
      /^https?:\/\//.test(a.getAttribute("href") ?? ""),
    );
    expect(external).toHaveLength(0);
  });
});

describe("dashboard snapshot switcher (docs/06 6.2)", () => {
  it("has the same switcher (default All, component state only) with dash-portfolio-view-* ids", async () => {
    const user = userEvent.setup();
    const mock = createMockFetch({ "GET /portfolio/summary": fx.byView() });
    vi.stubGlobal("fetch", mock.impl);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PortfolioCard />
      </QueryClientProvider>,
    );
    await screen.findByTestId("dash-allocation");
    expect(screen.getByTestId("dash-portfolio-view-switcher")).toHaveAttribute("data-view", "all");
    expect(mock.calls[0]?.query.get("view")).toBe("all");
    expect(screen.getByTestId("dash-basis-line")).toHaveTextContent(
      "Stocks: price return. Mutual funds: total return.",
    );
    await user.click(screen.getByTestId("dash-portfolio-view-mf"));
    await waitFor(() => expect(mock.calls.some((c) => c.query.get("view") === "mf")).toBe(true));
    expect(window.location.search).not.toContain("view="); // component state only
    await waitFor(() =>
      expect(screen.getByTestId("dash-portfolio-view-mf")).toHaveAttribute("aria-checked", "true"),
    );
  });
});
