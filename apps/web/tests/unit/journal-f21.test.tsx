import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JournalTab } from "@/components/stock/journal/JournalTab";
import { ToastProvider } from "@/components/ui/overlays";
import {
  charCount,
  describeNoteError,
  nextNoteAttempt,
  NOTE_MAX,
  validateNote,
} from "@/lib/journal/form";
import { ApiError } from "@/lib/api/client";
import { journalPageSchema } from "@/lib/journal/schemas";
import { fail, ok } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler, type RecordedCall } from "../mocks/mock-fetch";
import "./dom-matchers";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => vi.unstubAllGlobals());

type Row = Record<string, unknown>;

const note = (id: number, over: Row = {}): Row => ({
  id,
  symbol: "ACME",
  noted_on: "2026-11-01",
  note: `Reason ${id}`,
  price_at_note: "101.2500",
  price_as_of: "2026-10-30",
  price_source: "your imported prices",
  price_reason: null,
  review_on: null,
  status: "open",
  reviewed_at: null,
  review_due: false,
  portfolio_txn_id: null,
  txn: null,
  ...over,
});

const page = (items: Row[], over: Row = {}) =>
  ok({ items, next_cursor: null, today: "2026-11-12", review_due_count: 0, ...over });

const txnRow = {
  id: 42,
  symbol: "ACME",
  name: "Acme Ltd",
  side: "buy",
  qty: "10.0000",
  price: "3500.0000",
  fees: "0.0000",
  trade_date: "2026-09-01",
  note: null,
};

function mount(routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /stocks/ACME/journal": page([]),
    "GET /portfolio/txns": ok({ items: [txnRow], next_cursor: null }),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <JournalTab symbol="ACME" />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { mock, view };
}

const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST");

describe("JRN-25 states", () => {
  it("shows a skeleton, then the empty copy with the Add button", async () => {
    mount({});
    expect(screen.getByTestId("jrn-loading")).toBeInTheDocument();
    expect(await screen.findByTestId("jrn-empty")).toHaveTextContent(
      "No notes yet for ACME. Add one to remember why you are interested.",
    );
    expect(screen.getByTestId("jrn-add")).toBeInTheDocument();
    expect(screen.queryByTestId("jrn-due-count")).toBeNull();
  });

  it("the filter refetches with the status and shows the filtered empty copy", async () => {
    const user = userEvent.setup();
    const { mock } = mount({
      "GET /stocks/ACME/journal": (c) =>
        c.query.get("status") === "reviewed" ? page([]) : page([note(1)]),
    });
    await screen.findByTestId("jrn-item-1");
    await user.selectOptions(screen.getByTestId("jrn-filter"), "reviewed");
    expect(await screen.findByTestId("jrn-empty")).toHaveTextContent("No reviewed notes.");
    expect(
      mock.calls.some(
        (c) => c.path === "/stocks/ACME/journal" && c.query.get("status") === "reviewed",
      ),
    ).toBe(true);
  });

  it("an item with malformed optional fields still shows its note; an item without an id is dropped and counted", async () => {
    mount({
      "GET /stocks/ACME/journal": page([
        note(1, { price_at_note: 12.5, price_as_of: 7, review_on: {}, status: "weird", txn: "x" }),
        { note: "no id", symbol: "ACME" },
        note(3, { price_at_note: null, price_as_of: null, price_reason: "no_price_imported" }),
      ]),
    });
    const first = await screen.findByTestId("jrn-item-1");
    expect(within(first).getByTestId("jrn-text-1")).toHaveTextContent("Reason 1");
    expect(within(first).getByTestId("jrn-price-1")).toHaveTextContent("Price then: unavailable.");
    expect(within(first).getByTestId("jrn-review-1")).toHaveTextContent("No review date.");
    expect(screen.getByTestId("jrn-price-3")).toHaveTextContent("No imported price on that day.");
    expect(screen.getByTestId("jrn-dropped")).toHaveTextContent("1 entry could not be shown.");
    expect(screen.queryByTestId("jrn-item-undefined")).toBeNull();
  });

  it("an error shows the message, the request id and Retry that refetches", async () => {
    const user = userEvent.setup();
    let n = 0;
    mount({
      "GET /stocks/ACME/journal": () => {
        n += 1;
        return n === 1
          ? { ...fail(500, "INTERNAL", "Internal error"), headers: { "X-Request-Id": "req-9" } }
          : page([note(1)]);
      },
    });
    const err = await screen.findByTestId("jrn-load-error");
    expect(err).toHaveTextContent("Internal error (request req-9)");
    await user.click(screen.getByTestId("jrn-retry"));
    expect(await screen.findByTestId("jrn-item-1")).toBeInTheDocument();
  });

  it("load more fetches the next page with the cursor", async () => {
    const user = userEvent.setup();
    const { mock } = mount({
      "GET /stocks/ACME/journal": (c) =>
        c.query.get("cursor") ? page([note(1)]) : page([note(2)], { next_cursor: "abc" }),
    });
    await screen.findByTestId("jrn-item-2");
    await user.click(screen.getByTestId("jrn-more"));
    expect(await screen.findByTestId("jrn-item-1")).toBeInTheDocument();
    expect(mock.calls.some((c) => c.query.get("cursor") === "abc")).toBe(true);
    expect(screen.queryByTestId("jrn-more")).toBeNull();
  });
});

describe("JRN-28 review due marker comes from the API only", () => {
  it("shows the chip for review_due notes and the API count; nothing is compared with the browser clock", async () => {
    mount({
      "GET /stocks/ACME/journal": page(
        [
          note(1, { review_on: "2026-11-10", review_due: true }),
          note(2, { review_on: "2020-01-01", review_due: false, status: "reviewed" }),
          note(3, { review_on: "2099-01-01", review_due: false }),
        ],
        { review_due_count: 1 },
      ),
    });
    const due = await screen.findByTestId("jrn-due-1");
    expect(due).toHaveTextContent("Review due");
    expect(screen.queryByTestId("jrn-due-2")).toBeNull();
    expect(screen.queryByTestId("jrn-due-3")).toBeNull();
    expect(screen.getByTestId("jrn-due-count")).toHaveTextContent("1 review due");
    expect(screen.getByTestId("jrn-review-3")).toHaveTextContent("Review on 1 Jan 2099.");
  });
});

describe("JRN-29 untrusted text is rendered as text", () => {
  it("never creates elements from a note and keeps line breaks", async () => {
    const evil = `<script>window.__x=1</script><img src=x onerror=alert(1)> M&M\nsecond line`;
    mount({ "GET /stocks/ACME/journal": page([note(1, { note: evil })]) });
    const text = await screen.findByTestId("jrn-text-1");
    expect(text.textContent).toBe(evil);
    expect(text.querySelector("script, img")).toBeNull();
    expect(text.className).toContain("whitespace-pre-wrap");
  });

  it("the journal components never use dangerouslySetInnerHTML", () => {
    const dir = join(process.cwd(), "src/components/stock/journal");
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), "utf8")).not.toContain("dangerouslySetInnerHTML");
    }
    expect(
      readFileSync(join(process.cwd(), "src/components/stock/chart/AlertShortcuts.tsx"), "utf8"),
    ).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("JRN-26 the form", () => {
  it("pure validation: counter in characters, limit, control characters, date format", () => {
    expect(charCount("  ₹₹  ")).toBe(2);
    expect(validateNote({ note: "  ", reviewOn: "", txnId: "" }).errors.note).toBeTruthy();
    expect(validateNote({ note: "x".repeat(NOTE_MAX), reviewOn: "", txnId: "" }).body).toEqual({
      note: "x".repeat(NOTE_MAX),
    });
    expect(
      validateNote({ note: "x".repeat(NOTE_MAX + 1), reviewOn: "", txnId: "" }).errors.note,
    ).toContain("at most 1,000");
    expect(validateNote({ note: "a\u0007b", reviewOn: "", txnId: "" }).errors.note).toContain(
      "control",
    );
    // N5: bidi overrides and invisible-only notes are refused, ZWJ emoji stay
    const noteErr = (note: string) => validateNote({ note, reviewOn: "", txnId: "" }).errors.note;
    expect(noteErr("a‮b")).toContain("direction");
    expect(noteErr("x⁦y⁩")).toContain("direction");
    expect(noteErr("﻿")).toBeTruthy();
    expect(noteErr("​‍")).toBeTruthy();
    expect(noteErr("\u{1F468}‍\u{1F469}")).toBeUndefined();
    expect(
      validateNote({ note: "ok", reviewOn: "12/11/2026", txnId: "" }).errors.reviewOn,
    ).toBeTruthy();
    expect(validateNote({ note: "ok", reviewOn: "2026-12-01", txnId: "42" }).body).toEqual({
      note: "ok",
      review_on: "2026-12-01",
      portfolio_txn_id: 42,
    });
  });

  it("one Idempotency-Key is reused for the same body and replaced when the body changes", () => {
    let n = 0;
    const key = () => `k${++n}`;
    const a = nextNoteAttempt(null, { note: "a" }, key);
    expect(nextNoteAttempt(a, { note: "a" }, key)).toBe(a);
    expect(nextNoteAttempt(a, { note: "b" }, key).key).toBe("k2");
  });

  it("maps API field errors to fields", () => {
    const err = new ApiError("UNPROCESSABLE", "bad", 422, {
      fields: [{ field: "review_on", message: "must be today or later" }],
    });
    const v = describeNoteError(err);
    expect(v.fields.reviewOn).toBe("must be today or later");
    expect(v.message).toBe("Check the highlighted fields.");
  });

  it("shows the hint, the counter and an over-limit message; keeps the text on a server error", async () => {
    const user = userEvent.setup();
    const { mock } = mount({
      "POST /stocks/ACME/journal": fail(422, "UNPROCESSABLE", "Validation failed", {
        fields: [{ field: "review_on", message: "must be today or later" }],
      }),
    });
    await screen.findByTestId("jrn-empty");
    await user.click(screen.getByTestId("jrn-add"));
    expect(screen.getByTestId("jrn-hint")).toHaveTextContent(
      "Do not paste passwords, tokens or account numbers.",
    );
    expect(screen.getByTestId("jrn-count")).toHaveTextContent("0 of 1,000 characters");
    const box = screen.getByTestId("jrn-note") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(box);
    await user.click(box);
    await user.paste("x".repeat(1001));
    expect(screen.getByTestId("jrn-count")).toHaveTextContent(
      "1,001 of 1,000 characters. Over the limit.",
    );
    await user.click(screen.getByTestId("jrn-submit"));
    expect(await screen.findByText(/Use at most 1,000 characters/)).toBeInTheDocument();
    expect(posts(mock.calls)).toHaveLength(0); // nothing sent while invalid
    await user.clear(box);
    await user.type(box, "Because of margins");
    fireInput(screen.getByTestId("jrn-review-on"), "2026-01-01");
    await user.click(screen.getByTestId("jrn-submit"));
    expect(await screen.findByText(/must be today or later/)).toBeInTheDocument();
    expect(box.value).toBe("Because of margins"); // typed text kept
    expect(document.activeElement).toBe(screen.getByTestId("jrn-review-on")); // first invalid control
    expect(posts(mock.calls)).toHaveLength(1);
  });

  it("creating sends the Idempotency-Key and the body, announces it and returns focus to Add note", async () => {
    const user = userEvent.setup();
    const created = note(5, { note: "Because of margins", review_on: "2026-12-01" });
    let listed: Row[] = [];
    const { mock } = mount({
      "GET /stocks/ACME/journal": () => page(listed),
      "POST /stocks/ACME/journal": () => {
        listed = [created];
        return ok(created, 201);
      },
    });
    await screen.findByTestId("jrn-empty");
    await user.click(screen.getByTestId("jrn-add"));
    await user.type(screen.getByTestId("jrn-note"), "Because of margins");
    fireInput(screen.getByTestId("jrn-review-on"), "2026-12-01");
    await user.selectOptions(screen.getByTestId("jrn-txn"), "42");
    await user.click(screen.getByTestId("jrn-submit"));
    expect(await screen.findByTestId("jrn-item-5")).toBeInTheDocument();
    const call = posts(mock.calls)[0]!;
    expect(call.body).toEqual({
      note: "Because of margins",
      review_on: "2026-12-01",
      portfolio_txn_id: 42,
    });
    expect(call.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.queryByTestId("jrn-form")).toBeNull();
    expect(screen.getByTestId("jrn-live")).toHaveTextContent("Note added");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("jrn-add")));
  });

  it("a retry of the same body reuses the key; a changed body uses a new one", async () => {
    const user = userEvent.setup();
    let n = 0;
    const { mock } = mount({
      "POST /stocks/ACME/journal": () => {
        n += 1;
        return n <= 2 ? fail(500, "INTERNAL", "Internal error") : ok(note(9), 201);
      },
    });
    await screen.findByTestId("jrn-empty");
    await user.click(screen.getByTestId("jrn-add"));
    await user.type(screen.getByTestId("jrn-note"), "same");
    await user.click(screen.getByTestId("jrn-submit"));
    await screen.findByTestId("jrn-error");
    await user.click(screen.getByTestId("jrn-submit"));
    await waitFor(() => expect(posts(mock.calls)).toHaveLength(2));
    await user.type(screen.getByTestId("jrn-note"), " changed");
    await user.click(screen.getByTestId("jrn-submit"));
    await waitFor(() => expect(posts(mock.calls)).toHaveLength(3));
    const keys = posts(mock.calls).map((c) => c.headers.get("Idempotency-Key"));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("the transaction select is disabled with a reason when the stock has no transactions", async () => {
    const user = userEvent.setup();
    mount({ "GET /portfolio/txns": ok({ items: [], next_cursor: null }) });
    await screen.findByTestId("jrn-empty");
    await user.click(screen.getByTestId("jrn-add"));
    await waitFor(() =>
      expect((screen.getByTestId("jrn-txn") as HTMLSelectElement).disabled).toBe(true),
    );
    expect(screen.getByText("No transactions for this stock.")).toBeInTheDocument();
  });

  it("editing sends only the editable fields and returns focus to that entry's Edit button", async () => {
    const user = userEvent.setup();
    let row = note(3, { note: "old text" });
    const { mock } = mount({
      "GET /stocks/ACME/journal": () => page([row]),
      "PATCH /journal/3": (c) => {
        row = { ...row, ...(c.body as Row) };
        return ok(row);
      },
    });
    await user.click(await screen.findByTestId("jrn-edit-3"));
    const box = screen.getByTestId("jrn-note") as HTMLTextAreaElement;
    expect(box.value).toBe("old text");
    await user.clear(box);
    await user.type(box, "new text");
    await user.click(screen.getByTestId("jrn-submit"));
    await waitFor(() => expect(screen.queryByTestId("jrn-form")).toBeNull());
    const call = mock.calls.find((c) => c.method === "PATCH")!;
    expect(call.body).toEqual({ note: "new text", review_on: null, portfolio_txn_id: null });
    expect(screen.getByTestId("jrn-live")).toHaveTextContent("Note saved");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("jrn-edit-3")));
    expect(await screen.findByTestId("jrn-text-3")).toHaveTextContent("new text");
  });
});

describe("JRN-27 status, delete, focus and live regions", () => {
  it("Mark reviewed flips to Reopen on the same button and announces it", async () => {
    const user = userEvent.setup();
    let row = note(1);
    const { mock } = mount({
      "GET /stocks/ACME/journal": () => page([row]),
      "PATCH /journal/1": (c) => {
        row = { ...row, ...(c.body as Row), reviewed_at: "2026-11-12T10:00:00Z" };
        return ok(row);
      },
    });
    const btn = await screen.findByTestId("jrn-toggle-1");
    expect(btn).toHaveTextContent("Mark reviewed");
    expect(btn).toHaveAttribute("aria-label", "Mark reviewed, note of 1 Nov 2026");
    btn.focus();
    await user.click(btn);
    await waitFor(() => expect(screen.getByTestId("jrn-toggle-1")).toHaveTextContent("Reopen"));
    expect(mock.calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "reviewed" });
    expect(screen.getByTestId("jrn-status-1")).toHaveTextContent("Reviewed");
    expect(screen.getByTestId("jrn-live")).toHaveTextContent("Marked reviewed");
    expect(document.activeElement).toBe(screen.getByTestId("jrn-toggle-1"));
  });

  it("delete asks first; after it focus moves to the next entry, else the previous, else Add note", async () => {
    const user = userEvent.setup();
    let rows = [note(3), note(2), note(1)];
    mount({
      "GET /stocks/ACME/journal": () => page(rows),
      "DELETE /journal/3": () => {
        rows = rows.filter((r) => r.id !== 3);
        return ok({ id: 3, deleted: true });
      },
      "DELETE /journal/1": () => {
        rows = rows.filter((r) => r.id !== 1);
        return ok({ id: 1, deleted: true });
      },
      "DELETE /journal/2": () => {
        rows = rows.filter((r) => r.id !== 2);
        return ok({ id: 2, deleted: true });
      },
    });
    const confirmOk = () => {
      const d = document.querySelector('dialog[data-testid="confirm-dialog"][open]');
      if (!d) throw new Error("no open confirm dialog");
      return within(d as HTMLElement).getByTestId("confirm-ok");
    };
    await user.click(await screen.findByTestId("jrn-delete-3"));
    expect(document.querySelector('dialog[data-testid="confirm-dialog"][open]')).toHaveTextContent(
      "Delete this note? This cannot be undone.",
    );
    await user.click(confirmOk());
    await waitFor(() => expect(screen.queryByTestId("jrn-item-3")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("jrn-text-2")));
    expect(screen.getByTestId("jrn-live")).toHaveTextContent("Note deleted");
    // last entry: the previous one gets the focus
    await user.click(screen.getByTestId("jrn-delete-1"));
    await user.click(confirmOk());
    await waitFor(() => expect(screen.queryByTestId("jrn-item-1")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("jrn-text-2")));
    // only entry: Add note
    await user.click(screen.getByTestId("jrn-delete-2"));
    await user.click(confirmOk());
    await waitFor(() => expect(screen.queryByTestId("jrn-item-2")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("jrn-add")));
  });

  it("cancelling the form returns focus to Add note", async () => {
    const user = userEvent.setup();
    mount({});
    await screen.findByTestId("jrn-empty");
    await user.click(screen.getByTestId("jrn-add"));
    expect(document.activeElement).toBe(screen.getByTestId("jrn-note"));
    await user.click(screen.getByTestId("jrn-cancel"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("jrn-add")));
    expect(screen.queryByTestId("jrn-form")).toBeNull();
  });

  it("a linked transaction is shown as text", async () => {
    mount({
      "GET /stocks/ACME/journal": page([
        note(1, {
          portfolio_txn_id: 42,
          txn: {
            id: 42,
            side: "buy",
            qty: "10.0000",
            price: "3500.0000",
            trade_date: "2026-09-01",
          },
        }),
      ]),
    });
    expect(await screen.findByTestId("jrn-txn-1")).toHaveTextContent(
      "Linked to: Buy 10 at ₹3,500.00 on 1 Sept 2026".replace("Sept", "Sep"),
    );
  });
});

describe("page schema", () => {
  it("counts dropped items and tolerates a malformed count or cursor", () => {
    const p = journalPageSchema.parse({
      items: [note(1), 7, { id: -1, note: "x" }],
      next_cursor: 5,
      today: null,
      review_due_count: "many",
    });
    expect(p.items).toHaveLength(1);
    expect(p.dropped).toBe(2);
    expect(p.next_cursor).toBeNull();
    expect(p.review_due_count).toBeNull();
  });
});

function fireInput(el: HTMLElement, value: string) {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("review fixes", () => {
  it("S1: typing in the note while the review date is invalid does not steal the focus", async () => {
    const user = userEvent.setup();
    mount({
      "POST /stocks/ACME/journal": fail(422, "UNPROCESSABLE", "Validation failed", {
        fields: [{ field: "review_on", message: "must be today or later" }],
      }),
    });
    await screen.findByTestId("jrn-empty");
    await user.click(screen.getByTestId("jrn-add"));
    const box = screen.getByTestId("jrn-note") as HTMLTextAreaElement;
    await user.type(box, "first");
    fireInput(screen.getByTestId("jrn-review-on"), "2026-01-01");
    await user.click(screen.getByTestId("jrn-submit"));
    await screen.findByText(/must be today or later/);
    expect(document.activeElement).toBe(screen.getByTestId("jrn-review-on")); // focus moved on submit
    await user.click(box);
    await user.type(box, " and more words");
    expect(document.activeElement).toBe(box); // typing keeps the focus
    expect(box.value).toBe("first and more words");
  });

  it("N3: a 404 on delete counts as deleted", async () => {
    const user = userEvent.setup();
    let rows = [note(1)];
    mount({
      "GET /stocks/ACME/journal": () => page(rows),
      "DELETE /journal/1": () => {
        rows = [];
        return fail(404, "NOT_FOUND", "Journal note not found");
      },
    });
    await user.click(await screen.findByTestId("jrn-delete-1"));
    const d = document.querySelector('dialog[data-testid="confirm-dialog"][open]') as HTMLElement;
    await user.click(within(d).getByTestId("confirm-ok"));
    await waitFor(() => expect(screen.queryByTestId("jrn-item-1")).toBeNull());
    expect(screen.queryByTestId("jrn-error-action")).toBeNull();
    expect(screen.getByTestId("jrn-live")).toHaveTextContent("Note deleted");
  });

  it("N6: all pages of transactions are offered and the linked one is always an option", async () => {
    const user = userEvent.setup();
    const tx = (id: number) => ({ ...txnRow, id, trade_date: "2026-09-01" });
    const linked = {
      id: 7,
      side: "sell",
      qty: "3.0000",
      price: "10.0000",
      trade_date: "2026-01-02",
    };
    mount({
      "GET /stocks/ACME/journal": page([note(1, { portfolio_txn_id: 7, txn: linked })]),
      "GET /portfolio/txns": (c) =>
        c.query.get("cursor")
          ? ok({ items: [tx(43)], next_cursor: null })
          : ok({ items: [tx(42)], next_cursor: "p2" }),
    });
    await user.click(await screen.findByTestId("jrn-edit-1"));
    await waitFor(() =>
      expect(screen.getByTestId("jrn-txn").querySelectorAll("option")).toHaveLength(4),
    );
    const sel = screen.getByTestId("jrn-txn") as HTMLSelectElement;
    expect(sel.value).toBe("7"); // the current link survives although it is not in the list
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "7", "42", "43"]);
  });

  it("N7: the over-limit announcement lives in an always-mounted polite region", async () => {
    const user = userEvent.setup();
    mount({});
    await screen.findByTestId("jrn-empty");
    await user.click(screen.getByTestId("jrn-add"));
    const live = screen.getByTestId("jrn-count-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");
    await user.click(screen.getByTestId("jrn-note"));
    await user.paste("x".repeat(1003));
    expect(screen.getByTestId("jrn-count-live").textContent).toContain(
      "Over the limit by 3 characters",
    );
  });

  it("N9: deleting a portfolio transaction refreshes the journal queries", async () => {
    const { useDeleteTxn } = await import("@/lib/portfolio/api");
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    vi.stubGlobal(
      "fetch",
      createMockFetch({ "DELETE /portfolio/txns/5": ok({ id: 5, deleted: true }) }).impl,
    );
    function Probe() {
      const m = useDeleteTxn();
      return <button type="button" data-testid="go" onClick={() => m.mutate(5)} />;
    }
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await userEvent.setup().click(screen.getByTestId("go"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["journal"] }));
  });
});
