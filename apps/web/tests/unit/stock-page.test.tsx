import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StockPage } from "@/components/stock/StockPage";
import { fail, ok } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as fx from "../mocks/stock-fixtures";
import "./dom-matchers";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function renderStock(routes: Record<string, Handler>, symbol = "TCS") {
  const mock = createMockFetch({
    "GET /watchlist": fx.emptyWatchlist,
    "GET /stocks/TCS/events": fx.events,
    "GET /stocks/TCS/links": fx.links,
    "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StockPage symbol={symbol} />
    </QueryClientProvider>,
  );
  return mock;
}

const base = (): Record<string, Handler> => ({
  "GET /stocks/TCS": fx.profile(),
  "GET /stocks/TCS/prices": fx.prices(),
  "GET /stocks/TCS/indicators": fx.indicators(),
});

beforeEach(() => {
  search = "";
  replace.mockReset();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe("stock header (BRK-12, SYS-14 header part, UI-02)", () => {
  it("manual mode: no Refresh button, import chip and Import prices link, last close with unit/source/as-of", async () => {
    renderStock(base());
    expect(await screen.findByTestId("stock-symbol")).toHaveTextContent("TCS");
    expect(screen.queryByTestId("header-refresh")).toBeNull();
    expect(screen.getByTestId("import-chip")).toHaveTextContent("Last price import: 9 Oct 2026");
    expect(screen.getByTestId("import-chip")).toHaveAttribute("data-stale", "false");
    expect(screen.getByTestId("header-import-prices")).toHaveAttribute("href", "/imports");
    expect(screen.getByTestId("manual-mode-banner")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("header-ltp").textContent).toMatch(/^₹/));
    expect(screen.getByTestId("header-price-meta")).toHaveTextContent(
      /Last close as of 9 Oct 2026.*Source: Imported prices/,
    );
    expect(screen.getByTestId("header-change").textContent).toMatch(/\+/);
  });

  it("stale import chip is amber with the word stale; holiday list missing notice", async () => {
    renderStock({
      ...base(),
      "GET /stocks/TCS": fx.profile(
        fx.withFreshness({ prices_stale: true, holidays_missing: true }),
      ),
    });
    const chip = await screen.findByTestId("import-chip");
    expect(chip).toHaveAttribute("data-stale", "true");
    expect(chip).toHaveTextContent("(stale)");
    expect(screen.getByTestId("holidays-missing-chip")).toHaveTextContent("Holiday list missing");
    expect(screen.getByTestId("stale-banner")).toBeInTheDocument();
  });

  it("52-week range is a dash with a reason with 70 bars, never 0", async () => {
    renderStock(base());
    expect(await screen.findByTestId("range-bar-null")).toHaveTextContent(/insufficient history/);
  });

  it("uses the computed 52-week range when the snapshot has it", async () => {
    renderStock({ ...base(), "GET /stocks/TCS/indicators": fx.indicatorsFull() });
    expect(await screen.findByTestId("range-bar")).toBeInTheDocument();
  });

  it("shows a skeleton while loading and not-found for an unknown symbol", async () => {
    renderStock({ "GET /stocks/ZZZ": fail(404, "NOT_FOUND", "Unknown stock") }, "ZZZ");
    expect(screen.getByTestId("stock-loading")).toBeInTheDocument();
    expect(await screen.findByTestId("stock-not-found")).toHaveTextContent(
      "No stock with the symbol ZZZ",
    );
  });

  it("an alias redirects with replace and a toast", async () => {
    renderStock({ "GET /stocks/OLDTCS": ok({ redirect_symbol: "TCS" }) }, "OLDTCS");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/stocks/TCS"));
  });

  it("broker mode shows Refresh; the rate limit copy is exact", async () => {
    const user = userEvent.setup();
    renderStock({
      ...base(),
      "GET /stocks/TCS": fx.profile({ price_mode: "broker" }),
      "POST /stocks/TCS/refresh": fail(429, "RATE_LIMITED", "slow down", {
        retry_after_seconds: 240,
      }),
    });
    await user.click(await screen.findByTestId("header-refresh"));
    await waitFor(() =>
      expect(screen.getByTestId("refresh-note")).toHaveTextContent(
        "You refreshed this recently. Try again in 4 min.",
      ),
    );
  });

  it("disabled actions carry their reason", async () => {
    renderStock(base());
    const alert = await screen.findByTestId("header-alert");
    expect(alert).toBeDisabled();
    const reason = document.getElementById(alert.getAttribute("aria-describedby") ?? "");
    expect(reason).toHaveTextContent("not built");
    expect(screen.getByTestId("header-compare")).toHaveAttribute("href", "/compare?symbols=TCS");
  });
});

describe("no prices and states (PRC UI states)", () => {
  it("no prices: empty state with the hint and an Import prices link, no 0 values", async () => {
    renderStock({
      "GET /stocks/TCS": fx.profile({
        flags: { no_prices: true, limited_history: false, series_warning: null },
        hint: "Import prices.csv for TCS",
        freshness: { ...fx.profileData.freshness, prices_as_of: null },
      }),
    });
    const box = await screen.findByTestId("no-prices");
    expect(box).toHaveTextContent("Import prices.csv for TCS");
    expect(screen.getByTestId("header-ltp-null")).toHaveTextContent("no prices imported");
    expect(screen.getByTestId("import-chip")).toHaveTextContent("none yet");
  });

  it("backfill pending shows a progress card", async () => {
    renderStock({
      ...base(),
      "GET /stocks/TCS": fx.profile({ backfill: { status: "running", job_id: 5 } }),
    });
    expect(await screen.findByTestId("backfill-banner")).toHaveTextContent("running");
  });

  it("limited history and series banners", async () => {
    renderStock({
      ...base(),
      "GET /stocks/TCS": fx.profile({
        flags: { no_prices: false, limited_history: true, series_warning: "BE" },
      }),
    });
    expect(await screen.findByTestId("limited-history-banner")).toBeInTheDocument();
    expect(screen.getByTestId("series-banner")).toHaveTextContent("series BE");
    expect(screen.getByTestId("badge-series")).toHaveTextContent("Series BE");
  });

  it("a failing indicators card does not blank the page and offers Retry", async () => {
    renderStock({
      ...base(),
      "GET /stocks/TCS/indicators": fail(500, "INTERNAL", "boom"),
    });
    expect(await screen.findByTestId("stock-symbol")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("card-gauges")).toHaveAttribute("data-state", "error"),
    );
    expect(screen.getByTestId("card-kpi")).toBeInTheDocument();
  });
});

describe("Overview", () => {
  it("KPI grid: unknown values show the honest reason, never 0/NaN/Infinity", async () => {
    renderStock(base());
    const grid = await screen.findByTestId("kpi-grid");
    await waitFor(() =>
      expect(within(grid).getAllByTestId("stat-null").length).toBeGreaterThanOrEqual(7),
    );
    expect(grid.textContent).toContain("not computed yet");
    expect(grid.textContent).not.toMatch(/NaN|Infinity|\b0\.00\b/);
  });

  it("KPI grid shows computed ratios with units once D05b data exists", async () => {
    renderStock({ ...base(), "GET /stocks/TCS/fundamentals": fx.fundamentalsComputed });
    const grid = await screen.findByTestId("kpi-grid");
    await waitFor(() => expect(grid.textContent).toContain("23.45x"));
    expect(grid.textContent).toContain("12.50%");
    expect(grid.textContent).toContain("0.40x");
  });

  it("gauges: scores not computed show a reason; quality hidden for financial companies", async () => {
    renderStock({
      ...base(),
      "GET /stocks/TCS": fx.profile({ company_type: "financial" }),
    });
    const card = await screen.findByTestId("card-gauges");
    await waitFor(() => expect(within(card).getAllByTestId("gauge-null").length).toBe(2));
    expect(within(card).getByTestId("quality-hidden")).toBeInTheDocument();
    expect(card.textContent).toContain("not computed yet");
  });

  it("gauges show the value and band when scores exist", async () => {
    renderStock({ ...base(), "GET /stocks/TCS/indicators": fx.indicatorsFull() });
    const trend = await screen.findByTestId("gauge-trend");
    await waitFor(() => expect(within(trend).getByTestId("gauge-band")).toHaveTextContent("Up"));
  });

  it("performance: returns with reasons for the missing windows", async () => {
    renderStock(base());
    const missing = await screen.findByTestId("performance-missing");
    expect(missing).toHaveTextContent("1Y: — insufficient history");
    expect(screen.getByTestId("chart-performance")).toBeInTheDocument();
  });

  it("events and research links; links are external with noopener noreferrer", async () => {
    renderStock(base());
    const ev = await screen.findByTestId("card-events");
    await waitFor(() => expect(ev).toHaveTextContent("Q2 results"));
    expect(ev).toHaveTextContent("Split (confirmed)");
    expect(ev).toHaveTextContent("1:2");
    expect(ev).toHaveTextContent("₹10.00 per share");
    const link = (await screen.findAllByTestId("research-link"))[0];
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("every chart has a Show data view (UI-10)", async () => {
    renderStock(base());
    await waitFor(() => expect(screen.getAllByTestId("chart-show-data").length).toBe(2));
  });
});

describe("tabs", () => {
  it("?tab= selects the tab and clicking a tab writes it to the URL", async () => {
    const user = userEvent.setup();
    search = "tab=bogus";
    renderStock(base());
    expect(await screen.findByTestId("tab-overview")).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByTestId("tab-chart"));
    expect(replace).toHaveBeenCalledWith("/stocks/TCS?tab=chart", { scroll: false });
  });
});

describe("UNCONFIRMED_ACTION and the soft flag (ACT-01)", () => {
  const drop = { 40: 0.5 };
  it("renders the exact docs/06 copy with Confirm/Reject (disabled with a reason until B07)", async () => {
    renderStock({
      ...base(),
      "GET /stocks/TCS/prices": fx.prices({ drops: drop }, [
        {
          code: "UNCONFIRMED_ACTION",
          message: `Possible split on ${fx.bars(70, drop)[40]![0]} not yet confirmed`,
        },
      ]),
    });
    const banner = await screen.findByTestId("unconfirmed-banner");
    expect(banner.textContent).toMatch(
      /^Possible split or bonus on \d+ \w{3} 2026: price changed -50\.0%\. Confirm to adjust history\.$/,
    );
    expect(screen.getByTestId("action-confirm")).toBeDisabled();
    expect(screen.getByTestId("action-reject")).toBeDisabled();
    // The detected date is covered, so the soft notice does not double up.
    expect(screen.queryByTestId("soft-flag")).toBeNull();
  });

  it("soft flag: a 25% drop with no action shows the notice, Dismiss disabled with a reason", async () => {
    renderStock({ ...base(), "GET /stocks/TCS/prices": fx.prices({ drops: { 40: 0.75 } }) });
    const flag = await screen.findByTestId("soft-flag");
    expect(flag).toHaveTextContent("Split/bonus or real move?");
    expect(within(flag).getByTestId("soft-flag-dismiss")).toBeDisabled();
    expect(within(flag).getByTestId("soft-flag-add-action")).toHaveAttribute(
      "href",
      "/stocks/TCS?tab=events",
    );
  });

  it("a 19% drop raises nothing", async () => {
    renderStock({ ...base(), "GET /stocks/TCS/prices": fx.prices({ drops: { 40: 0.81 } }) });
    await screen.findByTestId("stock-symbol");
    await waitFor(() => expect(screen.getByTestId("header-ltp").textContent).toMatch(/^₹/));
    expect(screen.queryByTestId("soft-flag")).toBeNull();
  });

  it("every other API warning is rendered", async () => {
    renderStock({
      ...base(),
      "GET /stocks/TCS/indicators": {
        status: 200,
        body: {
          data: fx.indicatorsData,
          warnings: [{ code: "ADJUSTMENT_CONFLICT", message: "Adjustment conflict text" }],
        },
      },
    });
    expect(await screen.findByTestId("warning-ADJUSTMENT_CONFLICT")).toHaveTextContent(
      "Adjustment conflict text",
    );
  });
});
