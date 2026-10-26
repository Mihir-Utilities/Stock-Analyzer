import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StockPage } from "@/components/stock/StockPage";
import { fail } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as cx from "../mocks/chart-fixtures";
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

function renderStock(routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /watchlist": fx.emptyWatchlist,
    "GET /stocks/TCS": fx.profile(),
    "GET /stocks/TCS/events": fx.events,
    "GET /stocks/TCS/links": fx.links,
    "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
    "GET /stocks/TCS/prices": fx.prices(),
    "GET /stocks/TCS/indicators": cx.indicatorsWithSeries(),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StockPage symbol="TCS" />
    </QueryClientProvider>,
  );
  return mock;
}

beforeEach(() => {
  search = "tab=chart";
  replace.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("Chart tab", () => {
  it("renders the chart, controls, indicator summary and no 'not built' placeholder", async () => {
    const mock = renderStock({});
    expect(await screen.findByTestId("chart-main")).toBeInTheDocument();
    expect(screen.queryByText(/not built yet/)).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("chart-main")).toHaveAttribute("data-state", "ready"),
    );
    expect(screen.getByTestId("chart-basis")).toHaveTextContent(/excludes dividends/);
    expect(screen.getByTestId("chart-basis")).toHaveTextContent(
      /Nifty 50 compare is not available/,
    );
    expect(await screen.findByTestId("indicator-summary")).toBeInTheDocument();
    expect(screen.getByTestId("read-sma200-value")).toHaveTextContent("insufficient history");
    const call = mock.calls.find(
      (c) => c.path === "/stocks/TCS/prices" && c.query.get("range") === "1Y",
    );
    expect(call?.query.get("adjusted")).toBe("true");
    // overlays and panes are real buttons with test ids and pressed state
    expect(screen.getByTestId("overlay-sma50")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("pane-volume")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("overlay-ema50")).toBeDisabled();
    expect(screen.getByTestId("overlay-unavailable-note")).toHaveTextContent(
      /EMA 50 is not computed/,
    );
  });

  it("UI-10: Show data lists every plotted bar with OHLC columns and a CSV button", async () => {
    const user = userEvent.setup();
    renderStock({});
    const frame = await screen.findByTestId("chart-main");
    await waitFor(() => expect(frame).toHaveAttribute("data-state", "ready"));
    await user.click(within(frame).getByTestId("chart-show-data"));
    const table = within(frame).getByTestId("chart-data-table");
    expect(within(table).getAllByTestId("chart-data-row")).toHaveLength(70);
    expect(table.textContent).toMatch(/Price open \(INR\)/);
    expect(table.textContent).not.toMatch(/NaN|Infinity/);
    expect((within(frame).getByTestId("chart-export-csv") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("range chips, adjusted/raw and log re-request prices with the right query", async () => {
    const user = userEvent.setup();
    const mock = renderStock({});
    const frame = await screen.findByTestId("chart-main");
    await waitFor(() => expect(frame).toHaveAttribute("data-state", "ready"));
    await user.click(within(frame).getByTestId("range-3Y"));
    await waitFor(() =>
      expect(
        mock.calls.some(
          (c) =>
            c.path === "/stocks/TCS/prices" &&
            c.query.get("range") === "3Y" &&
            c.query.get("adjusted") === "true",
        ),
      ).toBe(true),
    );
    await user.click(screen.getByTestId("chart-raw"));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.query.get("adjusted") === "false")).toBe(true),
    );
    expect(await screen.findByTestId("chart-basis")).toHaveTextContent(/Raw prices as imported/);
    expect(screen.getByTestId("overlay-unavailable-note")).toHaveTextContent(/switch to Adjusted/);
    await user.click(screen.getByTestId("chart-log"));
    expect(screen.getByTestId("chart-log")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the weekly-candle notice when the API answers interval 1w", async () => {
    renderStock({ "GET /stocks/TCS/prices": cx.pricesWeekly() });
    expect(await screen.findByTestId("weekly-candle-note")).toHaveTextContent(/one week/);
  });

  it("compare overlay fetches the typed symbol, validates input and reports a missing one", async () => {
    const user = userEvent.setup();
    const mock = renderStock({
      "GET /stocks/INFY/prices": fx.prices(),
      "GET /stocks/NOPE/prices": fail(404, "DATA_UNAVAILABLE", "none", {
        reason: "no_prices_imported",
      }),
    });
    const frame = await screen.findByTestId("chart-main");
    await waitFor(() => expect(frame).toHaveAttribute("data-state", "ready"));
    await user.type(screen.getByTestId("compare-input"), "bad symbol!");
    await user.click(screen.getByTestId("compare-apply"));
    expect(screen.getByTestId("compare-error")).toBeInTheDocument();
    await user.clear(screen.getByTestId("compare-input"));
    await user.type(screen.getByTestId("compare-input"), "infy");
    await user.click(screen.getByTestId("compare-apply"));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.path === "/stocks/INFY/prices")).toBe(true),
    );
    expect(await screen.findByTestId("compare-clear")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getAllByTestId("chart-note").some((n) => /start at 100/.test(n.textContent ?? "")),
      ).toBe(true),
    );
    await user.click(screen.getByTestId("compare-clear"));
    await user.type(screen.getByTestId("compare-input"), "NOPE");
    await user.click(screen.getByTestId("compare-apply"));
    expect(await screen.findByTestId("compare-load-error")).toHaveTextContent(
      /No prices are imported for NOPE/,
    );
  });

  it("price error shows a retry; DATA_UNAVAILABLE shows the reason, not an empty plot", async () => {
    renderStock({ "GET /stocks/TCS/prices": fail(500, "INTERNAL", "boom") });
    const frame = await screen.findByTestId("chart-main");
    await waitFor(() => expect(frame).toHaveAttribute("data-state", "error"));
    expect(within(frame).getByTestId("chart-retry")).toBeInTheDocument();
  });

  it("indicators unavailable: the chart still draws and the summary explains why", async () => {
    renderStock({
      "GET /stocks/TCS/indicators": fail(404, "DATA_UNAVAILABLE", "none", { reason: "no_history" }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("indicator-summary")).toHaveTextContent(
        /fewer than 60 valid price bars/,
      ),
    );
    const frame = screen.getByTestId("chart-main");
    await waitFor(() => expect(frame).toHaveAttribute("data-state", "ready"));
    expect(screen.getAllByTestId("chart-note")[0]).toHaveTextContent(
      /is not shown: the indicator series have not been computed/,
    );
  });

  it("a stock with no prices shows the import prompt in the Chart tab", async () => {
    renderStock({
      "GET /stocks/TCS": fx.profile({
        flags: { no_prices: true, limited_history: false, series_warning: null },
      }),
    });
    expect(await screen.findByTestId("no-prices")).toBeInTheDocument();
  });

  it("API warnings on the chart request are rendered", async () => {
    renderStock({
      "GET /stocks/TCS/prices": fx.prices({}, [
        { code: "ADJUSTMENT_CONFLICT", message: "Mixed adjustment basis for TCS" },
      ]),
    });
    expect(await screen.findByTestId("chart-warning")).toHaveTextContent(
      "Mixed adjustment basis for TCS",
    );
  });
});

describe("Analysis tab (UI-10 for every chart)", () => {
  beforeEach(() => {
    search = "tab=analysis";
  });

  it("renders all six views with a data table or reason each", async () => {
    const user = userEvent.setup();
    renderStock({});
    const ids = ["chart-drawdown", "chart-rolling-vol", "chart-histogram"];
    for (const id of ids) {
      await screen.findByTestId(id);
      await waitFor(() => expect(screen.getByTestId(id)).toHaveAttribute("data-state", "ready"));
      const frame = screen.getByTestId(id);
      await user.click(within(frame).getByTestId("chart-show-data"));
      expect(within(frame).getAllByTestId("chart-data-row").length).toBeGreaterThan(0);
      expect(within(frame).getByTestId("chart-data-table").textContent).not.toMatch(/NaN|Infinity/);
    }
    const hist = screen.getByTestId("chart-histogram");
    expect(within(hist).getAllByTestId("chart-data-row")).toHaveLength(4);
    expect(screen.getByTestId("histogram-note")).toHaveTextContent(/approximate/);

    for (const id of ["heatmap-month-year", "heatmap-calendar"]) {
      const card = await screen.findByTestId(id);
      expect(within(card).getAllByTestId("heat-cell").length).toBeGreaterThan(0);
      await user.click(within(card).getByTestId("heat-show-data"));
      expect(within(card).getAllByTestId("heat-data-row").length).toBeGreaterThan(0);
      expect(within(card).getByTestId("heat-export-csv")).toBeInTheDocument();
    }
    // unknown months stay unknown with a reason, never 0
    const my = screen.getByTestId("heatmap-month-year");
    expect(my.textContent).toMatch(/No month-end close for this month/);
  });

  it("rolling beta without a benchmark shows the honest reason", async () => {
    renderStock({});
    await screen.findByTestId("chart-rolling-beta");
    await waitFor(() =>
      expect(screen.getByTestId("chart-rolling-beta")).toHaveAttribute("data-state", "empty"),
    );
    expect(screen.getByTestId("chart-rolling-beta")).toHaveTextContent(
      /no benchmark data imported/,
    );
  });

  it("missing analysis block: each view says why instead of drawing zeros", async () => {
    renderStock({
      "GET /stocks/TCS/indicators": cx.indicatorsWithSeries(70, { analysis: undefined }),
    });
    await screen.findByTestId("chart-drawdown");
    await waitFor(() =>
      expect(screen.getByTestId("chart-drawdown")).toHaveAttribute("data-state", "empty"),
    );
    expect(screen.getByTestId("chart-drawdown")).toHaveTextContent(/not been computed yet/);
    await waitFor(() =>
      expect(screen.getByTestId("heatmap-month-year")).toHaveTextContent(/not been computed yet/),
    );
  });

  it("no indicators yet: one explanation with the reason", async () => {
    renderStock({
      "GET /stocks/TCS/indicators": fail(404, "DATA_UNAVAILABLE", "none", { reason: "no_history" }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("analysis-tab")).toHaveTextContent(
        /fewer than 60 valid price bars/,
      ),
    );
  });
});
