import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import { EVENT_SYMBOLS_MAX } from "@/components/dashboard/ActivityCards";
import { DashboardView } from "@/components/dashboard/DashboardView";
import { humanize } from "@/lib/dashboard/labels";
import { expectedLastTradingDate, isOlderThanExpected } from "@/lib/dashboard/state";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";

// Review fixes for F04 (docs/OPEN_QUESTIONS.md, F04R-1..F04R-11).

const ok = (data: unknown, meta: Record<string, unknown> = {}) => ({
  status: 200,
  body: { data, meta, warnings: [] },
});
const fail500 = { status: 500, body: { error: { code: "INTERNAL", message: "x" } } };

const stocks = [
  { id: 1, symbol: "TCS", name: "TCS", ltp: 4012.5, ltp_as_of: "2026-10-23", change_pct: 1.5 },
  { id: 2, symbol: "INFY", name: "Infosys", ltp: 1500, ltp_as_of: "2026-10-23", change_pct: -2.25 },
  { id: 3, symbol: "ITC", name: "ITC", ltp: 400, ltp_as_of: "2026-10-23", change_pct: null },
];

/** `hang`: requests whose URL matches never answer (a slow endpoint); others use the mock. */
function mount(routes: Record<string, Handler>, hang: RegExp | null = null) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    hang && hang.test(String(input))
      ? new Promise<Response>(() => undefined)
      : mock.impl(input, init),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DashboardView />
    </QueryClientProvider>,
  );
  return mock;
}

const portfolioBody = (totals: Record<string, unknown>) => ({
  as_of: "2026-10-23",
  holdings: [{ symbol: "TCS" }],
  totals,
  returns: {},
  allocation_by_sector: [],
  allocation_by_stock: [],
});

const inFiveDays = () => new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("F04 review fixes", () => {
  it("F04R-2: a partial portfolio that is also stale shows the warning and the stale chip", async () => {
    mount({
      "GET /watchlist": ok({ stocks: [], funds: [] }),
      "GET /portfolio/summary": ok(
        portfolioBody({ market_value: null, market_value_reason: "no price for TCS" }),
        { stale: true },
      ),
    });
    const card = await screen.findByTestId("dash-portfolio");
    await waitFor(() => expect(card.dataset.state).toBe("partial"));
    expect(card.textContent).toContain("no price for TCS");
    const chips = within(card)
      .getAllByTestId("asof-chip")
      .map((c) => c.textContent);
    expect(chips.some((t) => t?.includes("(stale)"))).toBe(true);
  });

  it("F04R-2: a partial watchlist with old prices also shows the stale chip", async () => {
    const old = stocks.map((s) => ({ ...s, ltp_as_of: "2026-01-02" }));
    mount({ "GET /watchlist": ok({ stocks: old, funds: [] }) });
    await waitFor(() => expect(screen.getByTestId("dash-watchlist").dataset.state).toBe("partial"));
    const card = screen.getByTestId("dash-watchlist");
    expect(within(card).getByTestId("asof-chip").textContent).toContain("(stale)");
    expect(card.textContent).toContain("1 of 3 stocks have no day change");
  });

  it("F04R-3: a stale-only watchlist has no '0 of N stocks' message", async () => {
    const old = stocks.map((s) => ({ ...s, ltp_as_of: "2026-01-02", change_pct: 1 }));
    mount({ "GET /watchlist": ok({ stocks: old, funds: [] }) });
    await waitFor(() => expect(screen.getAllByTestId("watch-tile")).toHaveLength(3));
    const card = screen.getByTestId("dash-watchlist");
    expect(card.dataset.state).toBe("ready");
    expect(card.textContent).not.toMatch(/0 of 3|have no day change/);
    expect(within(card).getByTestId("asof-chip").textContent).toContain("(stale)");
  });

  it("F04R-4: upcoming events as-of says 'now', not today's date", async () => {
    mount({
      "GET /watchlist": ok({ stocks, funds: [] }),
      "GET /stocks/TCS/events": ok({ calendar: [{ event_date: inFiveDays(), type: "results" }] }),
      "GET /stocks/INFY/events": ok({ calendar: [] }),
      "GET /stocks/ITC/events": ok({ calendar: [] }),
    });
    await waitFor(() => expect(screen.getAllByTestId("timeline-item")).toHaveLength(1));
    const chip = within(screen.getByTestId("dash-events")).getByTestId("asof-chip");
    expect(chip.textContent).toBe("As of now");
  });

  it("F04R-10: events render partially while one symbol is loading, and only the first 10 are asked", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      symbol: `S${i + 1}`,
      name: `S${i + 1}`,
      ltp: 10,
      ltp_as_of: "2026-10-23",
      change_pct: 1,
    }));
    const routes: Record<string, Handler> = { "GET /watchlist": ok({ stocks: many, funds: [] }) };
    for (const s of many) routes[`GET /stocks/${s.symbol}/events`] = ok({ calendar: [] });
    routes["GET /stocks/S1/events"] = ok({ calendar: [{ event_date: inFiveDays(), type: "agm" }] });
    const mock = mount(routes, /\/stocks\/S2\/events/);
    await waitFor(() => expect(screen.getAllByTestId("timeline-item")).toHaveLength(1));
    const card = screen.getByTestId("dash-events");
    expect(card.dataset.state).toBe("partial");
    expect(card.textContent).toContain("1 of 10 stocks are still being checked");
    const paths = mock.calls.map((c) => c.path).filter((p) => /\/stocks\/[^/]+\/events$/.test(p));
    expect(paths.length).toBeLessThanOrEqual(EVENT_SYMBOLS_MAX);
    expect(paths.some((p) => p.includes("/S11/") || p.includes("/S12/"))).toBe(false);
  });

  it("F04R-5: a 500 on watchlist, broker and admin status each shows Retry; retrying refetches", async () => {
    let brokerCalls = 0;
    mount({
      "GET /watchlist": fail500,
      "GET /broker/status": () => {
        brokerCalls += 1;
        return fail500;
      },
      "GET /admin/status": fail500,
    });
    await screen.findByTestId("health-broker-retry");
    expect(screen.getByTestId("health-import-retry")).toBeTruthy();
    expect(screen.getByTestId("health-job-retry")).toBeTruthy();
    const before = brokerCalls;
    fireEvent.click(screen.getByTestId("health-broker-retry"));
    await waitFor(() => expect(brokerCalls).toBeGreaterThan(before));
  });

  it("F04R-6: the broker countdown ticks down each minute without a new request", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const mock = mount({
      "GET /watchlist": ok({ stocks: [], funds: [] }),
      "GET /broker/status": ok({
        enabled: true,
        mode: "broker",
        connected: true,
        minutes_left: 30,
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("health-broker").textContent).toContain("30 min left"),
    );
    const requests = mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(screen.getByTestId("health-broker").textContent).toContain("28 min left");
    expect(mock.calls.length).toBe(requests);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(screen.getByTestId("health-broker").textContent).toContain("0 min left");
  });

  it("F04R-7: in manual mode there is no countdown and no reconnect suggestion", async () => {
    mount({
      "GET /watchlist": ok({ stocks: [], funds: [] }),
      "GET /broker/status": ok({
        enabled: false,
        mode: "manual",
        connected: false,
        needs_reconnect: true,
        minutes_left: 5,
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("health-broker").textContent).toContain("Manual price mode"),
    );
    expect(screen.getByTestId("health-broker").textContent).not.toMatch(/min left|[Rr]econnect/);
    expect(screen.queryByTestId("broker-reconnect")).toBeNull();
    expect(screen.queryByTestId("broker-expired")).toBeNull();
  });

  it("F04R-8: raw API strings are mapped; unknown values are humanised, never snake_case", async () => {
    mount({
      "GET /watchlist": ok({ stocks: [], funds: [] }),
      "GET /alerts/events": ok({
        items: [
          {
            id: 1,
            alert_id: 1,
            kind: "price_above",
            target: { type: "stock", symbol: "TCS" },
            fired_at: "2026-10-23T10:00:00Z",
            delivery_status: "skipped_quiet_hours",
          },
          {
            id: 2,
            alert_id: 2,
            kind: "brand_new_kind",
            target: { type: "stock", symbol: "ITC" },
            fired_at: "2026-10-23T09:00:00Z",
            delivery_status: "weird_state",
          },
        ],
        next_cursor: null,
      }),
      "GET /admin/status": ok({
        jobs: [{ job: "import_prices", status: "half_done", finished_at: null }],
      }),
    });
    await waitFor(() => expect(screen.getAllByTestId("alert-event")).toHaveLength(2));
    const alerts = screen.getByTestId("alert-strip").textContent ?? "";
    expect(alerts).toContain("Price above");
    expect(alerts).toContain("Delivery: Skipped (quiet hours)");
    expect(alerts).toContain("Brand new kind");
    expect(alerts).toContain("Delivery: Weird state");
    await waitFor(() =>
      expect(screen.getByTestId("health-job").textContent).toContain("Import prices: Half done"),
    );
    expect(document.body.textContent).not.toMatch(/[a-z]+_[a-z]+/);
    expect(humanize("")).toBe("Unknown");
    expect(humanize("fooBar-baz")).toBe("Foo bar baz");
  });

  it("F04R-11: the day change delta is signed in text, not by colour only", async () => {
    mount({
      "GET /watchlist": ok({ stocks: [], funds: [] }),
      "GET /portfolio/summary": ok(portfolioBody({ market_value: "1000", day_change: "250.50" })),
    });
    const card = await screen.findByTestId("dash-portfolio");
    await waitFor(() => expect(within(card).getAllByTestId("delta-badge")).toHaveLength(1));
    expect(within(card).getByTestId("delta-badge").textContent).toBe("+₹250.50");
  });

  it("F04R-9: Monday morning IST expects Friday's bar; Monday after 18:00 IST expects Monday", () => {
    const mondayMorning = new Date("2026-10-26T03:30:00Z"); // 09:00 IST
    expect(expectedLastTradingDate(mondayMorning)).toBe("2026-10-23");
    expect(isOlderThanExpected("2026-10-23", mondayMorning)).toBe(false);
    const mondayEvening = new Date("2026-10-26T13:00:00Z"); // 18:30 IST
    expect(expectedLastTradingDate(mondayEvening)).toBe("2026-10-26");
    expect(isOlderThanExpected("2026-10-23", mondayEvening)).toBe(true);
    expect(expectedLastTradingDate(new Date("2026-10-27T04:00:00Z"))).toBe("2026-10-26");
    expect(expectedLastTradingDate(new Date("2026-10-23T13:00:00Z"))).toBe("2026-10-23");
  });
});
