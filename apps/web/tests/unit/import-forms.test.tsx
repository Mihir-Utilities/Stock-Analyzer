import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddStockForm } from "@/components/imports/AddStockForm";
import { DeletePricesAction } from "@/components/imports/DeletePricesAction";
import { ImportCenter, RIGHTS_NOTICE } from "@/components/imports/ImportCenter";
import { StorageMeter } from "@/components/imports/StorageMeter";
import { TrimHistory } from "@/components/imports/TrimHistory";
import { warnLevelFor } from "@/lib/imports/storage";
import { formatCell } from "@/components/imports/IssueLists";
import { DASH, formatMb } from "@/lib/format";
import { dbStatus, fail, ok, stockIndex, trimPreview } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";

function renderWith(ui: ReactElement, routes: Record<string, Handler>) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return mock;
}

function openDialog(): HTMLElement {
  const d = document.querySelector("dialog[open]");
  if (!d) throw new Error("no open dialog");
  return d as HTMLElement;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("Add stock form (INS-15 UI path)", () => {
  it("creates a stock, shows the warning codes as sentences and clears the form", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<AddStockForm />, {
      "POST /instruments": ok(
        { id: 1, symbol: "TCS", warnings: ["ISIN_MALFORMED", "SYMBOL_UPPERCASED"] },
        201,
      ),
    });
    await user.type(screen.getByTestId("add-stock-symbol"), "tcs");
    await user.type(screen.getByTestId("add-stock-name"), "Tata Consultancy Services Ltd");
    await user.type(screen.getByTestId("add-stock-isin"), "BAD");
    await user.click(screen.getByTestId("add-stock-submit"));
    expect((await screen.findByTestId("add-stock-added")).textContent).toContain("Added TCS");
    const warns = screen.getAllByTestId("add-stock-warning").map((w) => w.textContent);
    expect(warns.join(" ")).toContain("without an ISIN");
    expect(warns.join(" ")).toContain("upper case");
    expect(mock.calls[0]?.body).toEqual({
      symbol: "tcs",
      name: "Tata Consultancy Services Ltd",
      isin: "BAD",
    });
    expect(mock.calls[0]?.headers.get("X-Requested-With")).toBe("fetch");
    expect((screen.getByTestId("add-stock-symbol") as HTMLInputElement).value).toBe("");
  });

  it("omits an empty ISIN and requires symbol and name before calling the API", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<AddStockForm />, {
      "POST /instruments": ok({ id: 2, symbol: "INFY", warnings: [] }, 201),
    });
    await user.click(screen.getByTestId("add-stock-submit"));
    expect(screen.getAllByTestId("form-field-error")).toHaveLength(2);
    expect(mock.calls).toHaveLength(0);
    await user.type(screen.getByTestId("add-stock-symbol"), "INFY");
    await user.type(screen.getByTestId("add-stock-name"), "Infosys Ltd");
    await user.click(screen.getByTestId("add-stock-submit"));
    await screen.findByTestId("add-stock-added");
    expect(mock.calls[0]?.body).toEqual({ symbol: "INFY", name: "Infosys Ltd" });
  });

  it("409 points to instruments.csv and 422 shows the field message", async () => {
    const user = userEvent.setup();
    let n = 0;
    renderWith(<AddStockForm />, {
      "POST /instruments": () =>
        n++ === 0
          ? fail(409, "CONFLICT", "exists")
          : fail(422, "UNPROCESSABLE", "invalid", {
              fields: [{ field: "symbol", message: "symbol may only contain A-Z, 0-9, & and -" }],
            }),
    });
    await user.type(screen.getByTestId("add-stock-symbol"), "TCS");
    await user.type(screen.getByTestId("add-stock-name"), "Tata");
    await user.click(screen.getByTestId("add-stock-submit"));
    expect((await screen.findByTestId("form-field-error")).textContent).toContain(
      "instruments.csv",
    );
    await user.click(screen.getByTestId("add-stock-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("form-field-error").textContent).toContain("may only contain"),
    );
  });
});

describe("Delete prices between dates (PRC-21 UI path)", () => {
  it("previews the count, confirms, then deletes with from/to and confirm=true", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<DeletePricesAction symbol="TCS" />, {
      "POST /stocks/TCS/prices/delete-preview": ok({ rows: 120 }),
      "DELETE /stocks/TCS/prices": ok({ deleted: 120, job_id: 14, batch_id: 31 }),
    });
    await user.type(screen.getByTestId("delete-from"), "2020-01-01");
    await user.type(screen.getByTestId("delete-to"), "2020-12-31");
    await user.click(screen.getByTestId("delete-preview"));
    expect((await screen.findByTestId("delete-preview-result")).textContent).toContain("120 rows");
    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(screen.getByTestId("delete-open-confirm"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("delete-done")).textContent).toContain("Deleted 120 rows");
    const del = mock.calls.find((c) => c.method === "DELETE");
    expect(del?.query.get("from")).toBe("2020-01-01");
    expect(del?.query.get("to")).toBe("2020-12-31");
    expect(del?.body).toEqual({ confirm: true });
    expect(del?.headers.get("X-Requested-With")).toBe("fetch");
  });

  it("from after to is rejected before any request; zero rows offers no delete button", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<DeletePricesAction symbol="TCS" />, {
      "POST /stocks/TCS/prices/delete-preview": ok({ rows: 0 }),
    });
    await user.type(screen.getByTestId("delete-from"), "2021-01-01");
    await user.type(screen.getByTestId("delete-to"), "2020-01-01");
    await user.click(screen.getByTestId("delete-preview"));
    expect(screen.getByTestId("form-field-error").textContent).toContain("must not be before");
    expect(mock.calls).toHaveLength(0);
    await user.clear(screen.getByTestId("delete-to"));
    await user.type(screen.getByTestId("delete-to"), "2021-06-01");
    await user.click(screen.getByTestId("delete-preview"));
    expect((await screen.findByTestId("delete-preview-result")).textContent).toContain(
      "Nothing to delete",
    );
    expect(screen.queryByTestId("delete-open-confirm")).toBeNull();
  });

  it("an unknown or renamed symbol is a plain not-found message", async () => {
    const user = userEvent.setup();
    renderWith(<DeletePricesAction />, {
      "POST /stocks/OLD/prices/delete-preview": fail(404, "NOT_FOUND", "Instrument not found"),
    });
    await user.type(screen.getByTestId("delete-symbol"), "old");
    await user.type(screen.getByTestId("delete-from"), "2020-01-01");
    await user.type(screen.getByTestId("delete-to"), "2020-02-01");
    await user.click(screen.getByTestId("delete-preview"));
    expect((await screen.findByTestId("delete-not-found")).textContent).toContain("current symbol");
  });
});

describe("Trim history (D-C)", () => {
  const routes: Record<string, Handler> = {
    "GET /stocks/index": stockIndex,
    "POST /prices/trim/preview": ok(trimPreview),
    "POST /prices/trim": ok({
      deleted: 200,
      per_symbol: trimPreview.per_symbol,
      batch_id: 32,
      job_id: 15,
    }),
  };

  it("lists only stocks with prices, previews rows and MB freed, confirms, then trims", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<TrimHistory />, routes);
    await screen.findByTestId("trim-stock-TCS");
    expect(screen.queryByTestId("trim-stock-IDLE")).toBeNull();
    await user.click(screen.getByTestId("trim-preview"));
    expect(
      screen.getAllByTestId("form-field-error").length +
        screen.getAllByTestId("trim-symbols-error").length,
    ).toBeGreaterThan(1);
    await user.click(screen.getByTestId("trim-stock-TCS"));
    await user.click(screen.getByTestId("trim-stock-INFY"));
    await user.type(screen.getByTestId("trim-before"), "2021-01-01");
    await user.click(screen.getByTestId("trim-preview"));
    const result = await screen.findByTestId("trim-preview-result");
    expect(result.textContent).toContain("200 rows");
    expect(result.textContent).toContain("0.02 MB");
    expect(mock.calls.find((c) => c.path === "/prices/trim/preview")?.body).toEqual({
      symbols: ["TCS", "INFY"],
      before: "2021-01-01",
    });
    await user.click(screen.getByTestId("trim-open-confirm"));
    await user.click(within(openDialog()).getByTestId("confirm-ok"));
    expect((await screen.findByTestId("trim-done")).textContent).toContain("Deleted 200 rows");
    expect(mock.calls.find((c) => c.path === "/prices/trim")?.body).toEqual({
      symbols: ["TCS", "INFY"],
      before: "2021-01-01",
      confirm: true,
    });
  });

  it("changing the selection discards the preview, so a stale count cannot be confirmed", async () => {
    const user = userEvent.setup();
    renderWith(<TrimHistory />, routes);
    await user.click(await screen.findByTestId("trim-stock-TCS"));
    await user.type(screen.getByTestId("trim-before"), "2021-01-01");
    await user.click(screen.getByTestId("trim-preview"));
    await screen.findByTestId("trim-open-confirm");
    await user.click(screen.getByTestId("trim-stock-INFY"));
    expect(screen.queryByTestId("trim-open-confirm")).toBeNull();
    expect(screen.queryByTestId("trim-preview-result")).toBeNull();
  });

  it("empty state when no stock has prices", async () => {
    renderWith(<TrimHistory />, {
      "GET /stocks/index": ok({ generated_at: "x", count: 0, items: [] }),
    });
    expect(await screen.findByTestId("trim-empty")).toBeTruthy();
  });
});

describe("Storage meter (D-C thresholds)", () => {
  it("warnLevelFor uses 70/85/95/100 percent of 380 MB", () => {
    expect(warnLevelFor(265.9)).toBe("ok");
    expect(warnLevelFor(266)).toBe("70");
    expect(warnLevelFor(323)).toBe("85");
    expect(warnLevelFor(361)).toBe("95");
    expect(warnLevelFor(380)).toBe("limit");
  });

  it("shows size, percent and a warning at 85% with a text signal, not colour alone", async () => {
    renderWith(<StorageMeter />, { "GET /admin/status": dbStatus(330) });
    expect((await screen.findByTestId("storage-size-text")).textContent).toContain(
      "330.0 MB of 380 MB (86.8%)",
    );
    const bar = screen.getByTestId("storage-meter-bar");
    expect(bar.getAttribute("role")).toBe("meter");
    expect(bar.getAttribute("data-level")).toBe("85");
    expect(screen.getByTestId("storage-meter").textContent).toContain("85% of the budget is used");
  });

  it("an unavailable status (501) is an error card, never 0 MB", async () => {
    renderWith(<StorageMeter />, {
      "GET /admin/status": fail(501, "NOT_IMPLEMENTED", "not implemented"),
    });
    const card = await screen.findByTestId("storage-meter");
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("error"));
    expect(card.textContent).not.toContain("0.0 MB");
  });
});

describe("Import center (SAF-05, rights notice)", () => {
  it("shows the rights notice, the built tabs and no Screener option (SAF-05)", () => {
    renderWith(<ImportCenter />, { "GET /admin/status": dbStatus(10) });
    expect(screen.getByTestId("rights-notice").textContent).toBe(RIGHTS_NOTICE);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Upload", "Templates", "Manual forms", "Batches", "Storage"]);
    expect(document.body.textContent?.toLowerCase()).not.toContain("screener");
  });

  it("Storage tab holds the meter, Trim history and Delete prices", async () => {
    const user = userEvent.setup();
    renderWith(<ImportCenter />, {
      "GET /admin/status": dbStatus(10),
      "GET /stocks/index": stockIndex,
    });
    await user.click(screen.getByTestId("tab-storage"));
    expect(await screen.findByTestId("storage-meter")).toBeTruthy();
    expect(screen.getByTestId("trim-history")).toBeTruthy();
    expect(screen.getByTestId("delete-prices")).toBeTruthy();
  });
});

describe("import screens format through lib/format (F03), never as 0 for unknown values", () => {
  it("renders the dash with a reason for null, NaN and Infinity", () => {
    for (const v of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = formatMb(v);
      expect(f.text).toBe(DASH);
      expect(f.reason).not.toBeNull();
    }
    expect(formatCell("")).toBe(DASH);
    expect(formatCell(null)).toBe(DASH);
    expect(formatCell(0)).toBe("0");
    expect(formatMb(0.01).text).toBe("0.01 MB");
  });
});

describe("UI-32: a double click on a destructive confirmation sends one request", () => {
  /** Holds DELETE/trim POSTs until released so the second click arrives while the first is in flight. */
  function hold(mock: ReturnType<typeof renderWith>, match: (m: string, p: string) => boolean) {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      return match(method, url.pathname)
        ? gate.then(() => mock.impl(input, init))
        : mock.impl(input, init);
    });
    return release;
  }

  it("Delete prices", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<DeletePricesAction symbol="TCS" />, {
      "POST /stocks/TCS/prices/delete-preview": ok({ rows: 120 }),
      "DELETE /stocks/TCS/prices": ok({ deleted: 120, job_id: 14, batch_id: 31 }),
    });
    await user.type(screen.getByTestId("delete-from"), "2020-01-01");
    await user.type(screen.getByTestId("delete-to"), "2020-12-31");
    await user.click(screen.getByTestId("delete-preview"));
    await user.click(await screen.findByTestId("delete-open-confirm"));
    const release = hold(mock, (m) => m === "DELETE");
    const okBtn = within(openDialog()).getByTestId("confirm-ok");
    fireEvent.click(okBtn);
    fireEvent.click(okBtn);
    release();
    await screen.findByTestId("delete-done");
    expect(mock.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("Trim history", async () => {
    const user = userEvent.setup();
    const mock = renderWith(<TrimHistory />, {
      "GET /stocks/index": stockIndex,
      "POST /prices/trim/preview": ok(trimPreview),
      "POST /prices/trim": ok({
        deleted: 200,
        per_symbol: trimPreview.per_symbol,
        batch_id: 32,
        job_id: 15,
      }),
    });
    await user.click(await screen.findByTestId("trim-stock-TCS"));
    await user.type(screen.getByTestId("trim-before"), "2021-01-01");
    await user.click(screen.getByTestId("trim-preview"));
    await user.click(await screen.findByTestId("trim-open-confirm"));
    const release = hold(mock, (m, p) => m === "POST" && p.endsWith("/prices/trim"));
    const okBtn = within(openDialog()).getByTestId("confirm-ok");
    fireEvent.click(okBtn);
    fireEvent.click(okBtn);
    release();
    await screen.findByTestId("trim-done");
    expect(mock.calls.filter((c) => c.path === "/prices/trim")).toHaveLength(1);
  });
});

describe("UI-24: import screens show ISO dates through formatDate", () => {
  it("the delete preview and the dialog show 1 Jan 2020, not 2020-01-01", async () => {
    const user = userEvent.setup();
    renderWith(<DeletePricesAction symbol="TCS" />, {
      "POST /stocks/TCS/prices/delete-preview": ok({ rows: 120 }),
    });
    await user.type(screen.getByTestId("delete-from"), "2020-01-01");
    await user.type(screen.getByTestId("delete-to"), "2020-12-31");
    await user.click(screen.getByTestId("delete-preview"));
    const text = (await screen.findByTestId("delete-preview-result")).textContent ?? "";
    expect(text).toContain("1 Jan 2020");
    expect(text).toContain("31 Dec 2020");
    expect(text).not.toContain("2020-01-01");
    await user.click(screen.getByTestId("delete-open-confirm"));
    expect(openDialog().textContent).toContain("1 Jan 2020");
  });
});
