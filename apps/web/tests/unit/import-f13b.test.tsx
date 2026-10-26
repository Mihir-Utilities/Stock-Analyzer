import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionForm } from "@/components/imports/ActionForm";
import { BatchesTab } from "@/components/imports/BatchesTab";
import { ImportCenter } from "@/components/imports/ImportCenter";
import { ImportWizard } from "@/components/imports/ImportWizard";
import { REENTRY_COPY, ResultsForm } from "@/components/imports/ResultsForm";
import { ShareholdingForm } from "@/components/imports/ShareholdingForm";
import { undoVerdict } from "@/lib/imports/batches";
import {
  cleanNumber,
  parseDate,
  todayIst,
  validateAction,
  validateResults,
  validateShareholding,
} from "@/lib/imports/entry-validate";
import { IMPORT_KINDS, type Batch } from "@/lib/imports/schemas";
import { commitOk, dbStatus, fail, ok } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";

function renderWith(ui: ReactElement, routes: Record<string, Handler>) {
  const mock = createMockFetch({ "GET /admin/status": dbStatus(100), ...routes });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return mock;
}

/** Holds requests whose path ends with `suffix` until `release()` (single-flight checks). */
function hold(mock: ReturnType<typeof renderWith>, suffix: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).split("?")[0]?.endsWith(suffix)
      ? gate.then(() => mock.impl(input, init))
      : mock.impl(input, init),
  );
  return release;
}

function openDialog(): HTMLElement {
  const d = document.querySelector("dialog[open]");
  if (!d) throw new Error("no open dialog");
  return d as HTMLElement;
}

// Typing into many fields is slow on a loaded machine (the full suite runs in parallel).
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

const manualOk = {
  batch_id: 21,
  inserted: 3,
  updated: 1,
  warnings: [] as Array<{ field: string; code: string; message: string }>,
  post_import_job_id: 5,
};

describe("entry validators mirror the importer (IMP-17, IMP-28, IMP-35, IMP-56, D-P)", () => {
  it.each([
    ["1,234.56", "1234.56"],
    ["1,23,456.78", "123456.78"],
    ["-1,234", "-1234"],
    ["12.5", "12.5"],
  ])("accepts %s", (raw, want) => {
    expect(cleanNumber(raw)).toEqual({ ok: true, value: want });
  });

  it.each(["1234,56", "12,34", "1.234,56", "0,123", "00,123", "0,5"])(
    "rejects the ambiguous comma %s and shows the value",
    (raw) => {
      const r = cleanNumber(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain(`"${raw}"`);
        expect(r.message).toContain("ambiguous");
      }
    },
  );

  it("rejects exponent notation and non-numbers; an empty cell is null, never 0", () => {
    expect(cleanNumber("1e5")).toEqual({
      ok: false,
      message: expect.stringContaining("exponent notation not accepted"),
    });
    expect(cleanNumber("abc")).toEqual({ ok: false, message: '"abc" is not a number' });
    expect(cleanNumber("  ")).toEqual({ ok: true, value: null });
  });

  it("IMP-02: dates accept ISO, DD-MM-YYYY and DD-Mon-YYYY and reject MM-DD-YYYY", () => {
    expect(parseDate("2026-09-30")).toEqual({ ok: true, value: "2026-09-30" });
    expect(parseDate("30-09-2026")).toEqual({ ok: true, value: "2026-09-30" });
    expect(parseDate("30-Sep-2026")).toEqual({ ok: true, value: "2026-09-30" });
    const r = parseDate("09-30-2026");
    expect(r.ok).toBe(false);
    expect(parseDate("31-02-2026").ok).toBe(false);
    expect(parseDate("1800-01-01").ok).toBe(false);
  });

  it("IMP-05: a quarterly period_end that is not a quarter end is an error, annual only warns", () => {
    const values = { revenue: "100" } as never;
    const base = { basis: "consolidated", periodEnd: "2026-08-31", values: blank(values) };
    const q = validateResults({ ...base, periodType: "Q" }, "2026-10-26");
    expect(q.errors.period_end).toContain("not a calendar quarter end");
    const a = validateResults({ ...base, periodType: "A" }, "2026-10-26");
    expect(a.errors.period_end).toBeUndefined();
  });

  it("results: unit mix-up errors, future dates and an all-empty form are refused", () => {
    const base = { basis: "consolidated", periodType: "Q", periodEnd: "2026-09-30" };
    const big = validateResults(
      { ...base, values: blank({ revenue: "20,000,000" } as never) },
      "2026-10-26",
    );
    expect(big.errors.revenue).toContain("1e7 crore");
    const eps = validateResults(
      { ...base, values: blank({ eps: "100001" } as never) },
      "2026-10-26",
    );
    expect(eps.errors.eps).toContain("EPS is in INR per share");
    const future = validateResults(
      { ...base, periodEnd: "2026-12-31", values: blank({ revenue: "1" } as never) },
      "2026-10-26",
    );
    expect(future.errors.period_end).toContain("in the future");
    const empty = validateResults({ ...base, values: blank({} as never) }, "2026-10-26");
    expect(empty.errors.values).toBeDefined();
    expect(empty.body).toBeNull();
  });

  it("results: cleaned numbers go out as strings, empty cells as null", () => {
    const r = validateResults(
      {
        basis: "standalone",
        periodType: "A",
        periodEnd: "31-Mar-2026",
        values: blank({ revenue: "1,23,456.5", eps: "" } as never),
      },
      "2026-10-26",
    );
    expect(r.body).toMatchObject({
      period_end: "2026-03-31",
      values: { revenue: "123456.5", eps: null },
    });
  });

  it("IMP-07: shareholding sums, MF+insurance vs DII, percent range", () => {
    const pct = (o: Record<string, string>) => ({
      promoter: "",
      fii: "",
      dii: "",
      mf: "",
      insurance: "",
      govt: "",
      public: "",
      pledged_of_promoter: "",
      ...o,
    });
    const ok100 = validateShareholding(
      {
        quarterEnd: "2026-09-30",
        filedOn: "",
        count: "",
        pct: pct({ promoter: "50", fii: "10", dii: "15", govt: "0", public: "25" }),
      },
      "2026-10-26",
    );
    expect(ok100.errors).toEqual({});
    expect(ok100.body?.pledged_of_promoter).toBeNull();
    const bad = validateShareholding(
      {
        quarterEnd: "2026-09-30",
        filedOn: "",
        count: "",
        pct: pct({ promoter: "50", fii: "10", dii: "15", govt: "0", public: "20" }),
      },
      "2026-10-26",
    );
    expect(bad.errors.promoter).toContain("must be 100 +/- 1.0");
    const mf = validateShareholding(
      {
        quarterEnd: "2026-09-30",
        filedOn: "",
        count: "",
        pct: pct({ dii: "10", mf: "8", insurance: "3" }),
      },
      "2026-10-26",
    );
    expect(mf.errors.mf).toContain("components of dii");
    const range = validateShareholding(
      { quarterEnd: "2026-09-30", filedOn: "", count: "1.5", pct: pct({ promoter: "101" }) },
      "2026-10-26",
    );
    expect(range.errors.promoter).toContain("between 0 and 100");
    expect(range.errors.shareholders_count).toContain("whole number");
  });

  it("actions: split and bonus need ratios, dividend needs an amount, equal split refused", () => {
    const a = { exDate: "2026-09-12", ratioNum: "", ratioDen: "", amount: "", purpose: "" };
    expect(validateAction({ ...a, type: "split" }).errors.ratio_num).toContain("needs both ratios");
    expect(validateAction({ ...a, type: "dividend" }).errors.amount_per_share).toContain(
      "needs amount_per_share",
    );
    expect(
      validateAction({ ...a, type: "split", ratioNum: "5", ratioDen: "5" }).errors.ratio_num,
    ).toContain("changes nothing");
    expect(validateAction({ ...a, type: "other", ratioNum: "1" }).errors.ratio_num).toContain(
      "together or neither",
    );
    expect(validateAction({ ...a, type: "bogus" }).errors.type).toContain("must be one of");
    const good = validateAction({ ...a, type: "split", ratioNum: "10", ratioDen: "2" });
    expect(good.body).toMatchObject({ type: "split", ratio_num: "10", ratio_den: "2" });
    // A future ex-date is accepted (ACT-10).
    expect(validateAction({ ...a, exDate: "2099-01-01", type: "other" }).errors).toEqual({});
  });

  it("todayIst follows the IST date across UTC midnight", () => {
    expect(todayIst(Date.parse("2026-10-25T19:00:00Z"))).toBe("2026-10-26");
  });
});

function blank(v: Record<string, string>) {
  return {
    revenue: "",
    ebitda: "",
    operating_income: "",
    other_income: "",
    interest: "",
    depreciation: "",
    pbt: "",
    tax: "",
    net_profit: "",
    eps: "",
    ...v,
  };
}

describe("Results form (IMP-48 UI path, B08-8)", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByTestId("results-symbol"), "TCS");
    await user.type(screen.getByTestId("results-period-end"), "2026-09-30");
    await user.type(screen.getByTestId("results-revenue"), "1,234.5");
  }

  it("states that leaving metrics out keeps the old manual values (B08-8)", () => {
    renderWith(<ResultsForm />, {});
    expect(screen.getByTestId("results-reentry-copy").textContent).toBe(REENTRY_COPY);
    expect(REENTRY_COPY).toContain("delete the manual period and enter it again");
  });

  it("saves, sends cleaned strings with the CSRF header, then focuses the result heading", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ResultsForm />, { "POST /stocks/TCS/results": ok(manualOk, 201) });
    await fill(user);
    await user.type(screen.getByTestId("results-note"), "as per company filing dated 2026-10-12");
    await user.click(screen.getByTestId("results-submit"));
    const heading = await screen.findByTestId("results-saved-heading");
    expect(heading.textContent).toContain("batch 21");
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const call = mock.calls.find((c) => c.path === "/stocks/TCS/results");
    expect(call?.headers.get("X-Requested-With")).toBe("fetch");
    expect(call?.body).toMatchObject({
      basis: "consolidated",
      period_type: "Q",
      period_end: "2026-09-30",
      note: "as per company filing dated 2026-10-12",
    });
    expect((call?.body as { values: Record<string, unknown> }).values.revenue).toBe("1234.5");
    expect((call?.body as { values: Record<string, unknown> }).values.eps).toBeNull();
  });

  it("shows the offending value for a decimal comma and sends nothing (D-P)", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ResultsForm />, {});
    await fill(user);
    await user.clear(screen.getByTestId("results-revenue"));
    await user.type(screen.getByTestId("results-revenue"), "12,34");
    await user.click(screen.getByTestId("results-submit"));
    expect((await screen.findAllByTestId("form-field-error"))[0]?.textContent).toContain('"12,34"');
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("maps server details.fields (values.revenue) onto the cell and shows the warning codes", async () => {
    const user = userEvent.setup();
    renderWith(<ResultsForm />, {
      "POST /stocks/TCS/results": fail(422, "VALIDATION", "invalid", {
        fields: [{ field: "values.net_profit", message: "net_profit is odd" }],
      }),
    });
    await fill(user);
    await user.click(screen.getByTestId("results-submit"));
    expect((await screen.findAllByTestId("form-field-error"))[0]?.textContent).toContain(
      "net_profit is odd",
    );
  });

  it("shows POST_IMPORT_NOT_QUEUED as a sentence and an unknown symbol 404 as advice", async () => {
    const user = userEvent.setup();
    renderWith(<ResultsForm />, {
      "POST /stocks/TCS/results": ok(
        {
          ...manualOk,
          warnings: [{ field: "post_import", code: "POST_IMPORT_NOT_QUEUED", message: "x" }],
          post_import_job_id: null,
        },
        200,
      ),
      "POST /stocks/NOPE/results": fail(404, "NOT_FOUND", "unknown symbol"),
    });
    await fill(user);
    await user.click(screen.getByTestId("results-submit"));
    expect((await screen.findByTestId("manual-warning")).textContent).toContain(
      "analytics refresh was not queued",
    );
    await user.clear(screen.getByTestId("results-symbol"));
    await user.type(screen.getByTestId("results-symbol"), "NOPE");
    await user.click(screen.getByTestId("results-submit"));
    expect((await screen.findByTestId("results-error")).textContent).toContain("Add the stock");
  });

  it("UI-32: a double submit sends one POST", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ResultsForm />, { "POST /stocks/TCS/results": ok(manualOk, 201) });
    const release = hold(mock, "/results");
    await fill(user);
    const form = screen.getByTestId("results-submit").closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    release();
    await screen.findByTestId("results-saved");
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("deletes a manual period after confirmation; 404 is explained", async () => {
    const user = userEvent.setup();
    let status = 200;
    const mock = renderWith(<ResultsForm />, {
      "DELETE /stocks/TCS/results": () =>
        status === 200
          ? ok({ deleted: 4, batch_id: 30, post_import_job_id: 9, warnings: [] })
          : fail(404, "NOT_FOUND", "no manual period"),
    });
    await user.type(screen.getByTestId("results-symbol"), "TCS");
    await user.type(screen.getByTestId("results-period-end"), "2026-09-30");
    await user.click(screen.getByTestId("results-delete"));
    expect(openDialog().textContent).toContain("CSV import stay");
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("results-deleted-note")).textContent).toContain("4");
    const del = mock.calls.find((c) => c.method === "DELETE");
    expect(del?.query.get("period_type")).toBe("Q");
    expect(del?.query.get("period_end")).toBe("2026-09-30");
    expect(del?.query.get("basis")).toBe("consolidated");
    status = 404;
    await user.click(screen.getByTestId("results-delete"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("results-delete-error")).textContent).toContain(
      "no manual entry",
    );
  });
});

describe("Shareholding and action forms", () => {
  it("shareholding: a bad sum is blocked locally; a valid entry posts and keeps unknown as null", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ShareholdingForm />, {
      "POST /stocks/INFY/shareholding": ok(manualOk, 201),
    });
    await user.type(screen.getByTestId("shareholding-symbol"), "INFY");
    await user.type(screen.getByTestId("shareholding-quarter-end"), "2026-09-30");
    await user.type(screen.getByTestId("shareholding-promoter"), "50");
    await user.type(screen.getByTestId("shareholding-fii"), "10");
    await user.type(screen.getByTestId("shareholding-dii"), "15");
    await user.type(screen.getByTestId("shareholding-govt"), "0");
    await user.type(screen.getByTestId("shareholding-public"), "20");
    await user.click(screen.getByTestId("shareholding-submit"));
    expect((await screen.findAllByTestId("form-field-error"))[0]?.textContent).toContain(
      "must be 100",
    );
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await user.clear(screen.getByTestId("shareholding-public"));
    await user.type(screen.getByTestId("shareholding-public"), "25");
    await user.click(screen.getByTestId("shareholding-submit"));
    await screen.findByTestId("shareholding-saved");
    const body = mock.calls.find((c) => c.method === "POST")?.body as Record<string, unknown>;
    expect(body.quarter_end).toBe("2026-09-30");
    expect(body.pledged_of_promoter).toBeNull();
    expect(body.mf).toBeNull();
  });

  it("action: split ratios are required, a valid split posts as typed numbers-as-strings", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ActionForm />, {
      "POST /stocks/TCS/actions": ok({ ...manualOk, id: 77 }, 201),
    });
    await user.type(screen.getByTestId("action-symbol"), "TCS");
    await user.type(screen.getByTestId("action-ex-date"), "12-Sep-2026");
    await user.click(screen.getByTestId("action-submit"));
    expect((await screen.findAllByTestId("form-field-error"))[0]?.textContent).toContain(
      "needs both ratios",
    );
    await user.type(screen.getByTestId("action-ratio-num"), "10");
    await user.type(screen.getByTestId("action-ratio-den"), "2");
    await user.click(screen.getByTestId("action-submit"));
    await screen.findByTestId("action-saved");
    expect(mock.calls.find((c) => c.method === "POST")?.body).toMatchObject({
      ex_date: "2026-09-12",
      type: "split",
      ratio_num: "10",
      ratio_den: "2",
      amount_per_share: null,
    });
  });
});

const batch = (o: Partial<Batch>): Batch => ({
  id: 1,
  kind: "results_quarterly",
  upload_group: null,
  row_count: 24,
  warning_count: 0,
  note: "as per filing dated 2026-08-12",
  created_at: "2026-10-20T09:00:00Z",
  undone_at: null,
  ...o,
});

describe("Batches (IMP-14, IMP-44, IMP-53, IMP-55)", () => {
  it("IMP-14: Undo is offered only for undoable, recent, not-undone batches", () => {
    const now = Date.parse("2026-10-26T00:00:00Z");
    expect(undoVerdict(batch({}), now).undoable).toBe(true);
    for (const kind of ["prices", "instruments", "holidays", "instrument_meta", "manual_form"]) {
      expect(undoVerdict(batch({ kind }), now).undoable).toBe(false);
    }
    expect(undoVerdict(batch({ undone_at: "2026-10-21T00:00:00Z" }), now).undoable).toBe(false);
    expect(undoVerdict(batch({ created_at: "2026-09-01T00:00:00Z" }), now).undoable).toBe(false);
  });

  const list = (items: Batch[]) => ok({ items, next_cursor: null });

  it("lists batches with Undo only where allowed and the overwrite warning in the dialog", async () => {
    const user = userEvent.setup();
    const recent = new Date().toISOString();
    renderWith(<BatchesTab />, {
      "GET /imports/batches": list([
        batch({ id: 9, created_at: recent }),
        batch({ id: 8, kind: "prices", created_at: recent }),
        batch({ id: 7, kind: "manual_form", created_at: recent }),
        batch({ id: 6, created_at: recent, undone_at: recent }),
      ]),
    });
    await screen.findByTestId("batches-table");
    expect(screen.getByTestId("batch-undo-9")).toBeTruthy();
    expect(screen.queryByTestId("batch-undo-8")).toBeNull();
    expect(screen.getByTestId("batch-no-undo-8").textContent).toContain("cannot be undone");
    expect(screen.queryByTestId("batch-undo-7")).toBeNull();
    expect(screen.getByTestId("batch-undone-6")).toBeTruthy();
    await user.click(screen.getByTestId("batch-undo-9"));
    expect(openDialog().textContent).toContain("not restored");
  });

  it("undo shows the warning codes as sentences, refreshes the list and focuses the result", async () => {
    const user = userEvent.setup();
    const recent = new Date().toISOString();
    const mock = renderWith(<BatchesTab />, {
      "GET /imports/batches": list([batch({ id: 9, created_at: recent })]),
      "POST /imports/batches/9/undo": ok({
        batch_id: 9,
        removed: 24,
        post_import_job_id: null,
        warnings: ["UNDO_REMOVES_EARLIER_IMPORT", "POST_IMPORT_NOT_QUEUED"],
        earlier_batch_ids: [4],
      }),
    });
    await screen.findByTestId("batches-table");
    await user.click(screen.getByTestId("batch-undo-9"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    const heading = await screen.findByTestId("undo-result-heading");
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByTestId("undo-removed").textContent).toContain("24");
    expect(screen.getByTestId("undo-warning-UNDO_REMOVES_EARLIER_IMPORT").textContent).toContain(
      "Earlier batches: 4",
    );
    expect(screen.getByTestId("undo-warning-POST_IMPORT_NOT_QUEUED")).toBeTruthy();
    expect(mock.calls.find((c) => c.path.endsWith("/undo"))?.headers.get("X-Requested-With")).toBe(
      "fetch",
    );
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.path === "/imports/batches").length).toBeGreaterThan(1),
    );
  });

  it("UNDO_REMOVED_NOTHING is a sentence", async () => {
    const user = userEvent.setup();
    renderWith(<BatchesTab />, {
      "GET /imports/batches": list([batch({ id: 9, created_at: new Date().toISOString() })]),
      "POST /imports/batches/9/undo": ok({
        batch_id: 9,
        removed: 0,
        post_import_job_id: null,
        warnings: ["UNDO_REMOVED_NOTHING"],
        earlier_batch_ids: [],
      }),
    });
    await user.click(await screen.findByTestId("batch-undo-9"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("undo-warning-UNDO_REMOVED_NOTHING")).textContent).toContain(
      "nothing was removed",
    );
  });

  it("IMP-53: 409 UNDO_HAS_DEPENDENTS explains that nothing changed", async () => {
    const user = userEvent.setup();
    renderWith(<BatchesTab />, {
      "GET /imports/batches": list([
        batch({ id: 9, kind: "corporate_actions", created_at: new Date().toISOString() }),
      ]),
      "POST /imports/batches/9/undo": fail(409, "UNDO_HAS_DEPENDENTS", "has dependents", {
        dependents: { portfolio_adjustment: 1 },
      }),
    });
    await user.click(await screen.findByTestId("batch-undo-9"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    const err = await screen.findByTestId("undo-error-UNDO_HAS_DEPENDENTS");
    expect(err.textContent).toContain("nothing was changed");
    expect(err.textContent).toContain("Remove the adjustment first");
  });

  it("UI-32: a double click on Undo batch sends exactly one POST", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<BatchesTab />, {
      "GET /imports/batches": list([batch({ id: 9, created_at: new Date().toISOString() })]),
      "POST /imports/batches/9/undo": ok({
        batch_id: 9,
        removed: 1,
        post_import_job_id: 1,
        warnings: [],
        earlier_batch_ids: [],
      }),
    });
    const release = hold(mock, "/undo");
    await user.click(await screen.findByTestId("batch-undo-9"));
    const okBtn = within(openDialog()).getByTestId("confirm-ok");
    fireEvent.click(okBtn);
    fireEvent.click(okBtn);
    release();
    await screen.findByTestId("undo-result");
    expect(mock.calls.filter((c) => c.path.endsWith("/undo"))).toHaveLength(1);
  });

  it("empty and error states", async () => {
    renderWith(<BatchesTab />, { "GET /imports/batches": list([]) });
    expect((await screen.findByTestId("empty-state")).textContent).toContain("No import batches");
  });

  it("an error shows Retry", async () => {
    renderWith(<BatchesTab />, {
      "GET /imports/batches": fail(500, "INTERNAL", "boom"),
    });
    expect(await screen.findByTestId("batches-error")).toBeTruthy();
    expect(screen.getByTestId("batches-retry")).toBeTruthy();
  });
});

describe("Wizard for the other kinds (IMP-01, IMP-11, IMP-27, IMP-44)", () => {
  const csv = () => new File(["a,b\n1,2\n"], "f.csv", { type: "text/csv" });
  const valid = (rows = 12) => ({
    upload_id: "55555555-5555-4555-8555-555555555555",
    upload_group: null,
    rows,
    preview: [{ symbol: "TCS", period_end: "2026-09-30", revenue: 100 }],
    errors: [],
    warnings: [],
    error_count: 0,
    warning_count: 0,
    estimated_growth_mb: null,
    prices_already_adjusted: null,
  });

  it("offers every importer kind, none for Screener (SAF-05)", () => {
    renderWith(<ImportWizard />, {});
    for (const k of IMPORT_KINDS) expect(screen.getByTestId(`import-kind-${k}`)).toBeTruthy();
    expect(document.querySelector('[data-testid*="screener"]')).toBeNull();
    expect(IMPORT_KINDS as readonly string[]).not.toContain("screener_xlsx");
  });

  it("IMP-01/IMP-11: a results file with errors shows row and column and blocks commit", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard initialKind="results_quarterly" />, {
      "POST /imports/results_quarterly/validate": ok({
        ...valid(),
        errors: [
          { row: 4, column: "period_end", message: "2026-08-31 is not a calendar quarter end" },
        ],
        error_count: 1,
      }),
    });
    expect(screen.getByTestId("import-template-link").getAttribute("href")).toBe(
      "/api/v1/imports/templates/results_quarterly",
    );
    await user.upload(screen.getByTestId("import-file"), csv());
    await user.click(screen.getByTestId("wizard-next"));
    const row = await screen.findByTestId("import-error-row");
    expect(row.textContent).toContain("period_end");
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("IMP-44: a results commit offers the Batches tab undo, not a prices-style refusal", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard initialKind="shareholding" />, {
      "POST /imports/shareholding/validate": ok(valid()),
      "POST /imports/shareholding/commit": ok(commitOk),
    });
    await user.upload(screen.getByTestId("import-file"), csv());
    await user.click(screen.getByTestId("wizard-next"));
    await user.click(await screen.findByTestId("wizard-next"));
    expect(screen.queryByTestId("import-growth")).toBeNull();
    await user.click(screen.getByTestId("wizard-commit"));
    expect(openDialog().textContent).toContain("You can undo it for 30 days");
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    const heading = await screen.findByTestId("import-result-heading");
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByTestId("result-undo-note").textContent).toContain("Batches tab");
  });

  it("IMP-27: the holidays wizard says commit replaces the years, and the batch cannot be undone", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard initialKind="holidays" />, {
      "POST /imports/holidays/validate": ok({
        ...valid(),
        preview: [{ date: "2026-01-26", description: "Republic Day", segment: "trading" }],
        warnings: [{ row: 3, column: "date", message: "2026-03-01 is a Sunday; the row was kept" }],
        warning_count: 1,
      }),
      "POST /imports/holidays/commit": ok({ ...commitOk, inserted: 14, updated: 0 }),
    });
    await user.upload(screen.getByTestId("import-file"), csv());
    await user.click(screen.getByTestId("wizard-next"));
    expect((await screen.findByTestId("import-holidays-note")).textContent).toContain(
      "replaces every stored holiday",
    );
    await user.click(screen.getByTestId("wizard-next"));
    await user.click(screen.getByTestId("wizard-commit"));
    expect(openDialog().textContent).toContain("This batch cannot be undone");
    expect(openDialog().textContent).toContain("replaced");
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("result-undo-note")).textContent).toContain(
      "cannot be undone",
    );
  });
});

describe("Import center tabs", () => {
  it("has Upload, Templates, Manual forms, Batches and Storage and no Screener tab (SAF-05)", () => {
    renderWith(<ImportCenter />, {});
    for (const id of ["upload", "templates", "forms", "batches", "storage"]) {
      expect(screen.getByTestId(`tab-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("tab-screener")).toBeNull();
  });

  it("templates tab links every kind", async () => {
    const user = userEvent.setup();
    renderWith(<ImportCenter />, {});
    await user.click(screen.getByTestId("tab-templates"));
    for (const k of IMPORT_KINDS) {
      expect(screen.getByTestId(`template-${k}`).getAttribute("href")).toBe(
        `/api/v1/imports/templates/${k}`,
      );
    }
  });

  it("manual forms tab lists the forms, says calendar events are not available, and has no call", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ImportCenter />, {});
    await user.click(screen.getByTestId("tab-forms"));
    expect(screen.getByTestId("manual-forms-note").textContent).toContain("Calendar events");
    await user.click(screen.getByTestId("tab-results"));
    expect(screen.getByTestId("results-form")).toBeTruthy();
    await user.click(screen.getByTestId("tab-shareholding"));
    expect(screen.getByTestId("shareholding-form")).toBeTruthy();
    await user.click(screen.getByTestId("tab-action"));
    expect(screen.getByTestId("action-form")).toBeTruthy();
    expect(mock.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});
