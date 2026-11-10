import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as fx from "../mocks/f10-fixtures";
import "./dom-matchers";

const push = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  useSearchParams: () => new URLSearchParams(search),
}));
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

import { ComparePage } from "@/components/compare/ComparePage";

function renderPage(routes: Record<string, Handler> = {}) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ComparePage />
    </QueryClientProvider>,
  );
  return mock;
}

beforeEach(() => {
  search = "";
  push.mockReset();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe("compare input and navigation (CMP-03, shareable URL)", () => {
  it("without symbols it explains and calls nothing", () => {
    const mock = renderPage();
    expect(screen.getByTestId("compare-live")).toHaveTextContent("Enter 2 to 5 stock symbols");
    expect(mock.calls).toHaveLength(0);
    expect(screen.getByTestId("compare-range-1Y")).toBeDisabled();
  });

  it("invalid or one symbol is refused before any request", async () => {
    const user = userEvent.setup();
    const mock = renderPage();
    await user.type(screen.getByTestId("compare-symbols"), "TCS");
    await user.click(screen.getByTestId("compare-submit"));
    expect(await screen.findByTestId("form-field-error")).toHaveTextContent("2 to 5");
    await user.clear(screen.getByTestId("compare-symbols"));
    await user.type(screen.getByTestId("compare-symbols"), "TCS,<b>");
    await user.click(screen.getByTestId("compare-submit"));
    expect(screen.getByTestId("form-field-error")).toHaveTextContent("letters, digits");
    expect(push).not.toHaveBeenCalled();
    expect(mock.calls).toHaveLength(0);
  });

  it("a valid pair goes into the URL encoded, and a range chip keeps the symbols", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByTestId("compare-symbols"), "tcs, m&m");
    await user.click(screen.getByTestId("compare-submit"));
    expect(push).toHaveBeenCalledWith("/compare?symbols=TCS%2CM%26M&range=1Y");
  });

  it("range chips push the new range for the current symbols", async () => {
    search = "symbols=TCS,M%26M&range=3Y";
    const user = userEvent.setup();
    renderPage({ "GET /compare": fx.compare() });
    await screen.findByTestId("compare-result");
    expect(screen.getByTestId("compare-range-3Y").getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByTestId("compare-range-5Y"));
    expect(push).toHaveBeenCalledWith("/compare?symbols=TCS%2CM%26M&range=5Y");
  });
});

describe("compare result (CMP-01, CMP-02, D-R)", () => {
  beforeEach(() => {
    search = "symbols=TCS,M%26M&range=1Y";
  });

  it("requests the encoded symbols and range, draws the rebased chart and the table", async () => {
    const mock = renderPage({ "GET /compare": fx.compare() });
    await screen.findByTestId("compare-chart");
    expect(mock.calls[0]?.path).toBe("/compare");
    expect(mock.calls[0]?.query.get("symbols")).toBe("TCS,M&M");
    expect(mock.calls[0]?.query.get("range")).toBe("1Y");
    expect(screen.getByTestId("legend-s0")).toHaveTextContent("TCS");
    expect(screen.getByTestId("legend-s1")).toHaveTextContent("M&M");
    expect(screen.getByTestId("compare-link-M&M")).toHaveAttribute("href", "/stocks/M%26M");
    expect(screen.getByTestId("compare-row-pe")).toHaveTextContent("P/E (times)");
  });

  it("marks best with a word and a mark, not colour alone; no best where the server sends none", async () => {
    renderPage({ "GET /compare": fx.compare() });
    const pe = await screen.findByTestId("compare-cell-M&M-pe");
    expect(pe.getAttribute("data-best")).toBe("true");
    expect(pe).toHaveTextContent("Best");
    expect(screen.getByTestId("compare-cell-TCS-pe").getAttribute("data-best")).toBe("false");
    expect(screen.getByTestId("compare-cell-TCS-roe")).toHaveTextContent("Best");
    // best null on a tie or missing value, and no key for market cap
    for (const id of ["compare-row-debt_equity", "compare-row-market_cap_cr"]) {
      expect(within(screen.getByTestId(id)).queryByText("Best")).toBeNull();
    }
    expect(screen.getByTestId("compare-best-note")).toHaveTextContent("heuristic");
  });

  it("an unknown metric is a dash with its reason, never 0", async () => {
    renderPage({ "GET /compare": fx.compare() });
    const cell = await screen.findByTestId("compare-cell-TCS-debt_equity");
    expect(cell.textContent).toMatch(/^—/);
    expect(cell.textContent).toMatch(/not available for this stock/);
    expect(cell.textContent).not.toMatch(/\b0\b/);
  });

  it("shows short-history badges, per-stock stamps and highlights stale stocks", async () => {
    renderPage({ "GET /compare": fx.compare({ shortB: true, staleB: true }) });
    expect(await screen.findByTestId("compare-short-M&M")).toHaveTextContent(
      "Short history: 90 price days",
    );
    expect(screen.queryByTestId("compare-short-TCS")).toBeNull();
    expect(screen.getByTestId("compare-stamp-TCS")).toHaveTextContent("20 Oct 2026 (fundamentals)");
    expect(screen.getByTestId("compare-stamp-M&M")).toHaveTextContent(
      "Stale: Fundamentals entered more than 120 days ago",
    );
    expect(screen.getByTestId("compare-col-M&M").getAttribute("data-stale")).toBe("true");
    expect(screen.getByTestId("compare-stale")).toBeTruthy();
  });

  it("a stock without prices keeps its metrics and says why it has no line", async () => {
    search = "symbols=TCS,M%26M,INFY";
    renderPage({ "GET /compare": fx.compare({ noPricesC: true }) });
    const badge = await screen.findByTestId("compare-short-INFY");
    expect(badge).toHaveTextContent("no prices in this range");
    expect(screen.queryByTestId("legend-s2")).toBeNull();
    expect(screen.getByTestId("compare-cell-INFY-pe")).toHaveTextContent("24.30x");
  });

  it("no common dates: 200 with empty dates shows the reason, no chart, the table stays", async () => {
    renderPage({ "GET /compare": fx.compare({ noCommon: true }) });
    const note = await screen.findByTestId("compare-no-common-dates");
    expect(note).toHaveTextContent("no trading date in common");
    expect(screen.queryByTestId("compare-chart")).toBeNull();
    expect(screen.getByTestId("compare-table")).toBeTruthy();
  });

  it("an unknown symbol (404) and a server error show a message, the request id and Retry", async () => {
    renderPage({ "GET /compare": fx.err(404, "NOT_FOUND", "Instrument not found") });
    expect(await screen.findByTestId("compare-error")).toHaveTextContent("not a known stock");
    expect(screen.getByTestId("compare-error")).toHaveTextContent("req-f10");
    expect(screen.getByTestId("compare-retry")).toBeTruthy();
  });

  it("is accessible (axe)", async () => {
    renderPage({ "GET /compare": fx.compare({ shortB: true, staleB: true }) });
    await screen.findByTestId("compare-table");
    const res = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
