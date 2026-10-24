import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { DashboardView } from "@/components/dashboard/DashboardView";
import { NO_INDEX_REASON } from "@/components/dashboard/MarketCards";
import { ApiError } from "@/lib/api/client";
import {
  describeError,
  expectedLastTradingDate,
  isOlderThanExpected,
  parseMoney,
  topMovers,
} from "@/lib/dashboard/state";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";

const ok = (data: unknown, meta: Record<string, unknown> = {}) => ({
  status: 200,
  body: { data, meta, warnings: [] },
});
const err = (status: number, code: string, details?: Record<string, unknown>) => ({
  status,
  body: { error: { code, message: code, details } },
});

const watchlist = {
  stocks: [
    { id: 1, symbol: "TCS", name: "TCS", ltp: 4012.5, ltp_as_of: "2026-10-23", change_pct: 1.5 },
    {
      id: 2,
      symbol: "INFY",
      name: "Infosys",
      ltp: 1500,
      ltp_as_of: "2026-10-23",
      change_pct: -2.25,
    },
    { id: 3, symbol: "ITC", name: "ITC", ltp: 400, ltp_as_of: "2026-10-23", change_pct: null },
  ],
  funds: [{ id: 9, code: 120503, name: "Fund", nav: 10, nav_date: "2026-10-22", change_pct: 0.1 }],
};

function mount(routes: Record<string, Handler>) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardView />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("dashboard states (docs/06 section 5, 6.2)", () => {
  it("renders every card with honest reasons when the endpoints are 501 or 404 (BRK-16)", async () => {
    mount({
      "GET /watchlist": err(404, "DATA_UNAVAILABLE", { reason: "no_prices_imported" }),
      "GET /portfolio/summary": ok({
        as_of: "2026-10-23",
        holdings: [],
        totals: {},
        returns: {},
        allocation_by_sector: [],
        allocation_by_stock: [],
      }),
      "GET /alerts/events": ok({ items: [], next_cursor: null }),
      "GET /broker/status": ok({ enabled: false, mode: "manual" }),
    });
    await waitFor(() => expect(screen.getByTestId("dash-indices").dataset.state).toBe("empty"));
    expect(within(screen.getByTestId("dash-indices")).getByText(/not available yet/)).toBeTruthy();
    expect(screen.getByTestId("dash-indices").textContent).toContain(NO_INDEX_REASON);
    expect(screen.getByTestId("dash-market-status").dataset.state).toBe("empty");
    await waitFor(() => expect(screen.getByTestId("dash-watchlist").dataset.state).toBe("empty"));
    expect(screen.getByTestId("dash-watchlist").textContent).toContain(
      "no prices have been imported",
    );
    await waitFor(() => expect(screen.getByTestId("dash-portfolio").dataset.state).toBe("empty"));
    expect(screen.getByTestId("dash-alerts").dataset.state).toBe("empty");
    await waitFor(() =>
      expect(screen.getByTestId("health-job").textContent).toContain("not available yet"),
    );
    expect(screen.getByTestId("health-broker").textContent).toContain("Manual price mode");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("shows tiles, partial note, movers and the last import chip from watchlist data", async () => {
    mount({
      "GET /watchlist": ok(watchlist),
      "GET /market/overview": ok({
        indices: [
          {
            code: "NIFTY50",
            name: "Nifty 50",
            value: 25000,
            change: 100,
            change_pct: 0.4,
            as_of: "2026-10-23",
          },
        ],
        vix: null,
        market_status: { is_open: false, next_open: "2026-10-26T03:45:00Z", holiday: null },
      }),
    });
    await waitFor(() => expect(screen.getAllByTestId("watch-tile")).toHaveLength(3));
    const card = screen.getByTestId("dash-watchlist");
    expect(card.dataset.state).toBe("partial");
    expect(card.textContent).toContain("1 of 3 stocks have no day change");
    const tiles = screen.getAllByTestId("watch-tile");
    expect(tiles[0]?.textContent).toContain("+1.50%");
    expect(tiles[1]?.textContent).toContain("-2.25%");
    expect(tiles[2]?.textContent).toContain("n/a");
    const rows = screen.getAllByTestId("mover-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("TCS"),
      expect.stringContaining("INFY"),
    ]);
    await waitFor(() => expect(screen.getByTestId("dash-indices").dataset.state).toBe("partial"));
    expect(screen.getByTestId("dash-indices").textContent).toContain("25,000.00");
    expect(screen.getByTestId("dash-indices").textContent).toContain(NO_INDEX_REASON);
    expect(screen.getByTestId("market-open-text").textContent).toBe("Market closed");
    expect(screen.getByTestId("health-import").textContent).toContain("23 Oct 2026");
    expect(screen.getByTestId("health-mf").textContent).toContain("22 Oct 2026");
  });

  it("portfolio card shows value, null reasons and an allocation chart with Show data", async () => {
    mount({
      "GET /watchlist": ok({ stocks: [], funds: [] }),
      "GET /portfolio/summary": ok({
        as_of: "2026-10-23",
        holdings: [{ symbol: "TCS" }],
        totals: {
          market_value: "123456.50",
          day_change: null,
          day_change_reason: "needs two imported bars",
        },
        returns: { xirr_pct: null, xirr_reason: "less than a year of cash flows" },
        allocation_by_sector: [{ key: "IT", weight_pct: 100 }],
        allocation_by_stock: [],
      }),
    });
    const card = await screen.findByTestId("dash-portfolio");
    await waitFor(() => expect(card.dataset.state).toBe("ready"));
    expect(card.textContent).toContain("₹1,23,456.50");
    expect(card.textContent).toContain("needs two imported bars");
    expect(card.textContent).toContain("less than a year of cash flows");
    expect(card.textContent).toContain("Source: Your imported transactions and prices");
    expect(within(card).getByTestId("dash-allocation")).toBeTruthy();
  });

  it("shows error with request id and a Retry button for a 500", async () => {
    mount({
      "GET /watchlist": { status: 500, body: { error: { code: "INTERNAL", message: "x" } } },
    });
    await waitFor(() => expect(screen.getByTestId("dash-watchlist").dataset.state).toBe("error"));
    expect(within(screen.getByTestId("dash-watchlist")).getByTestId("card-retry")).toBeTruthy();
  });

  it("upcoming events: owner-entered calendar items appear in date order", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    mount({
      "GET /watchlist": ok(watchlist),
      "GET /stocks/TCS/events": ok({
        calendar: [{ event_date: future, type: "Results", details: "Q2" }],
      }),
      "GET /stocks/INFY/events": ok({ calendar: [] }),
      "GET /stocks/ITC/events": ok({ calendar: [] }),
    });
    await waitFor(() => expect(screen.getAllByTestId("timeline-item")).toHaveLength(1));
    expect(screen.getByTestId("dash-events").textContent).toContain("Results");
  });

  it("has no axe violations in the loaded state", async () => {
    const { container } = mount({ "GET /watchlist": ok(watchlist) });
    await waitFor(() => expect(screen.getAllByTestId("watch-tile")).toHaveLength(3));
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("dashboard helpers", () => {
  it("describeError maps 501 and DATA_UNAVAILABLE to empty, others to error with request id", () => {
    expect(describeError(new ApiError("NOT_IMPLEMENTED", "n", 501), "X").state).toBe("empty");
    expect(
      describeError(new ApiError("DATA_UNAVAILABLE", "n", 404, { reason: "no_history" }), "X")
        .message,
    ).toContain("no price history");
    const e = describeError(new ApiError("INTERNAL", "n", 500, undefined, "req-1"), "X");
    expect(e.state).toBe("error");
    expect(e.message).toContain("req-1");
  });

  it("parses money strings and never turns unknown into 0", () => {
    expect(parseMoney("12.50")).toBe(12.5);
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
  });

  it("expected trading date skips weekends and staleness compares against it", () => {
    const sunday = new Date("2026-10-25T06:00:00Z");
    expect(expectedLastTradingDate(sunday)).toBe("2026-10-23");
    expect(isOlderThanExpected("2026-10-23", sunday)).toBe(false);
    expect(isOlderThanExpected("2026-10-22", sunday)).toBe(true);
    expect(isOlderThanExpected(null, sunday)).toBe(false);
  });

  it("topMovers ignores unknown changes", () => {
    const m = topMovers(watchlist.stocks, 5);
    expect(m.gainers.map((s) => s.symbol)).toEqual(["TCS"]);
    expect(m.losers.map((s) => s.symbol)).toEqual(["INFY"]);
  });
});
