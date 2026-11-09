import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FundamentalsTab } from "@/components/stock/fundamentals/FundamentalsTab";
import {
  balanceDataset,
  cashflowDataset,
  fundamentalsFullSchema,
  scalarRows,
  seriesRows,
  waterfall,
} from "@/lib/stock/fundamentals";
import { fail, ok } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as fnd from "../mocks/fundamentals-fixtures";
import "./dom-matchers";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function renderTab(routes: Record<string, Handler>) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FundamentalsTab symbol="TCS" />
    </QueryClientProvider>,
  );
  return mock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

const parse = (reply: { body: unknown }) =>
  fundamentalsFullSchema.parse((reply.body as { data: unknown }).data);

describe("Fundamentals tab (FND-11, FND-12, docs/06 section 6.4)", () => {
  it("FND-11: no owner data shows the reason, the CTA and the manual form with the symbol fixed", async () => {
    const user = userEvent.setup();
    renderTab({ "GET /stocks/TCS/fundamentals": fnd.noData });
    const empty = await screen.findByTestId("fnd-empty");
    expect(empty).toHaveTextContent(/no data entered/);
    expect(screen.getByTestId("fnd-import-csv")).toHaveAttribute("href", "/imports");
    expect(empty.textContent).not.toMatch(/NaN|Infinity|\b0\b/);
    await user.click(screen.getByTestId("fnd-add-results"));
    const sym = within(await screen.findByTestId("fnd-form-panel")).getByTestId(
      "results-symbol",
    ) as HTMLInputElement;
    expect(sym.value).toBe("TCS");
    expect(sym.readOnly).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("fnd-form-panel")));
    expect(screen.getByTestId("fnd-footnote")).toHaveTextContent(
      "Figures are entered by you; verify against company filings.",
    );
  });

  it("FND-12: two quarters render, growth stays a dash with the not-computed reason", async () => {
    renderTab({
      "GET /stocks/TCS/fundamentals": fnd.fundamentals({
        periods: fnd.PERIODS.slice(2),
        labels: fnd.LABELS.slice(2),
        periods_available: 2,
        status: "partial",
        metrics: { "pnl.revenue": [1200, 1300], "pnl.net_profit": [190, 204] },
      }),
    });
    expect(await screen.findByTestId("fnd-table")).toBeInTheDocument();
    expect(screen.getByTestId("fnd-card")).toHaveAttribute("data-state", "partial");
    const cell = screen.getByTestId("fnd-cell-revenue_yoy-2026-09-30");
    expect(cell.textContent).toBe("—");
    expect(cell.querySelector("[title]")?.getAttribute("title")).toBe("not computed yet");
    expect(screen.getByTestId("fnd-derived-note")).toHaveTextContent("not computed yet");
    expect(screen.getByTestId("fnd-table").textContent).not.toMatch(/NaN|Infinity/);
  });

  it("shows per-row source, last-updated stamp, units, and sends basis and period to the API", async () => {
    const user = userEvent.setup();
    const mock = renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    expect(await screen.findByTestId("fnd-source-pnl.revenue")).toHaveTextContent("manual");
    expect(screen.getByTestId("fnd-source-pnl.ebitda")).toHaveTextContent("csv_import");
    expect(screen.getByTestId("fnd-last-updated")).toHaveTextContent("Last updated 9 Oct 2026");
    expect(screen.getByTestId("fnd-select-pnl.revenue")).toHaveTextContent("INR crore");
    expect(screen.getByTestId("fnd-select-pnl.eps")).toHaveTextContent("INR");
    expect(screen.getByTestId("fnd-cell-pnl.revenue-2026-09-30")).toHaveTextContent("1,300.00");
    await user.click(screen.getByTestId("fnd-period-A"));
    await user.click(screen.getByTestId("fnd-basis-standalone"));
    await waitFor(() =>
      expect(
        mock.calls.some(
          (c) => c.query.get("period") === "A" && c.query.get("basis") === "standalone",
        ),
      ).toBe(true),
    );
  });

  it("warnings: BASIS_NOT_MIXED, DERIVED_STALE and a stale stamp are all visible", async () => {
    const stale = ok({});
    const reply = fnd.fundamentals({ derived_as_of: "2026-10-01", derived_reason: null }, [
      { code: "BASIS_NOT_MIXED", message: "2 periods of the standalone basis are hidden." },
      { code: "DERIVED_STALE", message: "x" },
    ]);
    (reply.body as { meta: { stale: boolean } }).meta = { stale: true };
    void stale;
    renderTab({ "GET /stocks/TCS/fundamentals": reply });
    expect(await screen.findByTestId("fnd-warning-BASIS_NOT_MIXED")).toHaveTextContent(
      /never mixed.*2 periods of the standalone basis are hidden/,
    );
    expect(screen.getByTestId("fnd-warning-DERIVED_STALE")).toHaveTextContent(/as of 1 Oct 2026/);
    expect(screen.getByTestId("fnd-last-updated")).toHaveAttribute("data-stale", "true");
    expect(screen.getByTestId("fnd-last-updated")).toHaveTextContent(/stale/);
  });

  it("basis note from the API is shown and a missing basis disables its button", async () => {
    renderTab({
      "GET /stocks/TCS/fundamentals": fnd.fundamentals({
        basis_used: "standalone",
        basis_available: ["standalone"],
        basis_note: "No consolidated rows exist; standalone is shown.",
      }),
    });
    expect(await screen.findByTestId("fnd-basis-note")).toHaveTextContent(/standalone is shown/);
    expect(screen.getByTestId("fnd-basis-consolidated")).toBeDisabled();
    expect((screen.getByTestId("fnd-basis-standalone") as HTMLButtonElement).disabled).toBe(false);
  });

  it("ratios and valuation: not computed yet reason per row, and values when computed", async () => {
    const user = userEvent.setup();
    renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    await user.click(await screen.findByTestId("fnd-group-ratios"));
    const roe = screen.getByTestId("fnd-scalar-roe");
    expect(roe.querySelector("[title]")?.getAttribute("title")).toBe("not computed yet");
    expect(screen.getByTestId("fnd-roe-decomposition")).toHaveTextContent(/not computed yet/);
    await user.click(screen.getByTestId("fnd-group-valuation"));
    expect(screen.getByTestId("fnd-pe-strip")).toHaveTextContent(/not computed yet/);
  });

  it("valuation with a percentile draws the strip with a text value", async () => {
    const user = userEvent.setup();
    renderTab({
      "GET /stocks/TCS/fundamentals": fnd.fundamentals({
        valuation: { pe_ttm: 23.4, pe_basis: "ttm", pe_percentile_5y: 72 },
        valuation_reason: null,
        derived_as_of: "2026-10-09",
      }),
    });
    await user.click(await screen.findByTestId("fnd-group-valuation"));
    expect(screen.getByTestId("fnd-scalar-pe_ttm")).toHaveTextContent("23.40x");
    expect(screen.getByTestId("fnd-scalar-pe_basis")).toHaveTextContent("ttm");
    expect(screen.getByTestId("fnd-pe-value")).toHaveTextContent("72% (high)");
  });

  it("selecting a row moves the chart pane and the data table lists every period", async () => {
    const user = userEvent.setup();
    renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    const chart = await screen.findByTestId("fnd-row-chart");
    expect(chart).toHaveTextContent("Revenue by period");
    await user.click(screen.getByTestId("fnd-select-pnl.net_profit"));
    expect(screen.getByTestId("fnd-select-pnl.net_profit")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(screen.getByTestId("fnd-row-chart")).toHaveTextContent("Net profit by period"),
    );
    await user.click(within(screen.getByTestId("fnd-row-chart")).getByTestId("chart-show-data"));
    expect(
      within(screen.getByTestId("fnd-row-chart")).getAllByTestId("chart-data-row"),
    ).toHaveLength(4);
  });

  it("an Edit button on a period opens the form prefilled with that period end", async () => {
    const user = userEvent.setup();
    renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    await user.click(await screen.findByTestId("fnd-edit-2026-06-30"));
    expect((screen.getByTestId("results-period-end") as HTMLInputElement).value).toBe("2026-06-30");
    expect((screen.getByTestId("results-period-type") as HTMLSelectElement).value).toBe("Q");
  });

  it("an API error shows the error card with Retry", async () => {
    renderTab({
      "GET /stocks/TCS/fundamentals": {
        status: 500,
        body: { error: { code: "INTERNAL", message: "boom" } },
      },
    });
    expect(await screen.findByTestId("fnd-error")).toHaveTextContent("boom");
    expect(screen.getByTestId("card-retry")).toBeInTheDocument();
  });
});

describe("embedded manual form reuses the F13b validators (IMP-05, IMP-06, IMP-17)", () => {
  async function open(routes: Record<string, Handler> = {}) {
    const user = userEvent.setup();
    const mock = renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals(), ...routes });
    await user.click(await screen.findByTestId("fnd-add-results"));
    return { user, mock };
  }

  it("IMP-05/06: a non quarter-end or future period and a decimal comma send nothing", async () => {
    const { user, mock } = await open();
    await user.type(screen.getByTestId("results-period-end"), "2026-09-29");
    await user.type(screen.getByTestId("results-revenue"), "12,34");
    await user.click(screen.getByTestId("results-submit"));
    const errors = await screen.findAllByTestId("form-field-error");
    expect(errors.map((e) => e.textContent).join(" ")).toMatch(/quarter end|12,34/);
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("IMP-17: a valid save posts cleaned strings with the CSRF header and refetches", async () => {
    const { user, mock } = await open({
      "POST /stocks/TCS/results": ok(
        { batch_id: 9, inserted: 1, updated: 0, warnings: [], post_import_job_id: null },
        201,
      ),
    });
    await user.type(screen.getByTestId("results-period-end"), "2026-09-30");
    await user.type(screen.getByTestId("results-revenue"), "1,234.5");
    await user.click(screen.getByTestId("results-submit"));
    expect(await screen.findByTestId("results-saved-heading")).toBeInTheDocument();
    const post = mock.calls.find((c) => c.method === "POST");
    expect(post?.headers.get("X-Requested-With")).toBe("fetch");
    expect((post?.body as { values: { revenue: string } }).values.revenue).toBe("1234.5");
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.path === "/stocks/TCS/fundamentals").length,
      ).toBeGreaterThan(1),
    );
  });
});

describe("fundamentals model", () => {
  it("waterfall totals equal the table cells and steps chain to them", () => {
    const d = parse(fnd.fundamentals());
    const w = waterfall(d);
    if (!("steps" in w)) throw new Error("waterfall expected");
    const totals = Object.fromEntries(
      w.steps.filter((s) => s.kind === "total").map((s) => [s.label, s.value]),
    );
    expect(totals).toEqual({
      Revenue: 1300,
      EBITDA: 320,
      "Profit before tax": 268,
      "Net profit": 204,
    });
    // Chain: revenue + steps up to each total reproduces that total.
    let level = 0;
    for (const s of w.steps) {
      level = s.kind === "total" ? s.value : level + s.value;
      if (s.kind === "total") expect(level).toBe(s.value);
    }
    const rows = seriesRows(d, "pnl");
    expect(rows.find((r) => r.key === "pnl.revenue")?.values.at(-1)).toBe(totals["Revenue"]);
    expect(w.dataset.series.map((s) => s.name)).toEqual(["Reported total", "Decrease", "Increase"]);
  });

  it("waterfall names the missing metrics and refuses a loss instead of drawing it", () => {
    const miss = waterfall(parse(fnd.fundamentals({ metrics: { "pnl.revenue": [1, 2, 3, 4] } })));
    expect("missing" in miss && miss.missing).toContain("EBITDA");
    const d = parse(fnd.fundamentals());
    d.metrics = { ...d.metrics, "pnl.net_profit": [1, 2, 3, -50] };
    const loss = waterfall(d);
    expect("reason" in loss && loss.reason).toMatch(/negative level/);
  });

  it("balance and cash-flow datasets stack components and derive FCF = CFO - capex only when both exist", () => {
    const d = parse(fnd.fundamentals(fnd.annualBalance));
    const bal = balanceDataset(d);
    expect(bal?.series.filter((s) => s.stack === "bs")).toHaveLength(3);
    const cf = cashflowDataset(d);
    expect(cf?.series.find((s) => s.id === "cf.fcf")?.values).toEqual([50, 65]);
    const noCapex = parse(fnd.fundamentals({ metrics: { "cf.cfo": [1, 2, 3, 4] } }));
    expect(cashflowDataset(noCapex)?.series.some((s) => s.id === "cf.fcf")).toBe(false);
  });

  it("ratios block with a reason lists every known key as unknown, never 0", () => {
    const rows = scalarRows(parse(fnd.fundamentals()), "ratios");
    expect(rows.map((r) => r.key)).toContain("cfo_to_pat");
    expect(rows.every((r) => r.value === null && r.reason === "not computed yet")).toBe(true);
  });
});

// ---- F07 review fixes (F07R-1..F07R-8) --------------------------------------------------------

const openDialog = (): HTMLElement => {
  const d = document.querySelector("dialog[open]");
  if (!d) throw new Error("no open dialog");
  return d as HTMLElement;
};

describe("F07 review: toggles, honesty and form reuse", () => {
  it("F07R-1: an empty Annual view keeps the toggles so the owner can go back to Quarterly", async () => {
    const user = userEvent.setup();
    renderTab({
      "GET /stocks/TCS/fundamentals": (c) =>
        c.query.get("period") === "A" ? fnd.noData : fnd.fundamentals(),
    });
    await user.click(await screen.findByTestId("fnd-period-A"));
    const empty = await screen.findByTestId("fnd-empty");
    expect(within(empty).getByTestId("fnd-empty-toggles")).toBeInTheDocument();
    await user.click(within(empty).getByTestId("fnd-period-Q"));
    expect(await screen.findByTestId("fundamentals-tab")).toBeInTheDocument();
  });

  it("F07R-2: while the next view loads, labels and the Edit prefill follow the data on screen", async () => {
    const user = userEvent.setup();
    const mock = createMockFetch({
      "GET /stocks/TCS/fundamentals": (c) =>
        c.query.get("period") === "A" ? fnd.fundamentals(fnd.annualBalance) : fnd.fundamentals(),
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("period=A")
        ? gate.then(() => mock.impl(input, init))
        : mock.impl(input, init),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <FundamentalsTab symbol="TCS" />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByTestId("fnd-period-A"));
    expect(await screen.findByTestId("fnd-updating")).toHaveTextContent(/previous view/);
    expect(screen.getByTestId("fundamentals-tab")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("fnd-summary")).toHaveTextContent(/quarterly/);
    await user.click(screen.getByTestId("fnd-edit-2026-06-30"));
    expect((screen.getByTestId("results-period-type") as HTMLSelectElement).value).toBe("Q");
    release();
    await waitFor(() => expect(screen.getByTestId("fnd-summary")).toHaveTextContent(/annual/));
    expect(screen.queryByTestId("fnd-updating")).toBeNull();
  });

  it("F07R-3: derived rows name the analytics snapshot and its as-of; the FCF row names its formula", () => {
    const d = parse(fnd.fundamentals({ derived_as_of: "2026-10-01", derived_reason: null }));
    const pnl = seriesRows(d, "pnl");
    expect(pnl.find((r) => r.key === "revenue_yoy")?.source).toBe(
      "Analytics snapshot, as of 1 Oct 2026",
    );
    const cf = seriesRows(parse(fnd.fundamentals(fnd.annualBalance)), "cf");
    expect(cf.find((r) => r.key === "cf.fcf")?.source).toMatch(/CFO minus capex/);
  });

  it("F07R-3b: with no snapshot the derived source says not computed yet, never a date", async () => {
    renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    expect(await screen.findByTestId("fnd-source-net_margin")).toHaveTextContent(
      "Analytics snapshot, not computed yet",
    );
  });

  it("F07R-4: both scroll regions are focusable and labelled", async () => {
    const user = userEvent.setup();
    renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    const region = await screen.findByTestId("fnd-table-scroll");
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.getAttribute("aria-label")).toMatch(/P&L, quarterly, consolidated/);
    await user.click(screen.getByTestId("fnd-group-ratios"));
    const scalar = screen.getByTestId("fnd-scalar-scroll");
    expect(scalar).toHaveAttribute("role", "region");
    expect(scalar).toHaveAttribute("tabindex", "0");
    expect(scalar.getAttribute("aria-label")).toMatch(/Ratios/);
  });

  it("F07R-5: a disabled basis is explained in visible text linked to the group", async () => {
    renderTab({
      "GET /stocks/TCS/fundamentals": fnd.fundamentals({
        basis_used: "standalone",
        basis_available: ["standalone"],
      }),
    });
    const why = await screen.findByTestId("fnd-basis-disabled");
    expect(why).toHaveTextContent("consolidated unavailable: no quarterly periods are entered");
    const group = screen.getByTestId("fnd-basis-auto").parentElement;
    expect(group?.getAttribute("aria-describedby")).toBe(why.id);
  });

  it("F07R-6: the waterfall states that totals are reported and balancing steps are not", async () => {
    renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    expect(await screen.findByTestId("fnd-waterfall-note")).toHaveTextContent(
      /not a reported figure/,
    );
  });

  it("IMP-05: a quarterly period end that is not a quarter end is refused with the quarter-end message", async () => {
    const user = userEvent.setup();
    const mock = renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    await user.click(await screen.findByTestId("fnd-add-results"));
    await user.type(screen.getByTestId("results-period-end"), "2026-09-29");
    await user.type(screen.getByTestId("results-revenue"), "100");
    await user.click(screen.getByTestId("results-submit"));
    const errors = await screen.findAllByTestId("form-field-error");
    expect(errors.map((e) => e.textContent).join(" ")).toContain(
      "2026-09-29 is not a calendar quarter end (31 Mar, 30 Jun, 30 Sep or 31 Dec)",
    );
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("IMP-06: revenue at or above 1e7 crore is refused with the unit message; nothing is sent", async () => {
    const user = userEvent.setup();
    const mock = renderTab({ "GET /stocks/TCS/fundamentals": fnd.fundamentals() });
    await user.click(await screen.findByTestId("fnd-add-results"));
    await user.type(screen.getByTestId("results-period-end"), "2026-09-30");
    await user.type(screen.getByTestId("results-revenue"), "10000000");
    await user.click(screen.getByTestId("results-submit"));
    const errors = await screen.findAllByTestId("form-field-error");
    expect(errors.map((e) => e.textContent).join(" ")).toContain(
      "revenue 10000000 is not below 1e7 crore; check the units (INR crore, not INR)",
    );
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("F13b parity: the embedded form shows the B08-8 copy and deletes a manual period after confirmation", async () => {
    const user = userEvent.setup();
    const mock = renderTab({
      "GET /stocks/TCS/fundamentals": fnd.fundamentals(),
      "DELETE /stocks/TCS/results": () =>
        ok({ deleted: 3, batch_id: 31, post_import_job_id: 9, warnings: [] }),
    });
    await user.click(await screen.findByTestId("fnd-edit-2026-06-30"));
    expect(screen.getByTestId("results-reentry-copy")).toHaveTextContent(
      "Metrics you leave out are not removed: values saved by an earlier manual entry for this period stay. To remove them, delete the manual period and enter it again.",
    );
    await user.click(screen.getByTestId("results-delete"));
    expect(openDialog().textContent).toContain("TCS, 2026-06-30 (quarterly, consolidated)");
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect(await screen.findByTestId("results-deleted-note")).toHaveTextContent("3");
    const del = mock.calls.find((c) => c.method === "DELETE");
    expect(del?.query.get("period_end")).toBe("2026-06-30");
    expect(del?.headers.get("X-Requested-With")).toBe("fetch");
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.path === "/stocks/TCS/fundamentals").length,
      ).toBeGreaterThan(1),
    );
  });

  it("F07R-7: opening Edit for another period starts a clean form (no values, note or errors carried over)", async () => {
    const user = userEvent.setup();
    renderTab({
      "GET /stocks/TCS/fundamentals": fnd.fundamentals(),
      "POST /stocks/TCS/results": fail(422, "VALIDATION", "bad"),
    });
    await user.click(await screen.findByTestId("fnd-edit-2026-06-30"));
    await user.type(screen.getByTestId("results-revenue"), "1,23");
    await user.type(screen.getByTestId("results-note"), "mine");
    await user.click(screen.getByTestId("results-submit"));
    await screen.findAllByTestId("form-field-error");
    await user.click(screen.getByTestId("fnd-edit-2026-03-31"));
    expect((screen.getByTestId("results-period-end") as HTMLInputElement).value).toBe("2026-03-31");
    expect((screen.getByTestId("results-revenue") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("results-note") as HTMLInputElement).value).toBe("");
    expect(screen.queryAllByTestId("form-field-error")).toHaveLength(0);
  });

  it("F07R-8: the form is rebuilt for another stock, so a save can never go to the previous symbol", async () => {
    const user = userEvent.setup();
    const mock = createMockFetch({
      "GET /stocks/TCS/fundamentals": fnd.fundamentals(),
      "GET /stocks/INFY/fundamentals": fnd.fundamentals(),
    });
    vi.stubGlobal("fetch", mock.impl);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (symbol: string) => (
      <QueryClientProvider client={client}>
        <FundamentalsTab symbol={symbol} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui("TCS"));
    await user.click(await screen.findByTestId("fnd-add-results"));
    expect((screen.getByTestId("results-symbol") as HTMLInputElement).value).toBe("TCS");
    rerender(ui("INFY"));
    await waitFor(() =>
      expect((screen.getByTestId("results-symbol") as HTMLInputElement).value).toBe("INFY"),
    );
  });
});
