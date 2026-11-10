import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as fx from "../mocks/f10-fixtures";
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
const download = vi.fn();
vi.mock("@/components/ui/csv", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/csv")>()),
  downloadCsv: (csv: string, name: string) => download(csv, name),
}));

import { ScreenerPage } from "@/components/screener/ScreenerPage";

// jsdom has no <dialog> showModal; the repo's ConfirmDialog falls back to the `open` attribute.

function renderPage(routes: Record<string, Handler> = {}) {
  const mock = createMockFetch({ "GET /screener/saved": fx.saved(), ...routes });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ScreenerPage />
    </QueryClientProvider>,
  );
  return mock;
}

const queries = (m: ReturnType<typeof createMockFetch>) =>
  m.calls.filter((c) => c.method === "POST" && c.path === "/screener/query");

async function addFilter(user: ReturnType<typeof userEvent.setup>, value: string, n = 1) {
  await user.click(screen.getByTestId("screener-add-filter"));
  const input = await screen.findAllByLabelText(/^Filter \d+ value/);
  await user.type(input[n - 1] as HTMLElement, value);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  download.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("screener builder and results (SCR-01, SCR-05, docs/06 6.6)", () => {
  it("posts the validated body with the CSRF header and shows units, dashes, stamps and exclusions", async () => {
    const user = userEvent.setup();
    const mock = renderPage({
      "POST /screener/query": fx.screener(
        [
          fx.item("TCS", {
            values: { roe: 18.5, market_cap_cr: 250000, pe: null, quality_score: 71.2 },
            value_reasons: { pe: "not_available" },
          }),
          fx.item("M&M", {
            stale: true,
            stale_reason: "fundamentals_older_than_120_days",
            last_updated: "2026-05-01",
          }),
          fx.item("NOOWNER", {
            stale: true,
            stale_reason: "no_owner_data",
            last_updated: null,
            last_updated_source: null,
          }),
        ],
        { total: 3, excluded: { roe: 41 } },
      ),
    });
    expect(screen.getByTestId("screener-owner-data-notice")).toHaveTextContent(
      "Fundamental filters only see stocks with owner-entered data",
    );
    await addFilter(user, "15");
    await user.click(screen.getByTestId("screener-run"));
    await screen.findByTestId("screener-table");

    const [call] = queries(mock);
    expect(call?.headers.get("X-Requested-With")).toBe("fetch");
    expect(call?.body).toEqual({
      filters: [{ metric: "roe", op: ">", value: 15 }],
      columns: ["market_cap_cr", "pe", "roe", "quality_score"],
      universe: { kind: "equity" },
      limit: 50,
      cursor: null,
    });

    // units in headers; a missing value is a dash with its reason, never 0
    expect(screen.getByTestId("screener-th-roe")).toHaveTextContent("ROE (percent)");
    expect(screen.getByTestId("screener-th-market_cap_cr")).toHaveTextContent(
      "Market cap (INR crore)",
    );
    const pe = screen.getByTestId("screener-cell-TCS-pe");
    expect(pe.textContent).toMatch(/^—/);
    expect(pe.textContent).toMatch(/not available for this stock/);
    expect(pe.textContent).not.toMatch(/\b0\b/);
    expect(screen.getByTestId("screener-cell-TCS-roe")).toHaveTextContent("18.50%");

    // stale rows are flagged in words, with the reason, and carry the data attribute
    expect(screen.getByTestId("screener-row-TCS").getAttribute("data-stale")).toBe("false");
    const mm = screen.getByTestId("screener-row-M&M");
    expect(mm.getAttribute("data-stale")).toBe("true");
    expect(screen.getByTestId("screener-stamp-M&M")).toHaveTextContent("1 May 2026 (fundamentals)");
    expect(screen.getByTestId("screener-stamp-M&M")).toHaveTextContent(
      "Stale: Fundamentals entered more than 120 days ago",
    );
    expect(screen.getByTestId("screener-stamp-NOOWNER")).toHaveTextContent("No owner data");
    expect(screen.getByTestId("screener-stale-note")).toHaveTextContent("2 of the 3 loaded stocks");

    expect(screen.getByTestId("screener-excluded")).toHaveTextContent("ROE 41");
    expect(screen.getByTestId("screener-status")).toHaveTextContent(
      "Showing 3 of 3 stocks, 2 with stale owner data",
    );
    expect(screen.getByTestId("screener-link-M&M")).toHaveAttribute("href", "/stocks/M%26M");
    // focus moves to the results heading
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("screener-results-heading")),
    );
  });

  it("an invalid value shows an error next to the filter and sends nothing", async () => {
    const user = userEvent.setup();
    const mock = renderPage({});
    await addFilter(user, "abc");
    await user.click(screen.getByTestId("screener-run"));
    expect(await screen.findByTestId(/^screener-filter-error-/)).toHaveTextContent(
      "Enter a plain number",
    );
    expect(queries(mock)).toHaveLength(0);
  });

  it("allows 12 filters, disables Add at 12 with a reason, and sends all 12", async () => {
    const user = userEvent.setup();
    const mock = renderPage({ "POST /screener/query": fx.screener([]) });
    for (let i = 1; i <= 12; i++) await addFilter(user, String(i), i);
    const add = screen.getByTestId("screener-add-filter");
    expect(add).toBeDisabled();
    expect(add.getAttribute("aria-describedby")).toBe("screener-add-disabled");
    expect(document.getElementById("screener-add-disabled")?.textContent).toMatch(/at most 12/);
    await user.click(screen.getByTestId("screener-run"));
    await screen.findByText(/No stocks match this screen/);
    const body = queries(mock)[0]?.body as { filters: unknown[] };
    expect(body.filters).toHaveLength(12);
  });

  it("shows server field errors from a 422 and a Retry", async () => {
    const user = userEvent.setup();
    renderPage({
      "POST /screener/query": fx.err(422, "UNPROCESSABLE", "Validation failed", {
        fields: [{ field: "filters[0].value", message: "must be a finite number" }],
      }),
    });
    await user.click(screen.getByTestId("screener-run"));
    expect(await screen.findByTestId("screener-server-fields")).toHaveTextContent(
      "filters[0].value: must be a finite number",
    );
    expect(screen.getByTestId("screener-retry")).toBeTruthy();
  });

  it("Load more sends the cursor, keeps the rows when a page fails, then appends on retry", async () => {
    const user = userEvent.setup();
    let n = 0;
    const mock = renderPage({
      "POST /screener/query": (call) => {
        const cursor = (call.body as { cursor: string | null }).cursor;
        if (cursor === null) return fx.screener([fx.item("AAA")], { next: "c1", total: 2 });
        n += 1;
        return n === 1
          ? fx.err(500, "INTERNAL", "boom")
          : fx.screener([fx.item("BBB")], { total: 2 });
      },
    });
    await user.click(screen.getByTestId("screener-run"));
    await screen.findByTestId("screener-row-AAA");
    await user.click(screen.getByTestId("screener-more"));
    expect(await screen.findByTestId("screener-more-error")).toHaveTextContent(
      "rows above are kept",
    );
    expect(screen.getByTestId("screener-row-AAA")).toBeTruthy();
    await user.click(screen.getByTestId("screener-more"));
    await screen.findByTestId("screener-row-BBB");
    expect(screen.queryByTestId("screener-more")).toBeNull();
    const bodies = queries(mock).map((c) => (c.body as { cursor: string | null }).cursor);
    expect(bodies).toEqual([null, "c1", "c1"]);
    expect(screen.getByTestId("screener-status")).toHaveTextContent("Showing 2 of 2 stocks");
  });

  it("exports the loaded rows through the CSV guard", async () => {
    const user = userEvent.setup();
    renderPage({
      "POST /screener/query": fx.screener([fx.item("TCS", { name: "=2+2" })]),
    });
    await user.click(screen.getByTestId("screener-run"));
    await user.click(await screen.findByTestId("screener-export"));
    expect(download).toHaveBeenCalledTimes(1);
    const [csv, name] = download.mock.calls[0] as [string, string];
    expect(name).toBe("screener.csv");
    expect(csv).toContain("TCS,'=2+2,");
  });

  it("is accessible and its controls are labelled (axe)", async () => {
    const user = userEvent.setup();
    renderPage({
      "POST /screener/query": fx.screener([
        fx.item("TCS", { stale: true, stale_reason: "no_owner_data" }),
      ]),
    });
    await addFilter(user, "15");
    await user.click(screen.getByTestId("screener-run"));
    await screen.findByTestId("screener-table");
    const res = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("presets and saved screens (SCR-06)", () => {
  it("a preset fills the builder from the server's spec", async () => {
    const user = userEvent.setup();
    renderPage({});
    await user.click(await screen.findByTestId("screener-preset-Value"));
    expect(screen.getByTestId("screener-load-note")).toHaveTextContent("Loaded Value");
    expect(screen.getAllByLabelText(/^Filter 1 (lower|upper) bound/)).toHaveLength(2);
    expect((screen.getByTestId("screener-sort-metric") as HTMLSelectElement).value).toBe("pe");
  });

  it("saves a new screen with the current spec and refreshes the list", async () => {
    const user = userEvent.setup();
    let names: string[] = [];
    const mock = renderPage({
      "GET /screener/saved": () => fx.saved(names),
      "POST /screener/saved": (call) => {
        names = [(call.body as { name: string }).name];
        return fx.savedOne(names[0] ?? "");
      },
    });
    await addFilter(user, "20");
    await user.type(screen.getByTestId("screener-save-name"), "High ROE");
    await user.click(screen.getByTestId("screener-save"));
    await screen.findByTestId("screener-saved-High ROE");
    const post = mock.calls.find((c) => c.method === "POST" && c.path === "/screener/saved");
    expect(post?.headers.get("X-Requested-With")).toBe("fetch");
    expect(post?.body).toEqual({
      name: "High ROE",
      spec: {
        filters: [{ metric: "roe", op: ">", value: 20 }],
        columns: ["market_cap_cr", "pe", "roe", "quality_score"],
        universe: { kind: "equity" },
      },
    });
    expect(screen.getByTestId("screener-saved-status")).toHaveTextContent("Saved screen High ROE");
  });

  it("an invalid name is refused before any request", async () => {
    const user = userEvent.setup();
    const mock = renderPage({});
    await user.type(screen.getByTestId("screener-save-name"), "-bad");
    await user.click(screen.getByTestId("screener-save"));
    expect(await screen.findByTestId("screener-save-name-error")).toHaveTextContent("Use 1 to 60");
    expect(mock.calls.some((c) => c.method === "POST" && c.path === "/screener/saved")).toBe(false);
  });

  it("the same name (any case) asks before replacing, then sends once", async () => {
    const user = userEvent.setup();
    const mock = renderPage({
      "GET /screener/saved": fx.saved(["High ROE"]),
      "POST /screener/saved": fx.savedOne("high roe", 200),
    });
    await screen.findByTestId("screener-saved-High ROE");
    await user.type(screen.getByTestId("screener-save-name"), "high roe");
    expect(screen.getByTestId("screener-save")).toHaveTextContent("Replace saved screen");
    await user.click(screen.getByTestId("screener-save"));
    expect(mock.calls.some((c) => c.method === "POST" && c.path === "/screener/saved")).toBe(false);
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("already exists");
    await user.click(within(dialog).getByTestId("confirm-ok"));
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.method === "POST" && c.path === "/screener/saved"),
      ).toHaveLength(1),
    );
  });

  it("the 30-screen cap disables a new name with a reason; a 409 from the server is explained", async () => {
    const user = userEvent.setup();
    const names = Array.from({ length: 30 }, (_, i) => `Screen ${i + 1}`);
    renderPage({ "GET /screener/saved": fx.saved(names) });
    await screen.findByTestId("screener-saved-Screen 30");
    await user.type(screen.getByTestId("screener-save-name"), "One more");
    expect(screen.getByTestId("screener-save")).toBeDisabled();
    expect(document.getElementById("screener-save-hint")?.textContent).toMatch(
      /30 screens are saved/,
    );
  });

  it("a 409 answer shows the limit message and keeps the form", async () => {
    const user = userEvent.setup();
    renderPage({
      "POST /screener/saved": fx.err(
        409,
        "CONFLICT",
        "At most 30 screens can be saved; delete one first",
        {
          reason: "saved_screens_limit",
          max: 30,
        },
      ),
    });
    await user.type(screen.getByTestId("screener-save-name"), "New one");
    await user.click(screen.getByTestId("screener-save"));
    expect(await screen.findByTestId("screener-save-error")).toHaveTextContent(
      "You already have 30 saved screens. Delete one, then save again.",
    );
    expect((screen.getByTestId("screener-save-name") as HTMLInputElement).value).toBe("New one");
  });

  it("delete asks first, encodes the name in the path and ignores a second click while busy", async () => {
    const user = userEvent.setup();
    let names = ["My screen (v2)"];
    const mock = renderPage({
      "GET /screener/saved": () => fx.saved(names),
      "DELETE /screener/saved/My%20screen%20(v2)": () => {
        names = [];
        return { status: 200, body: { data: { ok: true }, meta: {}, warnings: [] } };
      },
    });
    await user.click(await screen.findByTestId("screener-delete-My screen (v2)"));
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("My screen (v2)");
    await user.dblClick(within(dialog).getByTestId("confirm-ok"));
    await waitFor(() => expect(screen.queryByTestId("screener-saved-My screen (v2)")).toBeNull());
    const dels = mock.calls.filter((c) => c.method === "DELETE");
    expect(dels).toHaveLength(1);
    expect(dels[0]?.path).toBe("/screener/saved/My%20screen%20(v2)");
    expect(dels[0]?.headers.get("X-Requested-With")).toBe("fetch");
    expect(screen.getByTestId("screener-saved-status")).toHaveTextContent("Deleted screen");
  });
});
