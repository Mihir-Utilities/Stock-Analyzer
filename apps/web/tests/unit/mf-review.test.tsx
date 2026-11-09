import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfBrowse } from "@/components/mf/MfBrowse";
import { MfCompare } from "@/components/mf/MfCompare";
import { MfDetail } from "@/components/mf/MfDetail";
import { fail } from "../mocks/imports-fixtures";
import * as fx from "../mocks/mf-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import "./dom-matchers";

// F14 review fixes (OPEN_QUESTIONS F14R-1..5). Fixed fixtures only, no clock or randomness.

let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function setup(routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /mf/categories": fx.categories,
    "GET /watchlist": fx.emptyWatchFunds,
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: React.ReactElement) => (
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
  return { mock, wrap };
}

beforeEach(() => {
  search = "";
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe("F14 review fixes", () => {
  it("F14R-1: Plan and Option offer Any only with Show all (the API defaults to Direct+Growth otherwise)", async () => {
    const user = userEvent.setup();
    const { wrap } = setup({ "GET /mf/schemes": fx.searchPage([fx.item(1)]) });
    render(wrap(<MfBrowse />));
    await screen.findByTestId("mf-row-1");
    const values = (id: string) =>
      within(screen.getByTestId(id))
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value);
    expect(values("mf-plan")).toEqual(["direct", "regular"]);
    expect(values("mf-option")).toEqual(["growth", "idcw"]);
    await user.click(screen.getByTestId("mf-show-all"));
    expect(values("mf-plan")).toEqual(["direct", "regular", "any"]);
    expect(values("mf-option")).toEqual(["growth", "idcw", "any"]);
  });

  it("F14R-2: a sixth compare checkbox is disabled, not silently ignored", async () => {
    const user = userEvent.setup();
    const { wrap } = setup({
      "GET /mf/schemes": fx.searchPage([1, 2, 3, 4, 5, 6].map((c) => fx.item(c))),
    });
    render(wrap(<MfBrowse />));
    await screen.findByTestId("mf-row-1");
    for (const c of [1, 2, 3, 4, 5]) await user.click(screen.getByTestId(`mf-compare-${c}`));
    expect(screen.getByTestId("mf-compare-6")).toBeDisabled();
    expect(screen.getByTestId("mf-compare-5")).not.toBeDisabled();
    await user.click(screen.getByTestId("mf-compare-5"));
    expect(screen.getByTestId("mf-compare-6")).not.toBeDisabled();
  });

  it("F14R-3: a failed next page keeps the rows already loaded and offers Load more again", async () => {
    const user = userEvent.setup();
    const { wrap } = setup({
      "GET /mf/schemes": (call) =>
        call.query.get("cursor") === "c1"
          ? fail(422, "UNPROCESSABLE", "invalid cursor")
          : fx.searchPage([fx.item(9)], "c1"),
    });
    render(wrap(<MfBrowse />));
    await screen.findByTestId("mf-row-9");
    await user.click(screen.getByTestId("mf-more"));
    expect(await screen.findByTestId("mf-more-error")).toHaveTextContent("invalid cursor");
    expect(screen.getByTestId("mf-row-9")).toBeInTheDocument();
    expect(screen.getByTestId("mf-more")).toBeInTheDocument();
  });

  it("F14R-4: compare opened from a detail page with one code is a hint, not a warning", async () => {
    search = "codes=120503";
    const { mock, wrap } = setup({});
    render(wrap(<MfCompare />));
    expect(await screen.findByTestId("mf-compare-one")).toHaveTextContent("Add 1 to 4 more");
    expect(screen.queryByTestId("mf-compare-invalid")).toBeNull();
    expect(mock.calls.some((c) => c.path === "/mf/compare")).toBe(false);
  });

  it("F14R-4: a malformed code list is still a warning", async () => {
    search = "codes=12x,5";
    const { wrap } = setup({});
    render(wrap(<MfCompare />));
    expect(await screen.findByTestId("mf-compare-invalid")).toBeInTheDocument();
    expect(screen.queryByTestId("mf-compare-one")).toBeNull();
  });

  it("F14R-5: XIRR null without a server reason still says why", async () => {
    const user = userEvent.setup();
    const { wrap } = setup({
      "GET /mf/schemes/120503": fx.envelope(fx.detail()),
      "GET /mf/schemes/120503/nav": fx.nav(),
      "GET /mf/schemes/120503/sip": fx.envelope(
        fx.sip({ xirr_pct: null, xirr_reason: null, schedule: null }),
      ),
    });
    render(wrap(<MfDetail code="120503" />));
    await screen.findByTestId("sip-day");
    await user.type(screen.getByTestId("sip-start"), "2026-01-01");
    await user.click(screen.getByTestId("sip-submit"));
    expect(await screen.findByTestId("sip-result-card")).toHaveTextContent(
      "no installment was executed",
    );
  });

  it("F14R-6: opening another fund resets the refresh state of the previous one", async () => {
    const user = userEvent.setup();
    const { wrap } = setup({
      "GET /mf/schemes/120503": fx.envelope(fx.detail()),
      "GET /mf/schemes/120503/nav": fx.nav(),
      "GET /mf/schemes/118989": fx.envelope(
        fx.detail({ code: 118989, name: "Beta Large Cap Fund" }),
      ),
      "GET /mf/schemes/118989/nav": fx.nav(),
      "POST /mf/schemes/120503/refresh": fail(429, "RATE_LIMITED", "cooldown", {
        retry_after_seconds: 300,
      }),
    });
    // 118989 is loaded first so that going back to it is a cache hit (no loading state that would
    // unmount the header and hide the leak).
    const r = render(wrap(<MfDetail code="118989" />));
    await screen.findByTestId("mf-name");
    r.rerender(wrap(<MfDetail code="120503" />));
    await waitFor(() => expect(screen.getByTestId("mf-name")).toHaveTextContent("Alpha"));
    await user.click(screen.getByTestId("mf-refresh"));
    expect(await screen.findByText(/Try again in 5 min/)).toBeInTheDocument();
    r.rerender(wrap(<MfDetail code="118989" />));
    await waitFor(() => expect(screen.queryByText(/Try again in 5 min/)).toBeNull());
  });
});
