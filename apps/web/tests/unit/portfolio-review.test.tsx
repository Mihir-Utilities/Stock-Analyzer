import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";
import { fail } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as fx from "../mocks/portfolio-fixtures";
import "./dom-matchers";

// F11 review fixes (docs/OPEN_QUESTIONS.md F11R-1..). Dates are fixed past dates, never "today".

// Page tests mount the whole portfolio screen; under a loaded full run the 5 s default is too tight.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function renderWith(
  routes: Record<string, Handler>,
  fetchWrap?: (real: typeof fetch) => typeof fetch,
) {
  const mock = createMockFetch({
    "GET /portfolio/summary": fx.envelope(fx.summary(), fx.reviewWarnings),
    "GET /portfolio/txns": fx.envelope(fx.txns),
    "GET /portfolio/adjustments": fx.envelope(fx.adjustments),
    "GET /market/holidays": fx.envelope({ year_loaded: false, items: [] }),
    ...routes,
  });
  const real = mock.impl as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchWrap ? fetchWrap(real) : real);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PortfolioPage />
    </QueryClientProvider>,
  );
  return mock;
}

const val = (id: string) => (screen.getByTestId(id) as HTMLInputElement).value;
const posts = <T extends { method: string }>(m: { calls: T[] }) =>
  m.calls.filter((c) => c.method === "POST");

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  v: { side?: string; qty?: string; price?: string; fees?: string; date?: string } = {},
) {
  await user.click(await screen.findByTestId("txn-add"));
  await user.type(screen.getByTestId("txn-symbol"), "TCS");
  if (v.side) await user.selectOptions(screen.getByTestId("txn-side"), v.side);
  await user.type(screen.getByTestId("txn-qty"), v.qty ?? "5");
  await user.type(screen.getByTestId("txn-price"), v.price ?? "4000");
  if (v.fees) await user.type(screen.getByTestId("txn-fees"), v.fees);
  fireEvent.change(screen.getByTestId("txn-date"), { target: { value: v.date ?? "2026-10-23" } });
}

const buy = (id: number, symbol: string, date: string) => ({
  id,
  symbol,
  name: symbol,
  side: "buy",
  qty: "1.0000",
  price: "100.0000",
  fees: "0.0000",
  trade_date: date,
  note: "",
});

describe("F11R transactions list: filters over unloaded pages", () => {
  it("Side=Sell with no sell on page 1 still offers Load more and shows page 2", async () => {
    const user = userEvent.setup();
    const sell = { ...buy(9, "TCS", "2026-03-01"), side: "sell" };
    renderWith({
      "GET /portfolio/txns": (c) =>
        c.query.get("cursor") === "c2"
          ? fx.envelope({ items: [sell], next_cursor: null })
          : fx.envelope({
              items: [buy(12, "INFY", "2026-05-02"), buy(11, "TCS", "2026-05-01")],
              next_cursor: "c2",
            }),
    });
    await screen.findByTestId("txn-table");
    await user.selectOptions(screen.getByTestId("txn-filter-side"), "sell");
    expect(screen.getByTestId("txn-empty")).toHaveTextContent(/No match in the loaded rows yet/);
    await user.click(screen.getByTestId("txn-load-more"));
    expect(await screen.findByTestId("txn-row-9")).toBeInTheDocument();
    expect(screen.queryByTestId("txn-row-12")).toBeNull();
  });

  it("with every page loaded and no match it says no transaction matches", async () => {
    const user = userEvent.setup();
    renderWith({
      "GET /portfolio/txns": fx.envelope({
        items: [buy(1, "TCS", "2026-05-01")],
        next_cursor: null,
      }),
    });
    await screen.findByTestId("txn-table");
    await user.selectOptions(screen.getByTestId("txn-filter-side"), "sell");
    expect(screen.getByTestId("txn-empty")).toHaveTextContent(
      "No transaction matches these filters.",
    );
    expect(screen.queryByTestId("txn-load-more")).toBeNull();
  });

  it("the symbol filter waits for typing to stop before it queries (fake timers)", async () => {
    const mock = renderWith({});
    await screen.findByTestId("txn-table");
    const before = mock.calls.filter(
      (c) => c.method === "GET" && c.path === "/portfolio/txns",
    ).length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const input = screen.getByTestId("txn-filter-symbol");
    for (const v of ["T", "TC", "TCS"]) fireEvent.change(input, { target: { value: v } });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(
      mock.calls.filter((c) => c.method === "GET" && c.path === "/portfolio/txns"),
    ).toHaveLength(before);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();
    await waitFor(() =>
      expect(
        mock.calls.filter(
          (c) =>
            c.method === "GET" && c.path === "/portfolio/txns" && c.query.get("symbol") === "TCS",
        ),
      ).toHaveLength(1),
    );
    const symbols = mock.calls
      .filter((c) => c.method === "GET" && c.path === "/portfolio/txns")
      .map((c) => c.query.get("symbol"));
    expect(symbols).not.toContain("T");
    expect(symbols).not.toContain("TC");
  });
});

describe("F11R summary", () => {
  it("shows the benchmark delta as 'You: +6.3 pts vs Nifty' (fixture 18.4 vs 12.1)", async () => {
    renderWith({});
    expect(await screen.findByText("You: +6.3 pts vs Nifty")).toBeInTheDocument();
    expect(screen.queryByText(/vs yours/)).toBeNull();
  });

  it("more than 8 holdings: the stock links have a Show all control", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 10 }, (_, i) => ({ ...fx.tcs, symbol: `S${i}` }));
    renderWith({ "GET /portfolio/summary": fx.envelope(fx.summary({}, many)) });
    await screen.findByTestId("pf-stock-link-S0");
    expect(screen.queryByTestId("pf-stock-link-S9")).toBeNull();
    await user.click(screen.getByTestId("pf-links-more"));
    expect(screen.getByTestId("pf-stock-link-S9")).toBeInTheDocument();
    expect(screen.getByTestId("pf-links-more")).toHaveTextContent("Show fewer");
  });
});

describe("F11R retry, key and duplicate protection", () => {
  it("key reused after a 5xx with the identical body; an edit gets a new key and a warning", async () => {
    const user = userEvent.setup();
    let n = 0;
    const mock = renderWith({
      "POST /portfolio/txns": () =>
        ++n <= 2
          ? fail(503, "UNAVAILABLE", "Service unavailable")
          : fx.envelope(fx.savedTxn, [], 201),
    });
    await fillForm(user);
    await user.click(screen.getByTestId("txn-save"));
    expect(await screen.findByTestId("txn-error")).toHaveTextContent(
      /Check the list before changing values/,
    );
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(posts(mock)).toHaveLength(2));
    const [a, b] = posts(mock);
    expect(a!.headers.get("Idempotency-Key")).toBe(b!.headers.get("Idempotency-Key"));
    expect(a!.body).toEqual(b!.body);
    await screen.findByTestId("txn-error");
    await user.type(screen.getByTestId("txn-note"), "edited");
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(posts(mock)).toHaveLength(3));
    const c = posts(mock)[2]!;
    expect(c.headers.get("Idempotency-Key")).not.toBe(a!.headers.get("Idempotency-Key"));
    expect(await screen.findByTestId("txn-notice")).toHaveTextContent(
      /changed values after a failed try/,
    );
  });

  it("a lost reply (network error) refetches the transaction list", async () => {
    const user = userEvent.setup();
    const mock = renderWith(
      {},
      (real) => (input, init) =>
        init?.method === "POST" ? Promise.reject(new TypeError("offline")) : real(input, init),
    );
    await screen.findByTestId("txn-table");
    const before = mock.calls.filter(
      (c) => c.method === "GET" && c.path === "/portfolio/txns",
    ).length;
    await fillForm(user);
    await user.click(screen.getByTestId("txn-save"));
    expect(await screen.findByTestId("txn-error")).toHaveTextContent(/Could not reach the server/);
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.method === "GET" && c.path === "/portfolio/txns").length,
      ).toBeGreaterThan(before),
    );
  });

  it("a 5xx reply does not refetch the list (the server did answer)", async () => {
    const user = userEvent.setup();
    const mock = renderWith({
      "POST /portfolio/txns": fail(503, "UNAVAILABLE", "Service unavailable"),
    });
    await screen.findByTestId("txn-table");
    const before = mock.calls.filter(
      (c) => c.method === "GET" && c.path === "/portfolio/txns",
    ).length;
    await fillForm(user);
    await user.click(screen.getByTestId("txn-save"));
    await screen.findByTestId("txn-error");
    expect(
      mock.calls.filter((c) => c.method === "GET" && c.path === "/portfolio/txns"),
    ).toHaveLength(before);
  });

  it("409: shows the specific message and the next press uses a new key", async () => {
    const user = userEvent.setup();
    let n = 0;
    const mock = renderWith({
      "POST /portfolio/txns": () =>
        ++n === 1
          ? fail(503, "UNAVAILABLE", "Service unavailable")
          : n === 2
            ? fail(409, "CONFLICT", "Idempotency-Key reused with a different request")
            : fx.envelope(fx.savedTxn, [], 201),
    });
    await fillForm(user);
    await user.click(screen.getByTestId("txn-save"));
    await screen.findByTestId("txn-error");
    await user.click(screen.getByTestId("txn-save")); // same body, same key -> 409
    await waitFor(() =>
      expect(screen.getByTestId("txn-error")).toHaveTextContent(
        /already holds a request with this key/,
      ),
    );
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(posts(mock)).toHaveLength(3));
    const keys = posts(mock).map((c) => c.headers.get("Idempotency-Key"));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("the server's listing-date 422 is shown on the field and in the error summary", async () => {
    const user = userEvent.setup();
    const msg = "must not be before the listing date 2004-08-25";
    renderWith({
      "POST /portfolio/txns": fail(422, "UNPROCESSABLE", "Validation failed", {
        fields: [{ field: "trade_date", message: msg }],
      }),
    });
    await fillForm(user, { date: "2004-01-02" });
    await user.click(screen.getByTestId("txn-save"));
    expect(await screen.findByTestId("txn-error")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("form-field-error")).toHaveTextContent(msg);
  });
});

describe("F11R edit form", () => {
  it("editing only the note sends {note} and nothing else (unchanged price spelling is not a change)", async () => {
    const user = userEvent.setup();
    const mock = renderWith({
      "PATCH /portfolio/txns/2": fx.envelope({ ...fx.txns.items[1], note: "trimmed" }),
    });
    await user.click(await screen.findByTestId("txn-edit-2"));
    expect(val("txn-price")).toBe("3900");
    expect(val("txn-fees")).toBe("10");
    const note = screen.getByTestId("txn-note");
    await user.clear(note);
    await user.type(note, "trimmed");
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(mock.calls.find((c) => c.method === "PATCH")!.body).toEqual({ note: "trimmed" });
  });

  it("with nothing changed Save is disabled and no request is sent; typing the same value back is no change", async () => {
    const user = userEvent.setup();
    const mock = renderWith({});
    await user.click(await screen.findByTestId("txn-edit-2"));
    expect(screen.getByTestId("txn-save")).toBeDisabled();
    expect(screen.getByTestId("txn-unchanged")).toBeInTheDocument();
    const price = screen.getByTestId("txn-price");
    await user.clear(price);
    await user.type(price, "3900.00");
    expect(screen.getByTestId("txn-save")).toBeDisabled();
    await user.type(price, "5");
    expect((screen.getByTestId("txn-save") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(screen.getByTestId("txn-form"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "PATCH")).toBe(true));
  });
});

describe("F11R focus and announcements", () => {
  it("cancelling an edit returns focus to that row's Edit button and announces it", async () => {
    const user = userEvent.setup();
    renderWith({});
    await user.click(await screen.findByTestId("txn-edit-2"));
    await user.click(screen.getByTestId("txn-cancel"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("txn-edit-2")));
    expect(screen.getByTestId("txn-announce")).toHaveTextContent(
      "Edit cancelled, no changes saved.",
    );
  });

  it("saving an edit returns focus to the Edit button", async () => {
    const user = userEvent.setup();
    renderWith({ "PATCH /portfolio/txns/2": fx.envelope({ ...fx.txns.items[1], note: "x" }) });
    await user.click(await screen.findByTestId("txn-edit-2"));
    await user.type(screen.getByTestId("txn-note"), "x");
    await user.click(screen.getByTestId("txn-save"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("txn-edit-2")));
    expect(screen.getByTestId("txn-announce")).toHaveTextContent("Transaction updated.");
  });

  it("closing the add form returns focus to Add transaction", async () => {
    const user = userEvent.setup();
    renderWith({});
    await user.click(await screen.findByTestId("txn-add"));
    await user.click(screen.getByTestId("txn-cancel"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("txn-add")));
    expect(screen.getByTestId("txn-announce")).toHaveTextContent("Add transaction form closed.");
  });
});

describe("F11R PF-14 in the form: fees raise a buy and cut a sell", () => {
  it("shows cost including fees for a buy and proceeds after fees for a sell", async () => {
    const user = userEvent.setup();
    renderWith({});
    await fillForm(user, { qty: "10", price: "100", fees: "5.5" });
    expect(screen.getByTestId("txn-amount")).toHaveTextContent("Cost including fees: ₹1,005.50");
    await user.selectOptions(screen.getByTestId("txn-side"), "sell");
    expect(screen.getByTestId("txn-amount")).toHaveTextContent("Proceeds after fees: ₹994.50");
  });
});
