import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockReply } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import "./dom-matchers";

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
vi.mock("@/components/shell/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import NotFound from "@/app/not-found";
import { StocksBrowse } from "@/components/stocks/StocksBrowse";

function row(id: number, symbol: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    symbol,
    name: `${symbol} Ltd`,
    isin: null,
    series: "EQ",
    sector: "Energy",
    industry: null,
    company_type: null,
    status: "active",
    instrument_kind: "equity",
    tracked: true,
    ...extra,
  };
}
const page = (items: unknown[], next: string | null = null): MockReply => ({
  status: 200,
  body: { data: { items, next_cursor: next }, meta: {}, warnings: [] },
});

function renderBrowse(routes: Record<string, Handler>) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StocksBrowse />
    </QueryClientProvider>,
  );
  return mock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("stocks browse (docs/06 6.3; UI-95)", () => {
  it("lists rows with encoded links, list-only fields and no per-row calls", async () => {
    const mock = renderBrowse({
      "GET /stocks": page([
        row(1, "RELIANCE"),
        row(2, "M&M", { sector: null, tracked: false, status: "suspended" }),
      ]),
    });
    const link = await screen.findByTestId("stocks-link-M&M");
    expect(link).toHaveAttribute("href", "/stocks/M%26M");
    const reliance = screen.getByTestId("stocks-row-RELIANCE");
    expect(reliance).toHaveTextContent("Energy");
    expect(reliance).toHaveTextContent("Tracked");
    const mm = screen.getByTestId("stocks-row-M&M");
    expect(mm).toHaveTextContent("sector not known");
    expect(mm).toHaveTextContent("Not tracked: import prices to see history");
    expect(mm).toHaveTextContent("Status: suspended");
    expect(screen.getByTestId("stocks-unavailable-note")).toHaveTextContent("Screener");
    expect(screen.getByTestId("stocks-go-screener")).toHaveAttribute("href", "/screener");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.path).toBe("/stocks");
    expect(mock.calls[0]?.query.get("kind")).toBe("equity");
    expect(mock.calls[0]?.query.has("q")).toBe(false);
  });

  it("debounces the search into one request with q", async () => {
    const user = userEvent.setup();
    const mock = renderBrowse({ "GET /stocks": page([row(1, "TCS")]) });
    await screen.findByTestId("stocks-row-TCS");
    await user.type(screen.getByTestId("stocks-q"), "tcs");
    await waitFor(() => expect(mock.calls.some((c) => c.query.get("q") === "tcs")).toBe(true));
    expect(mock.calls.filter((c) => c.query.has("q"))).toHaveLength(1);
  });

  it("pages with Load more and keeps loaded rows when the next page fails", async () => {
    const user = userEvent.setup();
    let n = 0;
    renderBrowse({
      "GET /stocks": (call) => {
        n += 1;
        if (!call.query.has("cursor")) return page([row(1, "AAA")], "c1");
        if (n === 2) return { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } };
        return page([row(2, "BBB")]);
      },
    });
    await screen.findByTestId("stocks-row-AAA");
    await user.click(screen.getByTestId("stocks-more"));
    expect(await screen.findByTestId("stocks-more-error")).toBeInTheDocument();
    expect(screen.getByTestId("stocks-row-AAA")).toBeInTheDocument();
    await user.click(screen.getByTestId("stocks-more"));
    expect(await screen.findByTestId("stocks-row-BBB")).toBeInTheDocument();
    expect(screen.getByTestId("stocks-row-AAA")).toBeInTheDocument();
    expect(screen.queryByTestId("stocks-more")).toBeNull();
  });

  it("shows the empty state with a link to Imports when there are no instruments", async () => {
    renderBrowse({ "GET /stocks": page([]) });
    const empty = await screen.findByTestId("empty-state");
    expect(empty).toHaveTextContent("No stocks yet");
    expect(within(empty).getByTestId("stocks-go-imports")).toHaveAttribute("href", "/imports");
  });

  it("shows an error with request id and Retry", async () => {
    const user = userEvent.setup();
    let fail = true;
    renderBrowse({
      "GET /stocks": () =>
        fail
          ? {
              status: 500,
              headers: { "X-Request-Id": "req-77" },
              body: { error: { code: "INTERNAL", message: "boom" } },
            }
          : page([row(1, "INFY")]),
    });
    expect(await screen.findByTestId("stocks-error")).toHaveTextContent("req-77");
    fail = false;
    await user.click(screen.getByTestId("stocks-retry"));
    expect(await screen.findByTestId("stocks-row-INFY")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    renderBrowse({ "GET /stocks": page([row(1, "INFY")]) });
    await screen.findByTestId("stocks-row-INFY");
    const res = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("compare selection on the browse list (F10-d)", () => {
  it("needs 2 to 5 ticks, links with encoded symbols and makes no per-row request", async () => {
    const user = userEvent.setup();
    const mock = renderBrowse({
      "GET /stocks": page([
        row(1, "TCS"),
        row(2, "M&M"),
        row(3, "A"),
        row(4, "B"),
        row(5, "C"),
        row(6, "D"),
      ]),
    });
    await screen.findByTestId("stocks-row-TCS");
    const go = screen.getByTestId("stocks-compare-go");
    expect(go).toBeDisabled();
    expect(go.getAttribute("aria-describedby")).toBe("stocks-compare-hint");
    await user.click(screen.getByTestId("stocks-select-TCS"));
    expect(screen.getByTestId("stocks-compare-go")).toBeDisabled();
    await user.click(screen.getByTestId("stocks-select-M&M"));
    expect(screen.getByTestId("stocks-compare-go")).toHaveAttribute(
      "href",
      "/compare?symbols=TCS%2CM%26M",
    );
    for (const s of ["A", "B", "C"]) await user.click(screen.getByTestId(`stocks-select-${s}`));
    expect(screen.getByTestId("stocks-select-D")).toBeDisabled();
    expect(screen.getByTestId("stocks-compare-hint")).toHaveTextContent("5 selected");
    await user.click(screen.getByTestId("stocks-compare-clear"));
    expect(screen.getByTestId("stocks-compare-go")).toBeDisabled();
    expect(mock.calls).toHaveLength(1);
  });
});

// The admin status screen now reads GET /admin/status; its 501 state is tested in admin-status.test.tsx.
describe("not-found (UI-96)", () => {
  it("not-found keeps its testids and adds a Stocks link", () => {
    render(<NotFound />);
    expect(screen.getByTestId("not-found-title")).toHaveTextContent("Page not found");
    expect(screen.getByTestId("not-found-home")).toHaveAttribute("href", "/");
    expect(screen.getByTestId("not-found-stocks")).toHaveAttribute("href", "/stocks");
  });
});
