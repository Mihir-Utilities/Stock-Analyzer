import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportWizard } from "@/components/imports/ImportWizard";
import {
  adjustmentRawLikely,
  commitOk,
  dbStatus,
  fail,
  headerErrorPrices,
  invalidPrices,
  ok,
  validInstruments,
  validPrices,
} from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";

function renderWith(ui: ReactElement, routes: Record<string, Handler>) {
  const mock = createMockFetch({ "GET /admin/status": dbStatus(100), ...routes });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return mock;
}

const csv = () => new File(["symbol,date\nTCS,2026-10-20\n"], "p.csv", { type: "text/csv" });

async function upload(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByTestId("import-file"), csv());
  await user.click(screen.getByTestId("wizard-next"));
}

function openDialog(): HTMLElement {
  const d = document.querySelector("dialog[open]");
  if (!d) throw new Error("no open dialog");
  return d as HTMLElement;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("import wizard: validate step (IMP-01, IMP-11, D-P)", () => {
  it("IMP-01: a header error is shown at file level with the template link and blocks Next", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok(headerErrorPrices),
    });
    expect(screen.getByTestId("import-template-link").getAttribute("href")).toBe(
      "/api/v1/imports/templates/prices",
    );
    await upload(user);
    const rows = await screen.findAllByTestId("import-error-row");
    expect(rows[0]?.textContent).toContain("File");
    expect(rows[0]?.textContent).toContain("Expected: symbol,date,open,high,low,close,volume");
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("IMP-11: row and column errors are listed and the commit step is unreachable", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok(invalidPrices),
    });
    await upload(user);
    const rows = await screen.findAllByTestId("import-error-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("3");
    expect(rows[0]?.textContent).toContain("close");
    expect(rows[1]?.textContent).toContain("date");
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
    expect(mock.calls.some((c) => c.path.endsWith("/commit"))).toBe(false);
  });

  it("sends the file as multipart with the CSRF header", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok(validPrices),
    });
    await upload(user);
    await screen.findByTestId("import-summary");
    const call = mock.calls.find((c) => c.path === "/imports/prices/validate");
    expect(call?.headers.get("X-Requested-With")).toBe("fetch");
    expect(call?.headers.get("Content-Type")).toBeNull(); // browser sets the multipart boundary
    expect(call?.body).toBeInstanceOf(FormData);
  });

  it("shows a server rejection (413 over the limit) as a plain message and stays on step 1", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": fail(413, "BAD_REQUEST", "The file is larger than 5 MB."),
    });
    expect(screen.getByText(/Default limit: 5 MB and 50,000 rows/)).toBeTruthy();
    await upload(user);
    expect((await screen.findByTestId("import-validate-error")).textContent).toContain(
      "larger than 5 MB",
    );
    expect(screen.getByTestId("import-file")).toBeTruthy();
  });
});

describe("prices wizard: required raw / adjusted choice (IMP-25, IMP-26)", () => {
  it("IMP-25: Next stays blocked until raw or adjusted is chosen; choosing raw persists it", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok(validPrices),
      "PUT /settings/prices-adjustment": ok({ value: false, set_at: "2026-10-24T09:00:00Z" }),
    });
    await upload(user);
    await screen.findByTestId("adjustment-choice");
    expect(screen.getByTestId("adjustment-wizard-text").textContent).toContain(
      "Do not mix raw and adjusted files.",
    );
    expect(screen.getByTestId("adjustment-required")).toBeTruthy();
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByTestId("adjustment-raw"));
    await waitFor(() =>
      expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(false),
    );
    const put = mock.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ value: false });
    expect(put?.headers.get("X-Requested-With")).toBe("fetch");
  });

  it("IMP-26: I don't know persists nothing, runs the check and still blocks Next", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok(validPrices),
      "POST /imports/prices/adjustment-check": ok(adjustmentRawLikely),
    });
    await upload(user);
    await user.click(await screen.findByTestId("adjustment-unknown"));
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
    await user.type(screen.getByTestId("check-symbol"), "{Control>}a{/Control}TCS");
    await user.type(screen.getByTestId("check-exdate"), "2026-06-12");
    await user.type(screen.getByTestId("check-ratio-num"), "1");
    await user.type(screen.getByTestId("check-ratio-den"), "2");
    await user.click(screen.getByTestId("check-run"));
    expect((await screen.findByTestId("check-ratio")).textContent).toBe("0.5000");
    expect(screen.getByTestId("check-hint").textContent).toContain("looks raw");
    expect(screen.getByTestId("check-result").textContent).toContain("2026-06-11");
    const call = mock.calls.find((c) => c.path === "/imports/prices/adjustment-check");
    expect(call?.body).toEqual({
      upload_id: validPrices.upload_id,
      symbol: "TCS",
      ex_date: "2026-06-12",
      expected_ratio: { num: 1, den: 2 },
    });
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("changing a stored value asks for confirmation and sends confirm=true", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok({ ...validPrices, prices_already_adjusted: true }),
      "PUT /settings/prices-adjustment": ok({ value: false, set_at: "2026-10-24T09:00:00Z" }),
    });
    await upload(user);
    await user.click(await screen.findByTestId("adjustment-raw"));
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
    const dialog = openDialog();
    expect(dialog.textContent).toContain("Mixing raw and adjusted files");
    await user.click(within(dialog).getByTestId("confirm-ok"));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PUT")?.body).toEqual({
        value: false,
        confirm: true,
      }),
    );
  });
});

describe("prices wizard: size guard and commit (IMP-23, IMP-12, IMP-14)", () => {
  it("IMP-23: shows estimated growth and blocks when current size plus growth exceeds the limit", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard />, {
      "GET /admin/status": dbStatus(379.9),
      "POST /imports/prices/validate": ok({
        ...validPrices,
        prices_already_adjusted: false,
        estimated_growth_mb: 0.5,
      }),
    });
    await upload(user);
    expect((await screen.findByTestId("import-growth")).textContent).toContain("0.5 MB");
    expect((await screen.findByTestId("import-size-guard")).textContent).toBe(
      "This file would make the database exceed 380 MB; trim history or import fewer rows.",
    );
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains that the size is unknown when /admin/status is unavailable and lets the server decide", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard />, {
      "GET /admin/status": fail(501, "NOT_IMPLEMENTED", "not implemented"),
      "POST /imports/prices/validate": ok({ ...validPrices, prices_already_adjusted: false }),
    });
    await upload(user);
    await waitFor(() =>
      expect(screen.getByTestId("import-growth").textContent).toContain("not available"),
    );
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(false);
  });

  it("commits after a confirmation, shows the result and offers no Undo (IMP-14)", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok({ ...validPrices, prices_already_adjusted: false }),
      "POST /imports/prices/commit": ok({ ...commitOk, warnings: ["TRACKED_OVER_400"] }),
    });
    await upload(user);
    await user.click(await screen.findByTestId("wizard-next"));
    await user.type(screen.getByTestId("import-note"), "as per statement dated 2026-10-01");
    await user.click(screen.getByTestId("wizard-commit"));
    expect(mock.calls.some((c) => c.path.endsWith("/commit"))).toBe(false); // confirm first
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("import-result")).textContent).toContain("batch 7");
    expect(screen.getByTestId("result-inserted").textContent).toContain("2");
    expect(screen.getByTestId("result-warning").textContent).toContain("400 stocks");
    expect(screen.getByTestId("result-undo-note").textContent).toContain("cannot be undone");
    expect(screen.queryByText(/^Undo/)).toBeNull();
    const body = mock.calls.find((c) => c.path === "/imports/prices/commit")?.body;
    expect(body).toEqual({
      upload_id: validPrices.upload_id,
      note: "as per statement dated 2026-10-01",
    });
  });

  it("PRICES_ADJUSTMENT_UNSET at commit sends the owner back to the choice", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok({ ...validPrices, prices_already_adjusted: true }),
      "POST /imports/prices/commit": fail(
        422,
        "PRICES_ADJUSTMENT_UNSET",
        "Choose whether the prices are raw or adjusted before the first prices commit.",
      ),
    });
    await upload(user);
    await user.click(await screen.findByTestId("wizard-next"));
    await user.click(screen.getByTestId("wizard-commit"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("import-commit-error")).textContent).toContain(
      "raw or adjusted",
    );
    expect(screen.getByTestId("adjustment-required")).toBeTruthy();
  });

  it("DB_SIZE_LIMIT at commit shows the plain size message", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok({ ...validPrices, prices_already_adjusted: false }),
      "POST /imports/prices/commit": fail(422, "DB_SIZE_LIMIT", "server text"),
    });
    await upload(user);
    await user.click(await screen.findByTestId("wizard-next"));
    await user.click(screen.getByTestId("wizard-commit"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("import-commit-error")).textContent).toContain(
      "exceed 380 MB; trim history or import fewer rows",
    );
  });

  it("IMP-12: an expired upload (404 on commit) offers to start over", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard />, {
      "POST /imports/prices/validate": ok({ ...validPrices, prices_already_adjusted: false }),
      "POST /imports/prices/commit": fail(404, "NOT_FOUND", "Upload not found"),
    });
    await upload(user);
    await user.click(await screen.findByTestId("wizard-next"));
    await user.click(screen.getByTestId("wizard-commit"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("import-expired")).textContent).toContain("expired");
    await user.click(screen.getByTestId("import-restart"));
    expect(screen.getByTestId("import-file")).toBeTruthy();
  });
});

describe("instruments wizard (IMP-20 UI path)", () => {
  it("lists warnings without blocking, hides the adjustment choice and shows renamed counts", async () => {
    const user = userEvent.setup();
    renderWith(<ImportWizard initialKind="instruments" />, {
      "POST /imports/instruments/validate": ok(validInstruments),
      "POST /imports/instruments/commit": ok({ ...commitOk, renamed: 1 }),
    });
    expect(screen.getByTestId("import-template-link").getAttribute("href")).toBe(
      "/api/v1/imports/templates/instruments",
    );
    await upload(user);
    expect((await screen.findByTestId("import-warning-row")).textContent).toContain("isin");
    expect(screen.queryByTestId("adjustment-choice")).toBeNull();
    expect(screen.queryByTestId("import-growth")).toBeNull();
    await user.click(screen.getByTestId("wizard-next"));
    await user.click(screen.getByTestId("wizard-commit"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("result-renamed")).textContent).toContain("1");
    expect(screen.getByTestId("result-undo-note").textContent).toContain(
      "Instrument batches cannot be undone",
    );
  });
});
