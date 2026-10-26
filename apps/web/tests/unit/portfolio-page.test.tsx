import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";
import { WatchlistPage } from "@/components/portfolio/WatchlistPage";
import { fail } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as fx from "../mocks/portfolio-fixtures";
import "./dom-matchers";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function renderWith(ui: React.ReactElement, routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /portfolio/summary": fx.envelope(fx.summary(), fx.reviewWarnings),
    "GET /portfolio/txns": fx.envelope(fx.txns),
    "GET /portfolio/adjustments": fx.envelope(fx.adjustments),
    "GET /market/holidays": fx.envelope({ year_loaded: false, items: [] }),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return mock;
}

const val = (id: string) => (screen.getByTestId(id) as HTMLInputElement).value;

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  v: { symbol?: string; side?: string; qty?: string; price?: string; date?: string } = {},
) {
  await user.click(await screen.findByTestId("txn-add"));
  await user.type(screen.getByTestId("txn-symbol"), v.symbol ?? "TCS");
  if (v.side) await user.selectOptions(screen.getByTestId("txn-side"), v.side);
  await user.type(screen.getByTestId("txn-qty"), v.qty ?? "5");
  await user.type(screen.getByTestId("txn-price"), v.price ?? "4000");
  fireEvent.change(screen.getByTestId("txn-date"), { target: { value: v.date ?? "2026-10-23" } });
}

describe("PF-01/PF-09 summary, honesty and warnings", () => {
  it("shows every summary card with unit, source and as-of, signed P&L and the manual-mode note", async () => {
    renderWith(<PortfolioPage />, {});
    await waitFor(() => expect(screen.getAllByTestId("stat")).toHaveLength(7));
    const card = screen.getByTestId("pf-summary");
    const text = card.textContent ?? "";
    expect(text).toContain("₹45,000.00"); // invested
    expect(text).toContain("₹50,000.00"); // value
    expect(text).toContain("+₹5,000.00"); // unrealized with sign
    expect(text).toContain("+₹1,234.50"); // realized
    expect(text).toContain("18.40%");
    expect(text).toContain("12.10% Nifty 50 XIRR");
    expect(text).toContain("Source: Your transactions and imported prices");
    expect(text).toMatch(/As of 24 Oct 2026/);
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
    expect(screen.getByTestId("pf-manual-note")).toHaveTextContent(/not a live quote/);
    expect(screen.getByTestId("pf-ltp-note")).toHaveTextContent(/latest valid close/);
  });

  it("REVIEW_NEEDED and UNCONFIRMED_ACTION banners use honest wording", async () => {
    renderWith(<PortfolioPage />, {});
    const review = await screen.findByTestId("pf-warning-REVIEW_NEEDED");
    expect(review).toHaveTextContent(/Review needed:.*not applied automatically/);
    expect(screen.getByTestId("pf-warning-UNCONFIRMED_ACTION")).toHaveTextContent(
      /Unconfirmed corporate action:.*not yet confirmed/,
    );
  });

  it("PF-09: a bonus applied to quantity leaves the value unchanged and is shown in Notes", async () => {
    renderWith(<PortfolioPage />, {});
    const table = await screen.findByRole("grid", { name: "Holdings" });
    const row = within(table).getByText("INFY").closest("tr")!;
    const cells = row.textContent ?? "";
    expect(cells).toContain("20"); // quantity adjusted from 10
    expect(cells).toContain("₹500.00"); // average cost halved
    expect(cells).toContain("₹10,000.00"); // value invariant
    expect(cells).toContain("bonus 1 Aug 2026 x2.00000000 applied");
    expect(cells).toContain("price converted to current units for a later split or bonus");
    // day change is unknown with a reason, never 0
    expect(cells).toContain("a split or bonus lies between the last two closes");
  });

  it("unknown values are a dash with a reason, never 0, NaN or Infinity (PF-20, PF-07)", async () => {
    const unknown = fx.summary({
      totals: {
        invested: "45000.0000",
        market_value: null,
        market_value_reason: "no_price",
        unrealized_pnl: null,
        unrealized_pct: null,
        realized_pnl: "0.0000",
        day_change: null,
        day_change_reason: "no_previous_close",
      },
      returns: {
        xirr_pct: null,
        xirr_reason: "period_too_short",
        absolute_return_pct: null,
        absolute_return_basis: "open_holdings",
      },
      benchmark: {
        code: "NIFTY50",
        xirr_pct: null,
        reason: "benchmark_unavailable",
        level_as_of: null,
        note: null,
      },
    });
    renderWith(<PortfolioPage />, {
      "GET /portfolio/summary": fx.envelope(unknown, [
        {
          code: "MISSING_PRICE",
          message: "No imported price for TCS; totals that need it are unavailable",
        },
      ]),
    });
    await waitFor(() => expect(screen.getAllByTestId("stat-null").length).toBeGreaterThan(3));
    const card = screen.getByTestId("pf-summary");
    const nulls = within(card)
      .getAllByTestId("stat-null")
      .map((n) => n.textContent ?? "");
    expect(nulls.some((t) => /no valid close has been imported/.test(t))).toBe(true);
    expect(nulls.some((t) => /period is under 30 days/.test(t))).toBe(true);
    expect(nulls.some((t) => /no Nifty 50 series/.test(t))).toBe(true);
    expect(card.textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.getByTestId("pf-warning-MISSING_PRICE")).toBeInTheDocument();
  });

  it("PF-08: fully sold positions are hidden by default; the toggle asks for them and realized stays in the totals", async () => {
    const mock = renderWith(<PortfolioPage />, {
      "GET /portfolio/summary": (call) =>
        call.query.get("include_exited") === "true"
          ? fx.envelope(fx.withExited())
          : fx.envelope(fx.summary()),
    });
    const table = await screen.findByRole("grid", { name: "Holdings" });
    expect(within(table).queryByText("WIPRO")).toBeNull();
    expect(
      mock.calls.find((c) => c.path === "/portfolio/summary")?.query.get("include_exited"),
    ).toBe("false");
    expect(screen.getByTestId("pf-ltp-note")).toHaveTextContent(/realized P&L \(\+₹1,234\.50\)/);
    await userEvent.setup().click(screen.getByTestId("pf-show-exited"));
    const t2 = await within(screen.getByRole("grid", { name: "Holdings" })).findByText("WIPRO");
    expect(t2.closest("tr")?.textContent).toContain("fully sold");
    expect(mock.calls.some((c) => c.query.get("include_exited") === "true")).toBe(true);
  });

  it("an API failure shows a card error with retry, not fake numbers", async () => {
    renderWith(<PortfolioPage />, {
      "GET /portfolio/summary": fail(500, "INTERNAL", "boom"),
    });
    const card = await screen.findByTestId("pf-summary");
    await waitFor(() => expect(card).toHaveTextContent(/could not be loaded/));
    expect(screen.getByTestId("card-retry")).toBeInTheDocument();
  });

  it("allocation, contribution and breakdown charts and the unavailable growth card are present", async () => {
    renderWith(<PortfolioPage />, {});
    expect(await screen.findByTestId("pf-chart-sector")).toBeInTheDocument();
    expect(screen.getByTestId("pf-chart-stock")).toBeInTheDocument();
    expect(screen.getByTestId("pf-chart-contribution")).toBeInTheDocument();
    expect(screen.getByTestId("pf-chart-breakdown")).toBeInTheDocument();
    expect(screen.getByTestId("pf-chart-growth-unavailable")).toHaveTextContent(
      /Not available yet/,
    );
    expect(screen.getByTestId("pf-dividends")).toHaveTextContent(/estimated/i);
    expect(screen.getByTestId("pf-dividends")).toHaveTextContent(/not included in XIRR/);
  });
});

describe("adjustments panel", () => {
  it("shows badges per source, review banner, a disabled remove with a reason, and posts an override", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<PortfolioPage />, {
      "POST /portfolio/adjustments": fx.envelope(
        { ...fx.adjustments.items[0], source: "override" },
        [],
        201,
      ),
    });
    const list = await screen.findByTestId("adj-list");
    const badges = within(list)
      .getAllByTestId("adj-badge")
      .map((b) => b.textContent);
    expect(badges).toEqual([
      "Confirmed action, applied",
      "Review needed: confirmed but not applied",
      "Unconfirmed: detected, not applied",
    ]);
    expect(screen.getByTestId("adj-remove")).toBeDisabled();
    expect(screen.getByText(/Removing an override is not available yet/)).toBeInTheDocument();
    expect(screen.getByTestId("adj-review-banner")).toHaveTextContent(
      /not applied to your quantities/,
    );

    await user.type(screen.getByTestId("adj-symbol"), "tcs");
    fireEvent.change(screen.getByTestId("adj-date"), { target: { value: "2026-09-01" } });
    await user.type(screen.getByTestId("adj-mult"), "1.5");
    await user.click(screen.getByTestId("adj-save"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "POST")).toBe(true));
    const post = mock.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      symbol: "TCS",
      effective_date: "2026-09-01",
      qty_multiplier: "1.5",
    });
    expect(post.headers.get("X-Requested-With")).toBe("fetch");
  });

  it("an override the server rejects shows the server message", async () => {
    const user = userEvent.setup();
    renderWith(<PortfolioPage />, {
      "POST /portfolio/adjustments": fail(
        422,
        "INSUFFICIENT_HOLDINGS",
        "The override on 2026-09-01 would make a stored sell exceed the quantity held on its date",
        {
          transaction_id: 2,
          date: "2026-09-02",
          held_qty: "1.0000",
          sell_qty: "2.0000",
          adjustment_date: "2026-09-01",
        },
      ),
    });
    await screen.findByTestId("adj-list");
    await user.type(screen.getByTestId("adj-symbol"), "TCS");
    fireEvent.change(screen.getByTestId("adj-date"), { target: { value: "2026-09-01" } });
    await user.type(screen.getByTestId("adj-mult"), "0.5");
    await user.click(screen.getByTestId("adj-save"));
    expect(await screen.findByTestId("adj-error")).toHaveTextContent(
      /would make a stored sell exceed/,
    );
  });
});

describe("transactions list", () => {
  it("lists transactions with exact amounts and filters by side", async () => {
    const user = userEvent.setup();
    renderWith(<PortfolioPage />, {});
    const table = await screen.findByTestId("txn-table");
    expect(table.textContent).toContain("₹42,000.10"); // 12 x 3500 + 0.1 fees
    expect(table.textContent).toContain("₹7,790.00"); // sell 2 x 3900 - 10 fees
    await user.selectOptions(screen.getByTestId("txn-filter-side"), "sell");
    expect(within(screen.getByTestId("txn-table")).queryByText("INFY")).toBeNull();
    expect(screen.getByTestId("txn-row-2")).toBeInTheDocument();
  });

  it("delete asks for confirmation, calls DELETE, and shows the server refusal text", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<PortfolioPage />, {
      "DELETE /portfolio/txns/1": fail(
        422,
        "INSUFFICIENT_HOLDINGS",
        "A sell would exceed the quantity held on its date",
        {
          transaction_id: 2,
          date: "2026-04-01",
          held_qty: "0.0000",
          sell_qty: "2.0000",
        },
      ),
    });
    await user.click(await screen.findByTestId("txn-delete-1"));
    await user.click(screen.getByTestId("confirm-ok"));
    expect(await screen.findByTestId("txn-delete-error")).toHaveTextContent(
      /exceed the quantity held/,
    );
    expect(mock.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});

describe("transaction form", () => {
  it("PF-01: an oversell is shown with the server's detail and focus moves to the error", async () => {
    const user = userEvent.setup();
    renderWith(<PortfolioPage />, {
      "POST /portfolio/txns": fail(
        422,
        "INSUFFICIENT_HOLDINGS",
        "A sell would exceed the quantity held on its date",
        {
          transaction_id: 0,
          date: "2026-10-23",
          held_qty: "10.0000",
          sell_qty: "15.0000",
        },
      ),
    });
    await fillForm(user, { side: "sell", qty: "15" });
    await user.click(screen.getByTestId("txn-save"));
    const err = await screen.findByTestId("txn-error");
    expect(err).toHaveTextContent(/A sell would exceed the quantity held on its date/);
    expect(err).toHaveTextContent(/you hold 10 shares and the sell is for 15/);
    await waitFor(() => expect(document.activeElement).toBe(err.parentElement));
  });

  it("explains the same-day semantics in help text", async () => {
    const user = userEvent.setup();
    renderWith(<PortfolioPage />, {});
    await user.click(await screen.findByTestId("txn-add"));
    expect(screen.getByTestId("txn-help")).toHaveTextContent(/buys are counted before sells/);
  });

  it("PF-06: a weekend date warns but can still be saved", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<PortfolioPage />, {
      "POST /portfolio/txns": fx.envelope(
        fx.savedTxn,
        [
          {
            code: "NON_TRADING_DAY",
            message: "24 Oct 2026 was a weekend or listed market holiday",
          },
        ],
        201,
      ),
    });
    await fillForm(user, { date: "2026-10-24" });
    expect(screen.getByTestId("txn-nontrading-warning")).toHaveTextContent(/weekend/);
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "POST")).toBe(true));
    expect(await screen.findByTestId("txn-notice")).toHaveTextContent(
      /weekend or listed market holiday/,
    );
  });

  it("sends the amounts as strings with an Idempotency-Key and the CSRF header (PF-11, PF-12)", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<PortfolioPage />, {
      "POST /portfolio/txns": fx.envelope(fx.savedTxn, [], 201),
    });
    await fillForm(user, { qty: "0.1", price: "0.2" });
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "POST")).toBe(true));
    const post = mock.calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      qty: "0.1",
      price: "0.2",
      fees: "0",
      trade_date: "2026-10-23",
    });
    expect(typeof (post.body as { qty: unknown }).qty).toBe("string");
    expect(post.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.headers.get("X-Requested-With")).toBe("fetch");
  });

  it("retry after a network failure reuses the key; a changed value or a new transaction gets a new one", async () => {
    const user = userEvent.setup();
    let n = 0;
    const mock = renderWith(<PortfolioPage />, {
      "POST /portfolio/txns": () =>
        ++n === 1
          ? fail(503, "UNAVAILABLE", "Service unavailable")
          : fx.envelope(fx.savedTxn, [], 201),
    });
    await fillForm(user);
    await user.click(screen.getByTestId("txn-save"));
    expect(await screen.findByTestId("txn-error")).toHaveTextContent(/same request key is reused/);
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const keys = mock.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.headers.get("Idempotency-Key"));
    expect(keys[0]).toBe(keys[1]);
    // success cleared the attempt: the next transaction gets a fresh key
    await waitFor(() => expect(val("txn-qty")).toBe(""));
    await user.type(screen.getByTestId("txn-symbol"), "TCS");
    await user.type(screen.getByTestId("txn-qty"), "5");
    await user.type(screen.getByTestId("txn-price"), "4000");
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(3));
    const third = mock.calls.filter((c) => c.method === "POST")[2]!.headers.get("Idempotency-Key");
    expect(third).not.toBe(keys[0]);
  });

  it("a double click sends exactly one request (single flight)", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<PortfolioPage />, {
      "POST /portfolio/txns": fx.envelope(fx.savedTxn, [], 201),
    });
    await fillForm(user);
    const save = screen.getByTestId("txn-save");
    await user.dblClick(save);
    await waitFor(() => expect(mock.calls.some((c) => c.method === "POST")).toBe(true));
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("client validation blocks bad input without calling the API and shows field errors", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<PortfolioPage />, {});
    await user.click(await screen.findByTestId("txn-add"));
    await user.type(screen.getByTestId("txn-qty"), "1e3");
    await user.click(screen.getByTestId("txn-save"));
    expect((await screen.findAllByTestId("form-field-error")).length).toBeGreaterThanOrEqual(3);
    expect(mock.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("edit sends only the changed fields with PATCH", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<PortfolioPage />, {
      "PATCH /portfolio/txns/2": fx.envelope({ ...fx.txns.items[1], qty: "1.0000" }),
    });
    await user.click(await screen.findByTestId("txn-edit-2"));
    const qtyInput = screen.getByTestId("txn-qty");
    expect((qtyInput as HTMLInputElement).value).toBe("2");
    await user.clear(qtyInput);
    await user.type(qtyInput, "1");
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(mock.calls.find((c) => c.method === "PATCH")!.body).toEqual({ qty: "1" });
  });
});

describe("watchlist", () => {
  it("lists stocks with close, an unknown change with its reason, and removes with confirmation", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<WatchlistPage />, {
      "GET /watchlist": fx.envelope(fx.watchlist),
      "DELETE /watchlist/5": fx.envelope({ id: 5, deleted: true }),
    });
    const tcs = await screen.findByTestId("watch-stock-TCS");
    expect(tcs.textContent).toContain("₹4,000.00");
    expect(tcs.textContent).toContain("+1.25%");
    const infy = screen.getByTestId("watch-stock-INFY");
    expect(infy.textContent).toContain("—");
    expect(infy.textContent).toContain("no valid close has been imported");
    await user.click(screen.getByTestId("watch-remove-INFY"));
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("adds a stock; a duplicate shows the server message; a note is patched", async () => {
    const user = userEvent.setup();
    let dup = true;
    const mock = renderWith(<WatchlistPage />, {
      "GET /watchlist": fx.envelope(fx.watchlist),
      "POST /watchlist": () =>
        dup
          ? fail(409, "CONFLICT", "TCS is already on the watchlist")
          : fx.envelope(
              { id: 9, type: "stock", symbol: "WIPRO", name: "Wipro", note: "" },
              [],
              201,
            ),
      "PATCH /watchlist/4": fx.envelope({
        id: 4,
        type: "stock",
        symbol: "TCS",
        name: "TCS",
        note: "x",
      }),
    });
    await screen.findByTestId("watch-stock-TCS");
    await user.type(screen.getByTestId("watch-symbol"), "tcs");
    await user.click(screen.getByTestId("watch-add"));
    expect(await screen.findByTestId("form-field-error")).toHaveTextContent(
      /already on the watchlist/,
    );
    dup = false;
    await user.clear(screen.getByTestId("watch-symbol"));
    await user.type(screen.getByTestId("watch-symbol"), "wipro");
    await user.click(screen.getByTestId("watch-add"));
    await waitFor(() => expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(mock.calls.filter((c) => c.method === "POST")[1]!.body).toEqual({
      type: "stock",
      symbol: "WIPRO",
      note: "",
    });
    await user.type(screen.getByTestId("watch-note-4"), "!");
    await user.click(screen.getByTestId("watch-note-save-4"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(mock.calls.find((c) => c.method === "PATCH")!.body).toEqual({ note: "core!" });
  });
});
