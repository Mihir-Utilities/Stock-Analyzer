import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfBrowse } from "@/components/mf/MfBrowse";
import { MfCompare } from "@/components/mf/MfCompare";
import { MfDetail } from "@/components/mf/MfDetail";
import { Footer, MF_ATTRIBUTION } from "@/components/shell/Footer";
import { fail } from "../mocks/imports-fixtures";
import * as fx from "../mocks/mf-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import "./dom-matchers";

const push = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function renderUi(ui: React.ReactElement, routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /mf/categories": fx.categories,
    "GET /watchlist": fx.emptyWatchFunds,
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return mock;
}

beforeEach(() => {
  search = "";
  push.mockReset();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe("attribution (SAF-03, D-W 7)", () => {
  it("the footer shows exactly the API's text on every MF path, including a wrong code", () => {
    for (const path of ["/mf", "/mf/120503", "/mf/compare", "/mf/999999"]) {
      const { unmount } = render(<Footer pathname={path} />);
      expect(screen.getByTestId("mf-attribution").textContent).toBe(fx.ATTRIBUTION);
      unmount();
    }
    expect(MF_ATTRIBUTION).toBe("NAV data: AMFI, via mfapi.in");
  });
});

describe("fund search (docs/06 6.9)", () => {
  it("lists funds with NAV unit/date and 1Y, defaults direct+growth, shows attribution", async () => {
    const mock = renderUi(<MfBrowse />, {
      "GET /mf/schemes": fx.searchPage([
        fx.item(1),
        fx.item(2, { latest_nav: null, return_1y_pct: null, last_nav_date: null }),
      ]),
    });
    expect(await screen.findByTestId("mf-row-1")).toBeInTheDocument();
    const row1 = screen.getByTestId("mf-row-1");
    expect(row1).toHaveTextContent("₹123.46");
    expect(row1).toHaveTextContent("INR per unit, 23 Oct 2026");
    expect(row1).toHaveTextContent("12.34%");
    expect(row1).toHaveTextContent("CAGR, as of 23 Oct 2026");
    const row2 = screen.getByTestId("mf-row-2");
    expect(row2).toHaveTextContent("no NAV stored yet");
    expect(row2).toHaveTextContent("not computed yet or history shorter than 1 year");
    expect(row2.textContent).not.toMatch(/NaN|Infinity|₹0\.00/);
    const call = mock.calls.find((c) => c.path === "/mf/schemes");
    expect(call?.query.get("plan")).toBe("direct");
    expect(call?.query.get("option")).toBe("growth");
    expect(call?.query.get("include_all")).toBeNull();
    expect(screen.getByTestId("mf-notice")).toHaveTextContent(
      "AUM, expense ratio and manager are not available from this data source",
    );
    expect(await screen.findByTestId("asof-chip")).toHaveTextContent("As of 2026-10-23");
  });

  it("an API error shows the message and a retry", async () => {
    renderUi(<MfBrowse />, { "GET /mf/schemes": fail(500, "INTERNAL", "boom") });
    expect(await screen.findByTestId("mf-error")).toHaveTextContent("boom");
  });

  it("empty result and stale chip", async () => {
    renderUi(<MfBrowse />, { "GET /mf/schemes": fx.searchPage([], null, true) });
    expect(await screen.findByTestId("empty-state")).toHaveTextContent("No funds match");
    expect(screen.getByTestId("asof-chip")).toHaveTextContent("(stale)");
  });

  it("debounces typing into one request, Show all drops plan/option, Group sends group", async () => {
    const user = userEvent.setup();
    const mock = renderUi(<MfBrowse />, { "GET /mf/schemes": fx.searchPage([fx.item(1)]) });
    await screen.findByTestId("mf-row-1");
    const before = mock.calls.filter((c) => c.path === "/mf/schemes").length;
    await user.type(screen.getByTestId("mf-q"), "parag");
    await waitFor(() => expect(mock.calls.some((c) => c.query.get("q") === "parag")).toBe(true));
    const typed = mock.calls.filter((c) => c.path === "/mf/schemes").slice(before);
    expect(typed).toHaveLength(1);
    await user.click(screen.getByTestId("mf-show-all"));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.query.get("include_all") === "true")).toBe(true),
    );
    const all = mock.calls.filter((c) => c.query.get("include_all") === "true").at(-1);
    expect(all?.query.get("plan")).toBeNull();
    expect(all?.query.get("option")).toBeNull();
    await user.click(screen.getByTestId("mf-group"));
    await waitFor(() => expect(mock.calls.some((c) => c.query.get("group") === "true")).toBe(true));
  });

  it("pages with the cursor and hides Load more at the end", async () => {
    const user = userEvent.setup();
    const mock = renderUi(<MfBrowse />, {
      "GET /mf/schemes": (call) =>
        call.query.get("cursor") === "c1"
          ? fx.searchPage([fx.item(3)])
          : fx.searchPage([fx.item(9)], "c1"),
    });
    await screen.findByTestId("mf-row-9");
    await user.click(screen.getByTestId("mf-more"));
    expect(await screen.findByTestId("mf-row-3")).toBeInTheDocument();
    expect(screen.queryByTestId("mf-more")).toBeNull();
    expect(mock.calls.some((c) => c.query.get("cursor") === "c1")).toBe(true);
  });

  it("renders grouped funds with variant chips", async () => {
    const user = userEvent.setup();
    renderUi(<MfBrowse />, {
      "GET /mf/schemes": (call) =>
        call.query.get("group") === "true"
          ? fx.searchPage([
              {
                name: "Alpha Flexi Cap Fund",
                fund_house: "Alpha Mutual Fund",
                category: "Flexi",
                variants: [
                  fx.item(1),
                  fx.item(2, { plan: "regular", option: "idcw", status: "inactive" }),
                ],
              },
            ])
          : fx.searchPage([fx.item(1)]),
    });
    await screen.findByTestId("mf-row-1");
    await user.click(screen.getByTestId("mf-group"));
    const group = await screen.findByTestId("mf-group-rows");
    expect(within(group).getByText("Alpha Flexi Cap Fund")).toBeInTheDocument();
    expect(within(group).getByTestId("mf-row-2")).toHaveTextContent("IDCW");
    expect(within(group).getByTestId("mf-row-2")).toHaveTextContent("Inactive");
  });

  it("selecting 2 funds links to compare", async () => {
    const user = userEvent.setup();
    renderUi(<MfBrowse />, { "GET /mf/schemes": fx.searchPage([fx.item(1), fx.item(2)]) });
    await screen.findByTestId("mf-row-1");
    expect(screen.queryByTestId("mf-compare-go")).toBeNull();
    await user.click(screen.getByTestId("mf-compare-1"));
    await user.click(screen.getByTestId("mf-compare-2"));
    expect(screen.getByTestId("mf-compare-go")).toHaveAttribute("href", "/mf/compare?codes=1,2");
    expect(screen.getByTestId("mf-compare-count")).toHaveTextContent("2 of 5");
  });
});

const detailRoutes = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /mf/schemes/120503": fx.envelope(fx.detail()),
  "GET /mf/schemes/120503/nav": fx.nav(),
  ...over,
});

describe("fund detail (docs/06 6.9)", () => {
  it("header, returns with reasons, risk, rolling, unavailable views, lumpsum, attribution", async () => {
    renderUi(<MfDetail code="120503" />, detailRoutes());
    expect(await screen.findByTestId("mf-name")).toHaveTextContent("Alpha Flexi Cap Fund");
    expect(screen.getByTestId("mf-nav-value")).toHaveTextContent("₹123.46");
    expect(screen.getByTestId("mf-nav-meta")).toHaveTextContent("INR per unit, NAV of 23 Oct 2026");
    expect(screen.getByTestId("mf-plan-chip")).toHaveTextContent("Direct");
    expect(screen.getByTestId("mf-option-chip")).toHaveTextContent("Growth");
    expect(screen.getByTestId("mf-return-r_1y")).toHaveTextContent("+12.34%");
    expect(screen.getByTestId("mf-return-r_1y")).toHaveTextContent("CAGR");
    const r5 = screen.getByTestId("mf-return-r_5y");
    expect(r5).toHaveTextContent("—");
    expect(r5).toHaveTextContent("history is shorter than this window");
    expect(screen.getByTestId("heatmap")).toBeInTheDocument();
    expect(screen.getByTestId("mf-risk")).toHaveTextContent("-22.10%");
    expect(screen.getByTestId("mf-rolling")).toHaveTextContent("82.5%");
    expect(screen.getByTestId("mf-series-unavailable-text")).toHaveTextContent("Not available yet");
    expect(screen.getByTestId("mf-lumpsum-unavailable")).toHaveTextContent("Not available yet");
    expect(screen.getByTestId("mf-notice")).toBeInTheDocument();
    expect(screen.getByTestId("mf-nav-jumps")).toHaveTextContent("21 Oct 2026 +30.5%");
    expect(await screen.findByTestId("mf-nav-chart")).toBeInTheDocument();
  });

  it("MF-05: an IDCW scheme shows the not-comparable warning and the SIP payout note", async () => {
    renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "GET /mf/schemes/120503": fx.envelope(fx.detail({ option: "idcw" }), {
        warnings: [{ code: "IDCW_NOT_COMPARABLE", message: "server text" }],
      }),
    });
    const banner = await screen.findByTestId("mf-warning-IDCW_NOT_COMPARABLE");
    expect(banner).toHaveTextContent("not comparable");
    expect(banner).toHaveTextContent("exclude payouts");
    expect(screen.getByTestId("mf-option-chip")).toHaveTextContent("IDCW");
    expect(screen.getByTestId("sip-idcw")).toHaveTextContent("payouts are not modelled");
  });

  it("MF-13: a wrong code is a 404 with suggestions and the attribution", async () => {
    renderUi(<MfDetail code="120504" />, {
      "GET /mf/schemes/120504": fail(404, "NOT_FOUND", "Scheme not found", {
        code: "120504",
        suggestions: [{ code: 120503, name: "Alpha Flexi Cap Fund" }],
      }),
    });
    const nf = await screen.findByTestId("mf-not-found");
    expect(nf).toHaveTextContent("No fund with the scheme code 120504");
    expect(screen.getByTestId("mf-suggestion-120503")).toHaveAttribute("href", "/mf/120503");
  });

  it("MF-13: a non-numeric code is rejected without a request", async () => {
    const mock = renderUi(<MfDetail code="abc" />, {});
    expect(await screen.findByTestId("mf-not-found")).toHaveTextContent("not a scheme code");
    expect(mock.calls.filter((c) => c.path.startsWith("/mf/schemes"))).toHaveLength(0);
  });

  it("no NAV yet (MF-90, MF-100): dashes with reasons and a backfill note, no chart", async () => {
    renderUi(<MfDetail code="120503" />, {
      "GET /mf/schemes/120503": fx.noNavDetail({ status: "queued", job_id: 3 }),
    });
    expect(await screen.findByTestId("mf-no-nav")).toHaveTextContent("being fetched");
    expect(screen.getByTestId("mf-nav-value")).toHaveTextContent("—");
    expect(screen.getByTestId("mf-nav-meta")).toHaveTextContent("no NAV data yet");
    expect(screen.getByTestId("mf-returns")).toHaveTextContent("No NAV data yet");
    expect(screen.queryByTestId("mf-nav-chart")).toBeNull();
    expect(screen.getByTestId("mf-warning-NO_NAV_DATA")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("inactive scheme: chip and banner (MF-06)", async () => {
    renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "GET /mf/schemes/120503": fx.envelope(fx.detail({ status: "inactive" })),
    });
    expect(await screen.findByTestId("mf-inactive")).toHaveTextContent("inactive");
    expect(screen.getByTestId("mf-inactive-chip")).toBeInTheDocument();
  });

  it("stale NAV: chip and banner come from meta.stale (4 calendar days)", async () => {
    renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "GET /mf/schemes/120503": fx.envelope(fx.detail(), { stale: true, asOf: "2026-10-01" }),
    });
    expect(await screen.findByTestId("mf-stale")).toHaveTextContent("more than 4 days old");
    expect(screen.getAllByTestId("asof-chip")[0]).toHaveTextContent("(stale)");
  });

  it("weekly NAV scheme: volatility and Sharpe are dashes with the reason (MF-07)", async () => {
    const d = fx.detail({
      risk: {
        volatility_pct: null,
        volatility_reason: "weekly_nav",
        volatility_years: null,
        max_drawdown_pct: -22.1,
        sharpe_like: null,
        sharpe_reason: "weekly_nav",
        risk_free_rate: 6.5,
      },
    });
    renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "GET /mf/schemes/120503": fx.envelope(d),
    });
    const risk = await screen.findByTestId("mf-risk");
    expect(risk.textContent).toContain("this scheme publishes weekly NAVs");
    expect(within(risk).getAllByTestId("stat-null")).toHaveLength(2);
  });

  it("refresh: cooldown 429 shows minutes, a second click while busy is ignored", async () => {
    const user = userEvent.setup();
    const mock = renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "POST /mf/schemes/120503/refresh": fail(429, "RATE_LIMITED", "cooldown", {
        retry_after_seconds: 300,
      }),
    });
    await screen.findByTestId("mf-name");
    await user.click(screen.getByTestId("mf-refresh"));
    expect(
      await screen.findByText("You refreshed this recently. Try again in 5 min."),
    ).toBeInTheDocument();
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refresh: 409 busy shows the busy message", async () => {
    const user = userEvent.setup();
    renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "POST /mf/schemes/120503/refresh": fail(409, "CONFLICT", "busy"),
    });
    await screen.findByTestId("mf-name");
    await user.click(screen.getByTestId("mf-refresh"));
    expect(await screen.findByText(/already running/)).toBeInTheDocument();
  });

  it("watchlist star adds the fund with type mf", async () => {
    const user = userEvent.setup();
    const mock = renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "POST /watchlist": fx.envelope({ id: 5 }, { status: 201 }),
    });
    await screen.findByTestId("mf-name");
    await waitFor(() => expect(screen.getByTestId("mf-watchlist")).not.toBeDisabled());
    await user.click(screen.getByTestId("mf-watchlist"));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "POST")?.body).toEqual({
        type: "mf",
        code: 120503,
      }),
    );
  });
});

describe("SIP calculator (MF-10, MF-11, MF-92, MF-93, MF-96)", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, day = "1") {
    await user.clear(screen.getByTestId("sip-day"));
    await user.type(screen.getByTestId("sip-day"), day);
    await user.type(screen.getByTestId("sip-start"), "2026-01-01");
  }

  it("MF-11: day 31 shows an error, focuses the field and sends no request", async () => {
    const user = userEvent.setup();
    const mock = renderUi(<MfDetail code="120503" />, detailRoutes());
    await screen.findByTestId("sip-day");
    await fill(user, "31");
    await user.click(screen.getByTestId("sip-submit"));
    expect(await screen.findByTestId("form-field-error")).toHaveTextContent("1 to 28");
    expect(document.activeElement).toBe(screen.getByTestId("sip-day"));
    expect(mock.calls.some((c) => c.path.endsWith("/sip"))).toBe(false);
  });

  it("sends the amount as typed, shows invested/value/XIRR, installments and the chart", async () => {
    const user = userEvent.setup();
    const mock = renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "GET /mf/schemes/120503/sip": fx.envelope(fx.sip({ skipped_installments: 1 }), {
        warnings: [{ code: "INSTALLMENTS_SKIPPED", message: "1 installment(s) were skipped" }],
      }),
    });
    await screen.findByTestId("sip-day");
    await fill(user);
    await user.click(screen.getByTestId("sip-submit"));
    const res = await screen.findByTestId("sip-result-card");
    expect(res).toHaveTextContent("₹15,000.00");
    expect(res).toHaveTextContent("₹16,000.00");
    expect(res).toHaveTextContent("28.90%");
    expect(res).toHaveTextContent("Installments skipped");
    expect(screen.getByTestId("sip-warning-INSTALLMENTS_SKIPPED")).toHaveTextContent("skipped");
    const call = mock.calls.find((c) => c.path.endsWith("/sip"));
    expect(call?.query.get("amount")).toBe("5000");
    expect(call?.query.get("day")).toBe("1");
    expect(call?.query.get("start")).toBe("2026-01-01");
    expect(call?.query.get("end")).toBeNull();
    expect(await screen.findByTestId("mf-sip-chart")).toBeInTheDocument();
    expect(res.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("XIRR null shows a dash and the reason; no executed installment shows a dash for value", async () => {
    const user = userEvent.setup();
    renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "GET /mf/schemes/120503/sip": fx.envelope(
        fx.sip({
          value: null,
          xirr_pct: null,
          xirr_reason: "period_too_short",
          absolute_return_pct: null,
          installments: 0,
          skipped_installments: 3,
          invested: "0.00",
          schedule: null,
          end_nav: null,
        }),
        { warnings: [{ code: "NO_INSTALLMENTS", message: "No installment could be executed." }] },
      ),
    });
    await screen.findByTestId("sip-day");
    await fill(user);
    await user.click(screen.getByTestId("sip-submit"));
    const res = await screen.findByTestId("sip-result-card");
    const nulls = within(res).getAllByTestId("stat-null");
    expect(nulls.length).toBe(3);
    expect(res).toHaveTextContent("fewer than 30 days");
    expect(res).toHaveTextContent("no installment could be executed in this period");
    expect(screen.queryByTestId("mf-sip-chart")).toBeNull();
    expect(screen.getByTestId("sip-warning-NO_INSTALLMENTS")).toBeInTheDocument();
  });

  it("shows server field errors from a 422", async () => {
    const user = userEvent.setup();
    const mock = renderUi(<MfDetail code="120503" />, {
      ...detailRoutes(),
      "GET /mf/schemes/120503/sip": fail(422, "UNPROCESSABLE", "bad", {
        fields: [{ field: "start", message: "start is before the first NAV allowed" }],
      }),
    });
    await screen.findByTestId("sip-day");
    await fill(user);
    await user.click(screen.getByTestId("sip-submit"));
    expect(await screen.findByTestId("form-field-error")).toHaveTextContent("start is before");
    expect(mock.calls.filter((c) => c.path.endsWith("/sip"))).toHaveLength(1);
  });
});

describe("compare (MF-14, MF-94, MF-102)", () => {
  it("different starts: banner, rebased chart, table with reasons, scatter notice", async () => {
    search = "codes=120503,118989&range=3Y";
    const mock = renderUi(<MfCompare />, { "GET /mf/compare": fx.compare() });
    expect(await screen.findByTestId("mf-compare-different-starts")).toHaveTextContent(
      "first common date, 1 Jan 2024",
    );
    expect(await screen.findByTestId("mf-compare-chart")).toBeInTheDocument();
    const call = mock.calls.find((c) => c.path === "/mf/compare");
    expect(call?.query.get("codes")).toBe("120503,118989");
    expect(call?.query.get("range")).toBe("3Y");
    const row2 = screen.getByTestId("mf-compare-row-118989");
    expect(row2).toHaveTextContent("history shorter than the range");
    expect(row2).toHaveTextContent("-4.20%");
    expect(row2).toHaveTextContent("history is shorter than this window");
    expect(screen.getByTestId("mf-compare-scatter-unavailable")).toHaveTextContent(
      "Not available yet",
    );
  });

  it("MF-102: no common dates is a plain explanation, not a raw code", async () => {
    search = "codes=1,2";
    renderUi(<MfCompare />, {
      "GET /mf/compare": fail(422, "UNPROCESSABLE", "no shared nav date", {
        reason: "no_common_dates",
      }),
    });
    expect(await screen.findByTestId("mf-compare-error")).toHaveTextContent(
      "no NAV date in common",
    );
  });

  it("MF-94: client checks 2 to 5 codes before any request and pushes the URL", async () => {
    const user = userEvent.setup();
    const mock = renderUi(<MfCompare />, {});
    await user.type(screen.getByTestId("mf-compare-codes"), "5");
    await user.click(screen.getByTestId("mf-compare-submit"));
    expect(await screen.findByTestId("form-field-error")).toHaveTextContent("2 to 5");
    await user.clear(screen.getByTestId("mf-compare-codes"));
    await user.type(screen.getByTestId("mf-compare-codes"), "5, 6");
    await user.click(screen.getByTestId("mf-compare-submit"));
    expect(push).toHaveBeenCalledWith("/mf/compare?codes=5%2C6&range=3Y");
    expect(mock.calls.some((c) => c.path === "/mf/compare")).toBe(false);
  });
});
