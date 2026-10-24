import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/api/client";
import {
  EMPTY_MATCH_TEXT,
  FUND_DEBOUNCE_MS,
  NO_STOCKS_TEXT,
  SearchPalette,
} from "@/components/search/SearchPalette";
import { RECENT_KEY, memoryIndexStore } from "@/lib/search/store";
import { SAMPLE } from "./search-rank.test";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

type Handler = (url: URL) => { status?: number; body: unknown };

/** Minimal mock of the API: routes by path, wraps bodies in the success envelope. */
function mockApi(handler: Handler) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname + url.search);
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(status === 200 ? { data: body } : body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { request: createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch }), calls };
}

const fundBody = {
  items: [
    {
      code: 120503,
      name: "Axis Bluechip Fund Direct Growth",
      fund_house: "Axis",
      category: "Large Cap",
    },
  ],
  next_cursor: null,
};

const defaultHandler: Handler = (url) => {
  if (url.pathname.endsWith("/stocks/index")) {
    return { body: { generated_at: "2026-10-10T00:00:00Z", count: SAMPLE.length, items: SAMPLE } };
  }
  if (url.pathname.endsWith("/mf/schemes")) {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return { body: q.includes("axis") ? fundBody : { items: [], next_cursor: null } };
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
};

async function openWithKeyboard() {
  await act(async () => {
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  });
}

beforeEach(() => {
  push.mockClear();
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});
afterEach(() => vi.useRealTimers());

async function setup(handler: Handler = defaultHandler) {
  const api = mockApi(handler);
  render(
    <>
      <button data-testid="outside">outside</button>
      <input data-testid="outside-input" />
      <SearchPalette store={memoryIndexStore()} request={api.request} />
    </>,
  );
  await waitFor(() => expect(api.calls.some((c) => c.includes("/stocks/index"))).toBe(true));
  await act(async () => {
    await Promise.resolve();
  });
  return api;
}

describe("SearchPalette: opening and accessibility", () => {
  it("opens with Ctrl+K and Cmd+K, focuses the input and exposes combobox semantics", async () => {
    await setup();
    expect(screen.queryByTestId("search-input")).toBeNull();
    await openWithKeyboard();
    const input = screen.getByTestId("search-input");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    await userEvent.keyboard("{Escape}");
  });

  it("opens with / unless typing in a field", async () => {
    await setup();
    screen.getByTestId("outside-input").focus();
    await userEvent.keyboard("/");
    expect(screen.queryByTestId("search-input")).toBeNull();
    screen.getByTestId("outside").focus();
    await userEvent.keyboard("/");
    expect(screen.getByTestId("search-input")).toBeTruthy();
  });

  it("opens from the trigger button and toggles closed with Ctrl+K again", async () => {
    await setup();
    await userEvent.click(screen.getByTestId("search-trigger"));
    expect(screen.getByTestId("search-input")).toBeTruthy();
    await openWithKeyboard();
    expect(screen.queryByTestId("search-input")).toBeNull();
  });

  it("Close button and Escape (cancel event) close it and return focus to the opener", async () => {
    await setup();
    const trigger = screen.getByTestId("search-trigger");
    trigger.focus();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByTestId("search-close"));
    expect(screen.queryByTestId("search-input")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    screen.getByTestId("outside").focus();
    await userEvent.keyboard("/");
    await act(async () => {
      screen.getByTestId("search-dialog").dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(screen.queryByTestId("search-input")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("outside"));
  });

  it("UI-05: opens within 100 ms once the index is cached", async () => {
    await setup();
    const t0 = performance.now();
    await openWithKeyboard();
    expect(screen.getByTestId("search-input")).toBeTruthy();
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("SearchPalette: results and keyboard navigation", () => {
  it("finds M&M by typing M&M and by typing MM, and BAJAJ-AUTO", async () => {
    await setup();
    await openWithKeyboard();
    const input = screen.getByTestId("search-input");
    await userEvent.type(input, "M&M");
    expect(screen.getByTestId("search-result-stock-M&M")).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "MM");
    expect(screen.getByTestId("search-result-stock-M&M")).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "BAJAJ-AUTO");
    expect(screen.getByTestId("search-result-stock-BAJAJ-AUTO")).toBeTruthy();
  });

  it("moves with arrows (aria-activedescendant, wraps) and opens with Enter", async () => {
    await setup();
    await openWithKeyboard();
    const input = screen.getByTestId("search-input");
    await userEvent.type(input, "TATA");
    const opts = screen.getAllByRole("option");
    expect(opts[0]?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(opts[1]?.id);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(input.getAttribute("aria-activedescendant")).toBe(opts[opts.length - 1]?.id);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(push).toHaveBeenCalledWith("/stocks/TATASTEEL");
    expect(screen.queryByTestId("search-input")).toBeNull();
  });

  it("shows badges for suspended, delisted and ETF rows", async () => {
    await setup();
    await openWithKeyboard();
    await userEvent.type(screen.getByTestId("search-input"), "NIFTYBEES");
    expect(screen.getByTestId("search-badge-etf-reit")).toBeTruthy();
    await userEvent.clear(screen.getByTestId("search-input"));
    await userEvent.type(screen.getByTestId("search-input"), "OLDCO");
    expect(screen.getByTestId("search-badge-delisted")).toBeTruthy();
    await userEvent.clear(screen.getByTestId("search-input"));
    await userEvent.type(screen.getByTestId("search-input"), "HALTCO");
    expect(screen.getByTestId("search-badge-suspended")).toBeTruthy();
  });

  it("shows the exact empty copy when nothing matches", async () => {
    await setup();
    await openWithKeyboard();
    await userEvent.type(screen.getByTestId("search-input"), "QQQQQQ");
    await waitFor(() =>
      expect(screen.getByTestId("search-empty").textContent).toBe(EMPTY_MATCH_TEXT),
    );
  });
});

describe("SearchPalette: funds, recents and states", () => {
  it("debounces fund search by 250 ms and shows a Funds group", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = await setup();
    await openWithKeyboard();
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "axis" } });
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "axis blue" } });
    expect(api.calls.filter((c) => c.includes("/mf/schemes"))).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FUND_DEBOUNCE_MS + 10);
    });
    const fundCalls = api.calls.filter((c) => c.includes("/mf/schemes"));
    expect(fundCalls).toHaveLength(1);
    expect(fundCalls[0]).toContain("q=axis+blue");
    await waitFor(() => expect(screen.getByTestId("search-result-fund-120503")).toBeTruthy());
    expect(screen.getByTestId("search-group-funds")).toBeTruthy();
    await userEvent.click(screen.getByTestId("search-result-fund-120503"));
    expect(push).toHaveBeenCalledWith("/mf/120503");
  });

  it("rejects a malformed fund response (zod) without crashing", async () => {
    const api = await setup((url) =>
      url.pathname.endsWith("/mf/schemes")
        ? { body: { items: [{ code: "not-a-number" }] } }
        : defaultHandler(url),
    );
    expect(api).toBeTruthy();
    await openWithKeyboard();
    await userEvent.type(screen.getByTestId("search-input"), "axis");
    await waitFor(() => expect(screen.getByTestId("search-funds-error")).toBeTruthy());
  });

  it("stores picks as recents (max 8) and lists them for an empty query", async () => {
    await setup();
    await openWithKeyboard();
    await userEvent.type(screen.getByTestId("search-input"), "TCS");
    await userEvent.keyboard("{Enter}");
    expect(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")).toHaveLength(1);
    await openWithKeyboard();
    expect(screen.getByTestId("search-result-stock-TCS")).toBeTruthy();
    expect(screen.getByText("Recent")).toBeTruthy();
  });

  it("empty stock list shows the no-instruments copy with an Import link", async () => {
    await setup((url) =>
      url.pathname.endsWith("/stocks/index")
        ? { body: { generated_at: "g", count: 0, items: [] } }
        : defaultHandler(url),
    );
    await openWithKeyboard();
    expect(screen.getByTestId("search-no-instruments").textContent).toContain(NO_STOCKS_TEXT);
    expect(screen.getByTestId("search-import-link").getAttribute("href")).toBe("/imports");
  });

  it("falls back to server search when the index cannot be loaded", async () => {
    const api = await setup((url) => {
      if (url.pathname.endsWith("/stocks/index")) {
        return { status: 500, body: { error: { code: "INTERNAL", message: "x" } } };
      }
      if (url.pathname.endsWith("/stocks")) {
        return {
          body: {
            items: [
              { id: 1, symbol: "TCS", name: "Tata Consultancy Services Ltd", status: "delisted" },
            ],
          },
        };
      }
      return defaultHandler(url);
    });
    await openWithKeyboard();
    await userEvent.type(screen.getByTestId("search-input"), "TCS");
    await waitFor(() => expect(screen.getByTestId("search-result-stock-TCS")).toBeTruthy());
    expect(screen.getByTestId("search-index-error")).toBeTruthy();
    expect(screen.getByTestId("search-badge-delisted")).toBeTruthy();
    expect(api.calls.some((c) => c.startsWith("/api/v1/stocks?"))).toBe(true);
  });

  it("makes no third-party requests: every call is a same-origin /api/v1 path", async () => {
    const api = await setup();
    await openWithKeyboard();
    await userEvent.type(screen.getByTestId("search-input"), "tata");
    await waitFor(() => expect(api.calls.some((c) => c.includes("/mf/schemes"))).toBe(true));
    expect(api.calls.every((c) => c.startsWith("/api/v1/"))).toBe(true);
  });
});
