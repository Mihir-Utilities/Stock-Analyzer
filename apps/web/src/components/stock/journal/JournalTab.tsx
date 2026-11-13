"use client";

import { Clock } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/banners";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import { formatDate, formatInr } from "@/lib/format";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { useCreateNote, useDeleteNote, useJournal, usePatchNote } from "@/lib/journal/api";
import {
  charCount,
  describeNoteError,
  EMPTY_NOTE,
  nextNoteAttempt,
  NOTE_MAX,
  validateNote,
  type NoteAttempt,
  type NoteDraft,
  type NoteErrors,
} from "@/lib/journal/form";
import type { JournalNote, JournalTxn } from "@/lib/journal/schemas";
import { useTxns } from "@/lib/portfolio/api";

const BUTTON =
  "h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50";
const PRIMARY =
  "h-9 touch-target rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50";
const CHIP =
  "inline-flex items-center gap-1 rounded-chip border bg-surface-2 px-2 py-0.5 text-micro text-text-1";

const HINT =
  "Plain text, up to 1,000 characters. Do not paste passwords, tokens or account numbers.";

type Filter = "" | "open" | "reviewed";

function txnText(t: { side: string; qty: string; price: string; trade_date: string }): string {
  const side = t.side === "sell" ? "Sell" : "Buy";
  const qty = Number(t.qty);
  const price = formatInr(Number(t.price)).text;
  return `${side} ${Number.isFinite(qty) ? String(qty) : t.qty} at ${price} on ${formatDate(t.trade_date).text}`;
}

function priceLine(n: JournalNote): string {
  if (n.price_at_note === undefined) return "Price then: unavailable.";
  if (n.price_at_note === null) return "No imported price on that day.";
  const price = formatInr(Number(n.price_at_note));
  const when = formatDate(n.price_as_of);
  return `Price then: ${price.text} (close of ${when.text}, your imported prices).`;
}

// ---- form -------------------------------------------------------------------------------------

function NoteForm({
  symbol,
  editing,
  txns,
  onDone,
}: {
  symbol: string;
  editing: JournalNote | null;
  txns: ReadonlyArray<JournalTxn>;
  onDone: (reason: "saved" | "cancelled", savedId: number | null) => void;
}) {
  const create = useCreateNote(symbol);
  const patch = usePatchNote(symbol);
  const single = useSingleFlight();
  const attempt = useRef<NoteAttempt | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<NoteDraft>(
    editing
      ? {
          note: editing.note,
          reviewOn: editing.review_on ?? "",
          txnId: editing.portfolio_txn_id === null ? "" : String(editing.portfolio_txn_id),
        }
      : EMPTY_NOTE,
  );
  const [errors, setErrors] = useState<NoteErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Bumped on a submit (and when the server answers with field errors): only then is focus moved.
  const [focusSeq, setFocusSeq] = useState(0);
  // The linked transaction is always an option, even before every page of transactions has loaded,
  // so saving can never silently unlink it (N6).
  const options = useMemo(() => {
    const linked = editing?.txn;
    return linked && !txns.some((t) => t.id === linked.id) ? [linked, ...txns] : txns;
  }, [txns, editing]);
  const count = charCount(draft.note);
  const over = count > NOTE_MAX;

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  // After a submit that shows field errors, focus the first invalid control. Typing never gets here
  // (the effect depends on the submit counter only), so focus is not stolen from the field in use (S1).
  useEffect(() => {
    if (focusSeq === 0) return;
    const form = noteRef.current?.form;
    form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusSeq]);

  const set = <K extends keyof NoteDraft>(k: K, v: NoteDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { errors: errs, body } = validateNote(draft);
    setErrors(errs);
    setServerError(null);
    setFocusSeq((n) => n + 1);
    if (body === null) return;
    single(async () => {
      setSaving(true);
      try {
        if (editing) {
          await patch.mutateAsync({
            id: editing.id,
            body: {
              note: body.note,
              review_on: body.review_on ?? null,
              portfolio_txn_id: body.portfolio_txn_id ?? null,
            },
          });
          onDone("saved", editing.id);
        } else {
          const a = nextNoteAttempt(attempt.current, body);
          attempt.current = a;
          const r = await create.mutateAsync({ body, attempt: a });
          attempt.current = null;
          onDone("saved", r.data.id);
        }
      } catch (err) {
        const view = describeNoteError(err);
        if (view.conflict) attempt.current = null;
        setErrors(view.fields);
        setServerError(view.message);
        setFocusSeq((n) => n + 1);
      } finally {
        setSaving(false);
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      data-testid="jrn-form"
      aria-label={editing ? "Edit note" : "Add note"}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    >
      <FormField label="Note" required error={errors.note}>
        {(p) => (
          <textarea
            {...p}
            aria-describedby={[p["aria-describedby"], "jrn-note-hint"].filter(Boolean).join(" ")}
            ref={noteRef}
            data-testid="jrn-note"
            rows={5}
            className={`${inputClass} h-auto py-2`}
            value={draft.note}
            onChange={(e) => set("note", e.target.value)}
          />
        )}
      </FormField>
      <p className="text-caption text-text-2" data-testid="jrn-count">
        {count.toLocaleString("en-US")} of {NOTE_MAX.toLocaleString("en-US")} characters
        {over ? ". Over the limit." : ""}
      </p>
      <span className="sr-only" role="status" aria-live="polite" data-testid="jrn-count-live">
        {over ? `Over the limit by ${(count - NOTE_MAX).toLocaleString("en-US")} characters.` : ""}
      </span>
      <p id="jrn-note-hint" className="text-caption text-text-2" data-testid="jrn-hint">
        {HINT}
      </p>
      <FormField
        label="Review on (optional)"
        hint="India date, today or later. A reminder is only shown here, nothing is sent."
        error={errors.reviewOn}
      >
        {(p) => (
          <input
            {...p}
            type="date"
            data-testid="jrn-review-on"
            className={inputClass}
            value={draft.reviewOn}
            onChange={(e) => set("reviewOn", e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Linked transaction (optional)"
        hint={
          options.length === 0
            ? "No transactions for this stock."
            : "One of your own transactions in this stock."
        }
        error={errors.txnId}
      >
        {(p) => (
          <select
            {...p}
            data-testid="jrn-txn"
            className={inputClass}
            disabled={options.length === 0}
            value={draft.txnId}
            onChange={(e) => set("txnId", e.target.value)}
          >
            <option value="">None</option>
            {options.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {txnText(t)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {serverError ? (
        <div data-testid="jrn-error">
          <Banner tone="error">{serverError}</Banner>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" data-testid="jrn-submit" disabled={saving} className={PRIMARY}>
          {saving ? "Saving" : editing ? "Save note" : "Add note"}
        </button>
        <button
          type="button"
          data-testid="jrn-cancel"
          disabled={saving}
          className={BUTTON}
          onClick={() => onDone("cancelled", editing?.id ?? null)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---- entry ------------------------------------------------------------------------------------

function Entry({
  n,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  n: JournalNote;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const date = formatDate(n.noted_on).text;
  const linked: JournalTxn | null = n.txn;
  return (
    <li
      data-testid={`jrn-item-${n.id}`}
      className="flex flex-col gap-2 rounded-card border border-border bg-surface-1 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-sm font-medium text-text-1">{date}</span>
        <span className={`${CHIP} border-border`} data-testid={`jrn-status-${n.id}`}>
          {n.status === "reviewed" ? "Reviewed" : "Open"}
        </span>
        {n.review_due ? (
          <span className={`${CHIP} border-warn`} data-testid={`jrn-due-${n.id}`}>
            <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
            Review due
          </span>
        ) : null}
      </div>
      <p
        tabIndex={-1}
        data-testid={`jrn-text-${n.id}`}
        className="whitespace-pre-wrap break-words text-body text-text-1"
      >
        {n.note}
      </p>
      <p className="text-caption text-text-2" data-testid={`jrn-price-${n.id}`}>
        {priceLine(n)}
      </p>
      <p className="text-caption text-text-2" data-testid={`jrn-review-${n.id}`}>
        {n.review_on ? `Review on ${formatDate(n.review_on).text}.` : "No review date."}
      </p>
      {linked ? (
        <p className="text-caption text-text-2" data-testid={`jrn-txn-${n.id}`}>
          Linked to: {txnText(linked)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid={`jrn-toggle-${n.id}`}
          // aria-disabled, not disabled: a disabled button drops the keyboard focus (JRN-27).
          aria-disabled={busy || undefined}
          className={`${BUTTON} aria-disabled:opacity-50`}
          aria-label={`${n.status === "reviewed" ? "Reopen" : "Mark reviewed"}, note of ${date}`}
          onClick={() => {
            if (!busy) onToggle();
          }}
        >
          {n.status === "reviewed" ? "Reopen" : "Mark reviewed"}
        </button>
        <button
          type="button"
          data-testid={`jrn-edit-${n.id}`}
          className={BUTTON}
          aria-label={`Edit note of ${date}`}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          data-testid={`jrn-delete-${n.id}`}
          className={BUTTON}
          aria-label={`Delete note of ${date}`}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

// ---- tab --------------------------------------------------------------------------------------

export function JournalTab({ symbol }: { symbol: string }) {
  const [filter, setFilter] = useState<Filter>("");
  const q = useJournal(symbol, filter);
  const txnsQ = useTxns(symbol);
  const patch = usePatchNote(symbol);
  const del = useDeleteNote(symbol);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<JournalNote | null>(null);
  const [confirm, setConfirm] = useState<JournalNote | null>(null);
  const [live, setLive] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const items = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.data.items), [q.data]);
  const dropped = (q.data?.pages ?? []).reduce((sum, p) => sum + p.data.dropped, 0);
  const first = q.data?.pages[0]?.data;
  const dueCount = first?.review_due_count ?? null;
  const txns = useMemo(() => (txnsQ.data?.pages ?? []).flatMap((p) => p.data.items), [txnsQ.data]);
  // Every transaction of the stock is offered for the link: fetch the remaining pages (N6).
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = txnsQ;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Focus requests are kept in a ref and honoured after the render that makes them possible: the
  // target must exist and, after a delete, the deleted note must be gone from the list.
  const focusReq = useRef<{ target: string; goneId?: number } | null>(null);
  useEffect(() => {
    const req = focusReq.current;
    if (req === null) return;
    if (req.goneId !== undefined && items.some((n) => n.id === req.goneId)) return;
    const el =
      req.target === "add"
        ? addRef.current
        : document.querySelector<HTMLElement>(`[data-testid="${req.target}"]`);
    if (el) {
      el.focus();
      focusReq.current = null;
    }
  });

  const closeForm = (reason: "saved" | "cancelled", id: number | null) => {
    const wasEditing = editing !== null;
    setFormOpen(false);
    setEditing(null);
    if (reason === "saved") setLive(wasEditing ? "Note saved" : "Note added");
    focusReq.current = { target: wasEditing && id !== null ? `jrn-edit-${id}` : "add" };
  };

  const toggle = async (n: JournalNote) => {
    setActionError(null);
    try {
      await patch.mutateAsync({
        id: n.id,
        body: { status: n.status === "reviewed" ? "open" : "reviewed" },
      });
      setLive(n.status === "reviewed" ? "Reopened" : "Marked reviewed");
    } catch (err) {
      setActionError(describeNoteError(err).message);
    }
  };

  const remove = async (n: JournalNote) => {
    const i = items.findIndex((x) => x.id === n.id);
    const neighbour = items[i + 1] ?? items[i - 1];
    setActionError(null);
    try {
      await del.mutateAsync(n.id);
      setLive("Note deleted");
      setConfirm(null);
      focusReq.current = { target: neighbour ? `jrn-text-${neighbour.id}` : "add", goneId: n.id };
    } catch (err) {
      setConfirm(null);
      if (err instanceof ApiError && err.status === 404) {
        // Already gone (deleted elsewhere): the goal is met, so refresh the list and say so (N3).
        setLive("Note deleted");
        void q.refetch();
        focusReq.current = { target: neighbour ? `jrn-text-${neighbour.id}` : "add", goneId: n.id };
        return;
      }
      setActionError(describeNoteError(err).message);
    }
  };

  let body;
  if (q.isPending) {
    body = (
      <div className="flex flex-col gap-3" data-testid="jrn-loading" aria-busy="true">
        <Skeleton className="h-24 w-full" label="Loading journal" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else if (q.isError) {
    const e = q.error;
    body = (
      <div className="flex flex-col items-start gap-2" data-testid="jrn-load-error">
        <Banner tone="error">
          {`${e instanceof ApiError ? e.message : "The journal could not be loaded."}${e instanceof ApiError && e.requestId ? ` (request ${e.requestId})` : ""}`}
        </Banner>
        <button
          type="button"
          data-testid="jrn-retry"
          className={BUTTON}
          onClick={() => void q.refetch()}
        >
          Retry
        </button>
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div data-testid="jrn-empty">
        <EmptyState
          message={
            filter === ""
              ? `No notes yet for ${symbol}. Add one to remember why you are interested.`
              : `No ${filter} notes.`
          }
        />
      </div>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-3" data-testid="jrn-list">
        {items.map((n) => (
          <Entry
            key={n.id}
            n={n}
            busy={patch.isPending}
            onToggle={() => void toggle(n)}
            onEdit={() => {
              setEditing(n);
              setFormOpen(true);
            }}
            onDelete={() => setConfirm(n)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="journal-tab">
      <div className="flex flex-col gap-2">
        <h2 className="text-lead font-semibold text-text-1">Decision journal for {symbol}</h2>
        <p className="text-body-sm text-text-2">
          Write down why you bought or are watching this stock, then check back on the review date.
          Kept only in your own database.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {dueCount !== null && dueCount > 0 ? (
            <span className={`${CHIP} border-warn`} data-testid="jrn-due-count">
              <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
              {dueCount} review due
            </span>
          ) : null}
          <label className="flex items-center gap-2 text-body-sm text-text-1">
            Show
            <select
              data-testid="jrn-filter"
              className={`${inputClass} w-auto`}
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
            >
              <option value="">All notes</option>
              <option value="open">Open</option>
              <option value="reviewed">Reviewed</option>
            </select>
          </label>
          <button
            type="button"
            ref={addRef}
            data-testid="jrn-add"
            className={PRIMARY}
            disabled={formOpen}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            Add note
          </button>
        </div>
      </div>

      {formOpen ? (
        <NoteForm
          key={editing?.id ?? "new"}
          symbol={symbol}
          editing={editing}
          txns={txns}
          onDone={closeForm}
        />
      ) : null}

      {actionError ? (
        <div data-testid="jrn-error-action">
          <Banner tone="error">{actionError}</Banner>
        </div>
      ) : null}
      {dropped > 0 ? (
        <Banner tone="warn" testId="jrn-dropped">
          {dropped} {dropped === 1 ? "entry" : "entries"} could not be shown.
        </Banner>
      ) : null}
      {body}
      {q.hasNextPage ? (
        <button
          type="button"
          data-testid="jrn-more"
          className={`${BUTTON} self-start`}
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          {q.isFetchingNextPage ? "Loading" : "Load more"}
        </button>
      ) : null}

      <div className="sr-only" role="status" aria-live="polite" data-testid="jrn-live">
        {live}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title="Delete this note?"
        message="Delete this note? This cannot be undone."
        confirmLabel="Delete"
        danger
        busy={del.isPending}
        onConfirm={() => confirm && void remove(confirm)}
        onCancel={() => {
          const id = confirm?.id;
          setConfirm(null);
          if (id) focusReq.current = { target: `jrn-delete-${id}` };
        }}
      />
    </div>
  );
}
