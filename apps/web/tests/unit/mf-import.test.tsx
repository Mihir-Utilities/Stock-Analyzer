import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfStatementImport } from "@/components/imports/MfStatementImport";
import {
  blockingErrors,
  canCommit,
  describeMfError,
  orderCandidates,
  rowsToImport,
} from "@/lib/imports/mf";
import { precheckFile } from "@/lib/imports/precheck";
import { mfValidateSchema } from "@/lib/imports/schemas";
import { validSchemeCode } from "@/lib/portfolio/mf-api";
import { ApiError } from "@/lib/api/client";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as pf from "../mocks/portfolio-fixtures";
import * as fx from "../mocks/mf-portfolio-fixtures";
import "./dom-matchers";

// MFH-U76: the mf_statement import (docs/06 6.7a, docs/03 12a). Synthetic rows only.

vi.setConfig({ testTimeout: 30_000 });

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function mount(routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /mf/schemes": pf.envelope(fx.mfSchemeSearch),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MfStatementImport />
    </QueryClientProvider>,
  );
  return mock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

const file = () => new File(["Date,Fund Name\n"], "statement.csv", { type: "text/csv" });

async function upload(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByTestId("mf-import-file"), file());
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("mf-import-summary");
}

const ok = (data: unknown) => pf.envelope(data);

describe("MFH-U76 upload and preview", () => {
  it("shows counts by type, the date range, matched funds and the normalised rows only", async () => {
    const user = userEvent.setup();
    mount({ "POST /imports/mf_statement/validate": ok(fx.mfValidate({ unmapped: false })) });
    await upload(user);
    expect(screen.getByTestId("mf-import-summary")).toHaveTextContent(
      "2 rows read, 0 errors, 0 warnings",
    );
    expect(screen.getByTestId("mf-import-types")).toHaveTextContent("Purchase 2");
    expect(screen.getByTestId("mf-import-range")).toHaveTextContent("6 Jan 2025 to 6 Jan 2025");
    expect(screen.getByTestId("mf-import-funds")).toHaveTextContent("1 already matched");
    const table = screen.getByTestId("mf-import-preview-table");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    // only the normalised columns, no raw cells
    expect([...table.querySelectorAll("th")].map((h) => h.textContent)).toEqual([
      "Include",
      "Row",
      "Date",
      "Fund name",
      "Type",
      "Folio",
      "Units",
      "NAV",
      "Amount",
      "Stamp duty",
    ]);
    expect(screen.getByTestId("wizard-next")).not.toBeDisabled();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("the file input says CSV is supported now and .xlsx is not enabled yet", () => {
    mount({});
    expect(screen.getByText(/CSV is supported now/)).toBeInTheDocument();
  });

  it("an .xlsx refused by the server gets plain copy, and the API text is shown escaped", async () => {
    const user = userEvent.setup();
    mount({
      "POST /imports/mf_statement/validate": {
        status: 422,
        body: { error: { code: "UNPROCESSABLE", message: "xlsx not enabled" } },
      },
    });
    await user.upload(screen.getByTestId("mf-import-file"), new File(["x"], "s.xlsx"));
    await user.click(screen.getByTestId("wizard-next"));
    expect(await screen.findByTestId("mf-import-validate-error")).toHaveTextContent(
      "Excel files are not enabled yet; save the statement as CSV.",
    );
  });

  it("offending text echoed by the API is rendered as plain text, never as markup", async () => {
    const user = userEvent.setup();
    const bad = fx.mfValidate({ unmapped: false });
    bad.errors = [
      {
        row: 3,
        column: "date",
        code: "DATE_INVALID",
        message: '"<img src=x onerror=alert(1)>" is not a date',
      },
    ] as typeof bad.errors;
    bad.error_count = 1;
    mount({ "POST /imports/mf_statement/validate": ok(bad) });
    await upload(user);
    const cell = screen.getByTestId("import-error-row");
    expect(cell.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("MFH-U76 fund-name mapping (MFH-23)", () => {
  it("lists candidates with plan and option, watchlist first, preselects nothing and blocks commit", async () => {
    const user = userEvent.setup();
    mount({ "POST /imports/mf_statement/validate": ok(fx.mfValidate()) });
    await upload(user);
    const group = screen.getByTestId("mf-map-fund-0");
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.getAttribute("data-testid"))).toEqual([
      "mf-candidate-0-100001", // on the watchlist: first
      "mf-candidate-0-100010",
      "mf-candidate-0-100011",
    ]);
    expect(radios.every((r) => !r.checked)).toBe(true); // no auto-pick
    expect(group).toHaveTextContent("Direct plan");
    expect(group).toHaveTextContent("Regular plan");
    expect(group).toHaveTextContent("Growth option");
    expect(group).toHaveTextContent("IDCW option");
    expect(group).toHaveTextContent("On your watchlist");
    expect(group).toHaveTextContent("No NAV data yet");
    expect(screen.getByTestId("wizard-next")).toBeDisabled(); // unmapped rows are errors
    expect(screen.getByTestId("mf-map-save")).toBeDisabled(); // nothing chosen yet
  });

  it("saves the choice, re-checks the stored upload and then allows the commit", async () => {
    const user = userEvent.setup();
    const mock = mount({
      "POST /imports/mf_statement/validate": ok(fx.mfValidate()),
      "PUT /portfolio/mf/fund-mappings": ok(fx.mfMapping),
      "POST /imports/mf_statement/revalidate": ok(fx.mfValidate({ unmapped: false })),
    });
    await upload(user);
    await user.click(screen.getByTestId("mf-candidate-0-100001"));
    expect(screen.getByTestId("mf-map-chosen-0")).toHaveTextContent("Direct plan, Growth option");
    await user.click(screen.getByTestId("mf-map-save"));
    await waitFor(() => expect(screen.queryByTestId("mf-import-mapping")).toBeNull());
    const put = mock.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({
      fund_name: "Example Alpha Fund",
      scheme_code: 100001,
      remap: false,
    });
    const re = mock.calls.find((c) => c.path === "/imports/mf_statement/revalidate")!;
    expect(re.body).toEqual({ upload_id: "11111111-1111-4111-8111-111111111111" });
    expect(screen.getByTestId("wizard-next")).not.toBeDisabled();
  });

  it("a single candidate is still not chosen for the owner", async () => {
    const user = userEvent.setup();
    const one = fx.mfValidate();
    one.mf.unmapped_funds[0]!.candidates = [fx.candidate(100001)];
    mount({ "POST /imports/mf_statement/validate": ok(one) });
    await upload(user);
    expect((screen.getByTestId("mf-candidate-0-100001") as HTMLInputElement).checked).toBe(false);
  });
});

describe("MFH-U76 repeated rows, unticking, commit and undo", () => {
  it("DUPLICATE_IN_FILE is informational: rows stay selected, an unticked row goes to excluded_rows", async () => {
    const user = userEvent.setup();
    const mock = mount({
      "POST /imports/mf_statement/validate": ok(fx.mfValidate({ unmapped: false, dup: true })),
      "POST /imports/mf_statement/commit": ok({
        batch_id: 9,
        inserted: 2,
        skipped_duplicates: 0,
        warnings: [],
      }),
    });
    await upload(user);
    expect(screen.getByTestId("mf-import-dups")).toHaveTextContent("every row stays selected");
    for (const line of [3, 4, 5]) {
      expect((screen.getByTestId(`mf-dup-include-${line}`) as HTMLInputElement).checked).toBe(true);
    }
    expect(screen.getByTestId("wizard-next")).not.toBeDisabled(); // warnings never block
    await user.click(screen.getByTestId("mf-row-include-4"));
    expect(screen.getByTestId("mf-import-excluded")).toHaveTextContent("1 rows are unticked");
    await user.click(screen.getByTestId("wizard-next"));
    expect(screen.getByTestId("mf-import-commit-note")).toHaveTextContent("2 rows will be added");
    await user.type(screen.getByTestId("mf-import-note"), "synthetic");
    await user.click(screen.getByTestId("wizard-commit"));
    await user.click(screen.getByTestId("confirm-ok"));
    await screen.findByTestId("mf-import-result");
    const commit = mock.calls.find((c) => c.path === "/imports/mf_statement/commit")!;
    expect(commit.body).toEqual({
      upload_id: "11111111-1111-4111-8111-111111111111",
      note: "synthetic",
      excluded_rows: [4],
    });
    expect(screen.getByTestId("mf-result-inserted")).toHaveTextContent("Added: 2");
  });

  it("undo is offered after the commit and the 409 UNDO_BREAKS_HOLDINGS message is shown", async () => {
    const user = userEvent.setup();
    mount({
      "POST /imports/mf_statement/validate": ok(fx.mfValidate({ unmapped: false })),
      "POST /imports/mf_statement/commit": ok({
        batch_id: 9,
        inserted: 2,
        skipped_duplicates: 0,
        warnings: [],
      }),
      "POST /imports/batches/9/undo": {
        status: 409,
        body: {
          error: {
            code: "UNDO_BREAKS_HOLDINGS",
            message: "later redemption would oversell",
            details: { scheme_code: 100001, folio: "TEST-F1", date: "2025-03-01" },
          },
        },
      },
    });
    await upload(user);
    await user.click(screen.getByTestId("wizard-next"));
    await user.click(screen.getByTestId("wizard-commit"));
    await user.click(screen.getByTestId("confirm-ok"));
    await screen.findByTestId("mf-import-result");
    await user.click(screen.getByTestId("mf-result-undo"));
    await user.click(screen.getByTestId("confirm-ok"));
    expect(await screen.findByTestId("mf-result-undo-error")).toHaveTextContent(
      "Undoing this batch would leave a later redemption selling more units than you held (scheme 100001, folio TEST-F1, from 1 Mar 2025)",
    );
  });

  it("an expired upload at commit explains it and offers to start over", async () => {
    const user = userEvent.setup();
    mount({
      "POST /imports/mf_statement/validate": ok(fx.mfValidate({ unmapped: false })),
      "POST /imports/mf_statement/commit": {
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "upload not found" } },
      },
    });
    await upload(user);
    await user.click(screen.getByTestId("wizard-next"));
    await user.click(screen.getByTestId("wizard-commit"));
    await user.click(screen.getByTestId("confirm-ok"));
    expect(await screen.findByTestId("mf-import-expired")).toBeInTheDocument();
  });
});

describe("MFH-U76 errored rows can be left out (B15R-6)", () => {
  const withErrors = () => {
    const v = fx.mfValidate({ unmapped: false, dup: true });
    v.errors = [
      { row: 4, column: "units", code: "UNITS_INVALID", message: "units must be greater than 0" },
      { row: 5, column: "nav", code: "NAV_INVALID", message: "NAV must be greater than 0" },
    ] as typeof v.errors;
    v.error_count = 2;
    return v;
  };

  it("commit stays blocked until every errored row is unticked, and says so", async () => {
    const user = userEvent.setup();
    const mock = mount({
      "POST /imports/mf_statement/validate": ok(withErrors()),
      "POST /imports/mf_statement/commit": ok({
        batch_id: 9,
        inserted: 1,
        skipped_duplicates: 0,
        warnings: [],
      }),
    });
    await upload(user);
    expect(screen.getByTestId("wizard-next")).toBeDisabled();
    expect(screen.getByTestId("mf-import-blocking")).toHaveTextContent("2 errors still block");
    await user.click(screen.getByTestId("mf-err-include-4"));
    expect(screen.getByTestId("wizard-next")).toBeDisabled(); // only some excluded: still blocked
    expect(screen.getByTestId("mf-import-blocking")).toHaveTextContent("1 errors still block");
    await user.click(screen.getByTestId("mf-err-include-5"));
    expect(screen.getByTestId("mf-import-blocking")).toHaveTextContent("No error blocks");
    await user.click(screen.getByTestId("wizard-next"));
    await user.click(screen.getByTestId("wizard-commit"));
    await user.click(screen.getByTestId("confirm-ok"));
    await screen.findByTestId("mf-import-result");
    expect(mock.calls.find((c) => c.path === "/imports/mf_statement/commit")!.body).toMatchObject({
      excluded_rows: [4, 5],
    });
  });

  it("a header problem can never be excluded and is shown honestly", async () => {
    const user = userEvent.setup();
    const v = fx.mfValidate({ unmapped: false });
    v.errors = [
      { row: 1, column: "Units Traded", code: "HEADER_MISSING", message: "column missing" },
    ] as typeof v.errors;
    v.error_count = 1;
    mount({ "POST /imports/mf_statement/validate": ok(v) });
    await upload(user);
    expect(screen.getByTestId("mf-import-header-error")).toHaveTextContent("cannot be left out");
    expect(screen.queryByTestId("mf-err-include-1")).toBeNull();
    expect(screen.getByTestId("wizard-next")).toBeDisabled();
  });
});

describe("mf import helpers", () => {
  const v = (errors: Array<{ row: number }>, count = errors.length) =>
    mfValidateSchema.parse({
      ...fx.mfValidate({ unmapped: false }),
      errors: errors.map((e) => ({ ...e, column: "x", message: "m" })),
      error_count: count,
    });

  it("canCommit: header errors and truncated error lists never become committable", () => {
    expect(canCommit(null, new Set())).toBe(false);
    expect(canCommit(v([]), new Set())).toBe(true);
    expect(canCommit(v([{ row: 1 }]), new Set([1]))).toBe(false);
    expect(canCommit(v([{ row: 4 }]), new Set([4]))).toBe(true);
    expect(canCommit(v([{ row: 4 }], 300), new Set([4]))).toBe(false); // 299 hidden errors
    expect(blockingErrors(v([{ row: 4 }, { row: 6 }]).errors, new Set([4]))).toHaveLength(1);
  });

  it("watchlist candidates come first, the rest keep the API order", () => {
    const out = orderCandidates(
      [
        fx.candidate(1),
        fx.candidate(2, { on_watchlist: true }),
        fx.candidate(3),
        fx.candidate(4, { on_watchlist: true }),
      ].map((c) => ({ ...c, fund_house: null }) as never),
    );
    expect(out.map((c) => c.scheme_code)).toEqual([2, 4, 1, 3]);
  });

  it("rowsToImport never goes negative or NaN", () => {
    expect(rowsToImport(10, 2, 3)).toBe(5);
    expect(rowsToImport(2, 2, 3)).toBeNull();
  });

  it("scheme_code filter is an int32 of at least 1, anything else is not sent", () => {
    expect(validSchemeCode("100001")).toBe("100001");
    expect(validSchemeCode("0")).toBeUndefined();
    expect(validSchemeCode("2147483648")).toBeUndefined();
    expect(validSchemeCode("12a")).toBeUndefined();
    expect(validSchemeCode("")).toBeUndefined();
  });

  it("file pre-check: csv, txt and xlsx up to 2 MB", () => {
    expect(precheckFile({ name: "a.csv", size: 100 }, "mf_statement").blocked).toBeNull();
    expect(precheckFile({ name: "a.xlsx", size: 100 }, "mf_statement").blocked).toBeNull();
    expect(precheckFile({ name: "a.pdf", size: 100 }, "mf_statement").blocked).toMatch(
      /\.csv or \.xlsx/,
    );
    expect(precheckFile({ name: "a.csv", size: 3 * 1024 * 1024 }, "mf_statement").blocked).toMatch(
      /2 MB/,
    );
  });

  it("describeMfError turns the not-enabled xlsx answer into plain copy", () => {
    expect(describeMfError(new ApiError("UNPROCESSABLE", "xlsx not enabled", 422))).toBe(
      "Excel files are not enabled yet; save the statement as CSV.",
    );
    expect(describeMfError(new ApiError("X", "other", 422))).toBe("other");
  });
});
