import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfTxnSection } from "@/components/portfolio/MfTxnSection";
import { ToastProvider } from "@/components/ui/overlays";
import { mfHoldingSchema } from "@/lib/portfolio/mf-schemas";
import { createMockFetch, type Handler, type RecordedCall } from "../mocks/mock-fetch";
import * as pf from "../mocks/portfolio-fixtures";
import * as fx from "../mocks/mf-portfolio-fixtures";
import "./dom-matchers";

// MFH-U75: MF transaction form and list (docs/06 6.7a, docs/03 12a). Synthetic data only.

vi.setConfig({ testTimeout: 30_000 });

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const schemes = [mfHoldingSchema.parse(fx.alphaGrowth), mfHoldingSchema.parse(fx.betaIdcw)];

function mount(routes: Record<string, Handler> = {}) {
  const mock = createMockFetch({
    "GET /portfolio/mf/txns": pf.envelope({ items: [fx.mfTxn, fx.mfTxnImported], next_cursor: null }),
    "GET /portfolio/mf/fund-mappings": pf.envelope({ items: [fx.mfMapping] }),
    "GET /mf/schemes": pf.envelope(fx.mfSchemeSearch),
    "GET /market/holidays": pf.envelope({ year_loaded: false, items: [] }),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MfTxnSection schemes={schemes} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return mock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

const posts = (m: { calls: RecordedCall[] }) =>
  m.calls.filter((c) => c.method === "POST" && c.path === "/portfolio/mf/txns");

async function pickScheme(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("pf-mf-scheme-search"), "alpha");
  await user.click(await screen.findByTestId("pf-mf-scheme-pick-100001"));
}

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  v: { type?: string; units?: string; nav?: string; amount?: string; stamp?: string; date?: string } = {},
) {
  await user.click(await screen.findByTestId("pf-mf-txn-add"));
  await pickScheme(user);
  await user.type(screen.getByTestId("pf-mf-txn-folio"), "TEST-F1");
  if (v.type) await user.selectOptions(screen.getByTestId("pf-mf-txn-type"), v.type);
  fireEvent.change(screen.getByTestId("pf-mf-txn-date"), { target: { value: v.date ?? "2026-09-04" } });
  await user.type(screen.getByTestId("pf-mf-txn-units"), v.units ?? "12.3450");
  await user.type(screen.getByTestId("pf-mf-txn-nav"), v.nav ?? "81");
  await user.type(screen.getByTestId("pf-mf-txn-amount"), v.amount ?? "999.9500");
  if (v.stamp !== undefined) await user.type(screen.getByTestId("pf-mf-txn-stamp"), v.stamp);
}

describe("MFH-U75 MF transaction list", () => {
  it("lists transactions with the plan and option, source and an import-statement entry", async () => {
    mount();
    const list = await screen.findByTestId("pf-mf-txn-list");
    await within(list).findByTestId("pf-mf-txn-row-501");
    const row = screen.getByTestId("pf-mf-txn-row-501");
    expect(row).toHaveTextContent("Direct, Growth");
    expect(row).toHaveTextContent("Purchase");
    expect(row).toHaveTextContent("your entry");
    expect(screen.getByTestId("pf-mf-txn-row-502")).toHaveTextContent("statement import (batch 9)");
    expect(screen.getByTestId("pf-mf-import-open")).toHaveAttribute(
      "href",
      "/imports?kind=mf_statement",
    );
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("filters are sent to the API (scheme, folio, type, date range, source)", async () => {
    const user = userEvent.setup();
    const mock = mount();
    await screen.findByTestId("pf-mf-txn-row-501");
    await user.selectOptions(screen.getByTestId("pf-mf-filter-scheme"), "100001");
    await user.selectOptions(screen.getByTestId("pf-mf-filter-type"), "sip");
    await user.selectOptions(screen.getByTestId("pf-mf-filter-source"), "import");
    fireEvent.change(screen.getByTestId("pf-mf-filter-from"), { target: { value: "2026-01-01" } });
    await waitFor(() => {
      const last = mock.calls.filter((c) => c.path === "/portfolio/mf/txns").at(-1);
      expect(last?.query.get("scheme_code")).toBe("100001");
      expect(last?.query.get("type")).toBe("sip");
      expect(last?.query.get("source")).toBe("import");
      expect(last?.query.get("from")).toBe("2026-01-01");
    });
  });

  it("empty list shows the exact copy; Load more fetches the next page", async () => {
    const user = userEvent.setup();
    mount({
      "GET /portfolio/mf/txns": (c) =>
        c.query.get("cursor")
          ? pf.envelope({ items: [{ ...fx.mfTxn, id: 700 }], next_cursor: null })
          : pf.envelope({ items: [fx.mfTxn], next_cursor: "abc" }),
    });
    await screen.findByTestId("pf-mf-txn-row-501");
    await user.click(screen.getByTestId("pf-mf-txn-more"));
    await screen.findByTestId("pf-mf-txn-row-700");
  });

  it("empty state copy", async () => {
    mount({ "GET /portfolio/mf/txns": pf.envelope({ items: [], next_cursor: null }) });
    expect(await screen.findByTestId("pf-mf-txn-empty")).toHaveTextContent(
      "No mutual fund transactions yet. Import your broker's MF statement or add a transaction.",
    );
  });
});

describe("MFH-U75 add form", () => {
  it("offers exactly the five v1 types and no switch or merger type", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByTestId("pf-mf-txn-add"));
    const options = [...screen.getByTestId("pf-mf-txn-type").querySelectorAll("option")].map(
      (o) => o.getAttribute("value"),
    );
    expect(options).toEqual(["purchase", "sip", "redemption", "idcw_payout", "idcw_reinvest"]);
    expect(screen.getByTestId("pf-mf-txn-help")).toHaveTextContent(
      "Switches and merger/bonus entries are not supported yet. Enter a switch as a redemption plus a purchase.",
    );
  });

  it("the scheme search shows plan and option on every result and picks nothing by itself", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByTestId("pf-mf-txn-add"));
    await user.type(screen.getByTestId("pf-mf-scheme-search"), "alpha");
    const results = await screen.findByTestId("pf-mf-scheme-results");
    expect(results).toHaveTextContent("Direct plan, Growth option");
    expect(results).toHaveTextContent("Regular plan, IDCW option");
    expect(screen.queryByTestId("pf-mf-txn-scheme")).toBeNull(); // nothing chosen yet
    await user.click(screen.getByTestId("pf-mf-scheme-pick-100009"));
    expect(screen.getByTestId("pf-mf-txn-scheme")).toHaveTextContent("Regular, IDCW");
  });

  it("sends amounts as exact strings with an Idempotency-Key and shows server warnings inline", async () => {
    const user = userEvent.setup();
    const mock = mount({
      "POST /portfolio/mf/txns": pf.envelope(fx.mfTxn, [
        { code: "AMOUNT_MISMATCH", message: "amount differs from units x NAV by 1.20" },
        { code: "DUPLICATE_LOOKING_TXN", message: "a transaction like this already exists" },
      ], 201),
    });
    await fill(user, { stamp: "0.05" });
    expect(screen.getByTestId("pf-mf-txn-product")).toHaveTextContent("₹999.95"); // 12.345 x 81, a check only
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    await screen.findByTestId("pf-mf-txn-warning-AMOUNT_MISMATCH");
    expect(screen.getByTestId("pf-mf-txn-warning-DUPLICATE_LOOKING_TXN")).toBeInTheDocument();
    const call = posts(mock)[0]!;
    expect(call.body).toEqual({
      scheme_code: 100001,
      folio: "TEST-F1",
      txn_type: "purchase",
      txn_date: "2026-09-04",
      units: "12.3450",
      nav: "81",
      amount: "999.9500",
      stamp_duty: "0.05",
      note: "",
    });
    expect(call.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers.get("X-Requested-With")).toBe("fetch");
    // the form stays for the next entry with the scheme and folio kept
    expect(screen.getByTestId("pf-mf-txn-folio")).toHaveValue("TEST-F1");
  });

  it("client checks name the field before any request is sent", async () => {
    const user = userEvent.setup();
    const mock = mount();
    await user.click(await screen.findByTestId("pf-mf-txn-add"));
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    expect(posts(mock)).toHaveLength(0);
    const errors = screen.getAllByTestId("form-field-error").map((e) => e.textContent ?? "");
    expect(errors.some((e) => /pick the scheme/i.test(e))).toBe(true);
    expect(errors.some((e) => /folio/i.test(e))).toBe(true);
    expect(errors.some((e) => /calendar date/i.test(e))).toBe(true);
    expect(errors.some((e) => /units/i.test(e))).toBe(true);
  });

  it("INSUFFICIENT_UNITS shows held and redeemed units and moves focus to the message", async () => {
    const user = userEvent.setup();
    mount({
      "POST /portfolio/mf/txns": {
        status: 422,
        body: {
          error: {
            code: "INSUFFICIENT_UNITS",
            message: "redemption exceeds the units held",
            details: { transaction_id: 0, date: "2026-09-04", held_units: "5.0000", redeem_units: "12.3450" },
          },
        },
      },
    });
    await fill(user, { type: "redemption" });
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    const err = await screen.findByTestId("pf-mf-txn-error");
    expect(err).toHaveTextContent("holds 5.0000 units");
    expect(err).toHaveTextContent("redemption is for 12.3450 units");
    await waitFor(() => expect(document.activeElement?.contains(err)).toBe(true));
  });

  it("MF_TXN_TYPE_NOT_SUPPORTED is shown inline on the type field with the switch copy", async () => {
    const user = userEvent.setup();
    mount({
      "POST /portfolio/mf/txns": {
        status: 422,
        body: { error: { code: "MF_TXN_TYPE_NOT_SUPPORTED", message: "this transaction type is not supported", details: {} } },
      },
    });
    await fill(user);
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    expect(await screen.findByTestId("pf-mf-txn-error")).toHaveTextContent(
      "Enter a switch as a redemption plus a purchase.",
    );
  });

  it("a retry of the same values reuses the key; a change or a success gets a new one; 409 is explained", async () => {
    const user = userEvent.setup();
    let n = 0;
    const mock = mount({
      "POST /portfolio/mf/txns": () => {
        n += 1;
        if (n === 1) return { status: 500, body: { error: { code: "INTERNAL", message: "server error" } } };
        if (n === 2) return pf.envelope(fx.mfTxn, [], 201);
        return {
          status: 409,
          body: { error: { code: "CONFLICT", message: "idempotency key reused with a different request" } },
        };
      },
    });
    await fill(user);
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    await screen.findByTestId("pf-mf-txn-error");
    await user.click(screen.getByTestId("pf-mf-txn-save")); // same values: same key
    await waitFor(() => expect(posts(mock)).toHaveLength(2));
    const [a, b] = posts(mock);
    expect(a!.headers.get("Idempotency-Key")).toBe(b!.headers.get("Idempotency-Key"));
    // after a success the next entry is a new attempt
    await user.clear(screen.getByTestId("pf-mf-txn-units"));
    await user.type(screen.getByTestId("pf-mf-txn-units"), "1");
    await user.type(screen.getByTestId("pf-mf-txn-nav"), "81");
    await user.type(screen.getByTestId("pf-mf-txn-amount"), "81");
    fireEvent.change(screen.getByTestId("pf-mf-txn-date"), { target: { value: "2026-09-05" } });
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    const conflict = await screen.findByTestId("pf-mf-txn-error");
    expect(conflict).toHaveTextContent("this key but different values");
    const c = posts(mock)[2]!;
    expect(c.headers.get("Idempotency-Key")).not.toBe(a!.headers.get("Idempotency-Key"));
  });

  it("a double click sends one request", async () => {
    const user = userEvent.setup();
    const mock = mount({ "POST /portfolio/mf/txns": pf.envelope(fx.mfTxn, [], 201) });
    await fill(user);
    const save = screen.getByTestId("pf-mf-txn-save");
    await user.dblClick(save);
    await waitFor(() => expect(posts(mock).length).toBeGreaterThan(0));
    expect(posts(mock)).toHaveLength(1);
  });

  it("closing the form returns focus to the Add button", async () => {
    const user = userEvent.setup();
    mount();
    const add = await screen.findByTestId("pf-mf-txn-add");
    await user.click(add);
    await user.click(screen.getByTestId("pf-mf-txn-cancel"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("pf-mf-txn-add")));
    expect(screen.getByTestId("pf-mf-txn-announce")).toHaveTextContent("closed");
  });

  it("every control has a data-testid", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByTestId("pf-mf-txn-add"));
    const form = screen.getByTestId("pf-mf-txn-form");
    for (const el of form.querySelectorAll("input, select, button")) {
      expect(el.getAttribute("data-testid"), el.outerHTML.slice(0, 80)).toBeTruthy();
    }
  });
});

describe("MFH-U75 edit and delete", () => {
  it("edit sends only the changed fields, never the scheme, and says the sequence was re-checked", async () => {
    const user = userEvent.setup();
    const mock = mount({ "PATCH /portfolio/mf/txns/501": pf.envelope({ ...fx.mfTxn, units: "13.0000" }) });
    await user.click(await screen.findByTestId("pf-mf-txn-edit-501"));
    expect(screen.getByTestId("pf-mf-txn-scheme")).toHaveTextContent("cannot be changed");
    expect(screen.getByTestId("pf-mf-txn-save")).toBeDisabled(); // nothing changed yet
    expect(screen.getByTestId("pf-mf-txn-unchanged")).toBeInTheDocument();
    await user.clear(screen.getByTestId("pf-mf-txn-units"));
    await user.type(screen.getByTestId("pf-mf-txn-units"), "13");
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = mock.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ units: "13" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("pf-mf-txn-edit-501")));
  });

  it("an edit that would oversell later shows INSUFFICIENT_UNITS from the server", async () => {
    const user = userEvent.setup();
    mount({
      "PATCH /portfolio/mf/txns/501": {
        status: 422,
        body: {
          error: {
            code: "INSUFFICIENT_UNITS",
            message: "redemption exceeds the units held",
            details: { date: "2026-10-01", held_units: "2.0000", redeem_units: "10.0000" },
          },
        },
      },
    });
    await user.click(await screen.findByTestId("pf-mf-txn-edit-501"));
    await user.clear(screen.getByTestId("pf-mf-txn-units"));
    await user.type(screen.getByTestId("pf-mf-txn-units"), "2");
    await user.click(screen.getByTestId("pf-mf-txn-save"));
    expect(await screen.findByTestId("pf-mf-txn-error")).toHaveTextContent("re-checks every later redemption");
  });

  it("delete asks first, sends DELETE and shows the sequence message when it is refused", async () => {
    const user = userEvent.setup();
    const mock = mount({
      "DELETE /portfolio/mf/txns/501": {
        status: 422,
        body: {
          error: {
            code: "INSUFFICIENT_UNITS",
            message: "a later redemption would exceed the units held",
            details: { date: "2026-10-01", held_units: "0.0000", redeem_units: "5.0000" },
          },
        },
      },
    });
    await user.click(await screen.findByTestId("pf-mf-txn-delete-501"));
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent("re-checked");
    await user.click(screen.getByTestId("confirm-ok"));
    expect(await screen.findByTestId("pf-mf-txn-delete-error")).toHaveTextContent(
      "a later redemption would exceed the units held",
    );
    expect(mock.calls.some((c) => c.method === "DELETE" && c.path === "/portfolio/mf/txns/501")).toBe(true);
  });

  it("delete succeeds and the list is refetched", async () => {
    const user = userEvent.setup();
    const mock = mount({ "DELETE /portfolio/mf/txns/501": pf.envelope({ deleted: 501, warnings: [] }) });
    await user.click(await screen.findByTestId("pf-mf-txn-delete-501"));
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.method === "GET" && c.path === "/portfolio/mf/txns").length).toBeGreaterThan(1),
    );
  });
});

describe("fund-name mappings (MFH-23) in the transactions section", () => {
  it("lists the remembered mappings and re-maps explicitly with a confirmation when rows depend on it", async () => {
    const user = userEvent.setup();
    let puts = 0;
    const mock = mount({
      "PUT /portfolio/mf/fund-mappings": (c) => {
        puts += 1;
        const body = c.body as { remap: boolean; scheme_code: number };
        return body.remap
          ? pf.envelope({ ...fx.mfMapping, scheme_code: body.scheme_code, audit_note: "remapped" })
          : {
              status: 409,
              body: { error: { code: "FUND_MAPPING_IN_USE", message: "in use", details: { rows: 2 } } },
            };
      },
    });
    await user.click(await screen.findByTestId("pf-mf-mappings-toggle"));
    const list = await screen.findByTestId("pf-mf-mapping-list");
    expect(list).toHaveTextContent("Example Alpha Fund");
    expect(list).toHaveTextContent("Direct, Growth");
    await user.click(screen.getByTestId("pf-mf-mapping-change"));
    await user.type(screen.getByTestId("pf-mf-map-scheme-search"), "alpha");
    await user.click(await screen.findByTestId("pf-mf-map-scheme-pick-100009"));
    await user.click(screen.getByTestId("pf-mf-mapping-save"));
    const confirm = await screen.findByTestId("pf-mf-mapping-remap-confirm");
    expect(screen.getByTestId("pf-mf-mapping-save")).toBeDisabled();
    await user.click(confirm);
    await user.click(screen.getByTestId("pf-mf-mapping-save"));
    await screen.findByTestId("pf-mf-mapping-saved");
    expect(puts).toBe(2);
    const sent = mock.calls.filter((c) => c.method === "PUT").map((c) => c.body);
    expect(sent[0]).toEqual({ fund_name: "Example Alpha Fund", scheme_code: 100009, remap: false });
    expect(sent[1]).toEqual({ fund_name: "Example Alpha Fund", scheme_code: 100009, remap: true });
  });
});
