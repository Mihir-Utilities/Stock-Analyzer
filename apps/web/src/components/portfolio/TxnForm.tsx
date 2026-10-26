"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/banners";
import { FormField, inputClass } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/overlays";
import { istDate } from "@/lib/dashboard/state";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { useCreateTxn, useHolidays, usePatchTxn } from "@/lib/portfolio/api";
import { plainString, tradeAmount } from "@/lib/portfolio/decimal";
import type { Txn } from "@/lib/portfolio/schemas";
import {
  describeTxnError,
  EMPTY_DRAFT,
  nextAttempt,
  nonTradingWarning,
  validateDraft,
  type Attempt,
  type FieldErrors,
  type TxnBody,
  type TxnDraft,
} from "@/lib/portfolio/txn-form";
import { inr } from "./text";

function draftFrom(t: Txn): TxnDraft {
  return {
    symbol: t.symbol,
    side: t.side,
    qty: plainString(t.qty),
    price: t.price,
    fees: t.fees,
    tradeDate: t.trade_date,
    note: t.note ?? "",
  };
}

const BUTTON =
  "h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50";

/**
 * Add or edit a transaction (docs/06 section 6.7). One Idempotency-Key per submit attempt,
 * reused only when the same attempt is retried; a single-flight guard stops a double submit.
 */
export function TxnForm({
  editing,
  symbols,
  onDone,
}: {
  editing: Txn | null;
  symbols: ReadonlyArray<string>;
  onDone: () => void;
}) {
  const toast = useToast();
  const create = useCreateTxn();
  const patch = usePatchTxn();
  const single = useSingleFlight();
  const attempt = useRef<Attempt | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<TxnDraft>(editing ? draftFrom(editing) : EMPTY_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const year = /^\d{4}-/.test(draft.tradeDate) ? Number(draft.tradeDate.slice(0, 4)) : null;
  const holidays = useHolidays(year);
  const holidaySet = useMemo(() => {
    const d = holidays.data?.data;
    return d?.year_loaded ? new Set((d.items ?? []).map((i) => i.date)) : null;
  }, [holidays.data]);
  const warning = nonTradingWarning(draft.tradeDate, holidaySet);
  const holidayNote =
    holidaySet === null && year !== null && !holidays.isPending
      ? "The holiday list for this year is not available, so only weekends are checked."
      : null;

  const set = <K extends keyof TxnDraft>(k: K, v: TxnDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const amount = tradeAmount(draft.side, draft.qty.trim(), draft.price.trim(), draft.fees);

  const run = async () => {
    const { errors: errs, body } = validateDraft(draft, istDate(new Date()));
    setErrors(errs);
    setServerError(null);
    if (body === null) {
      summaryRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const changed: Partial<TxnBody> = {};
        const orig = draftFrom(editing);
        const next = validateDraft(draft, istDate(new Date())).body;
        if (next) {
          if (next.symbol !== orig.symbol.toUpperCase()) changed.symbol = next.symbol;
          if (next.side !== orig.side) changed.side = next.side;
          if (next.qty !== orig.qty) changed.qty = next.qty;
          if (next.price !== orig.price) changed.price = next.price;
          if (next.fees !== orig.fees) changed.fees = next.fees;
          if (next.trade_date !== orig.tradeDate) changed.trade_date = next.trade_date;
          if (next.note !== orig.note) changed.note = next.note;
        }
        const r = await patch.mutateAsync({ id: editing.id, body: changed });
        toast(
          `Transaction updated. The whole sequence for this stock was re-checked. ${r.warnings.map((w) => w.message).join(" ")}`.trim(),
        );
        onDone();
      } else {
        const a = nextAttempt(attempt.current, body);
        attempt.current = a;
        const r = await create.mutateAsync({ body, attempt: a });
        attempt.current = null;
        toast(`Transaction saved: ${body.side} ${body.qty} ${body.symbol}.`);
        const extra = r.warnings.map((w) => w.message).join(" ");
        setNotice(extra || null);
        setDraft({ ...EMPTY_DRAFT, tradeDate: body.trade_date });
      }
    } catch (err) {
      const view = describeTxnError(err);
      setErrors(view.fields);
      setServerError(view.message);
      summaryRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    single(run);
  };

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      data-testid="txn-form"
      aria-label={editing ? "Edit transaction" : "Add transaction"}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    >
      <h3 className="text-lead font-semibold">
        {editing ? "Edit transaction" : "Add transaction"}
      </h3>
      <div ref={summaryRef} tabIndex={-1} aria-live="polite" className="outline-none">
        {serverError ? (
          <Banner tone="error" testId="txn-error">
            {serverError}
          </Banner>
        ) : null}
        {notice && !serverError ? (
          <Banner tone="warn" testId="txn-notice">
            {notice}
          </Banner>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FormField
          label="Symbol"
          required
          error={errors.symbol ?? null}
          hint="Exchange symbol, e.g. TCS"
        >
          {(p) => (
            <>
              <input
                {...p}
                data-testid="txn-symbol"
                className={inputClass}
                list="txn-symbols"
                autoComplete="off"
                value={draft.symbol}
                onChange={(e) => set("symbol", e.target.value.toUpperCase())}
              />
              <datalist id="txn-symbols">
                {symbols.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </>
          )}
        </FormField>
        <FormField label="Side" required error={errors.side ?? null}>
          {(p) => (
            <select
              {...p}
              data-testid="txn-side"
              className={inputClass}
              value={draft.side}
              onChange={(e) => set("side", e.target.value === "sell" ? "sell" : "buy")}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          )}
        </FormField>
        <FormField label="Trade date" required error={errors.tradeDate ?? null}>
          {(p) => (
            <input
              {...p}
              type="date"
              data-testid="txn-date"
              className={inputClass}
              value={draft.tradeDate}
              onChange={(e) => set("tradeDate", e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Quantity"
          required
          error={errors.qty ?? null}
          unit="shares"
          hint="Up to 4 decimals"
        >
          {(p) => (
            <input
              {...p}
              inputMode="decimal"
              data-testid="txn-qty"
              className={inputClass}
              value={draft.qty}
              onChange={(e) => set("qty", e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Price per share" required error={errors.price ?? null} unit="INR">
          {(p) => (
            <input
              {...p}
              inputMode="decimal"
              data-testid="txn-price"
              className={inputClass}
              value={draft.price}
              onChange={(e) => set("price", e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Fees"
          error={errors.fees ?? null}
          unit="INR"
          hint="Brokerage and charges; empty means none"
        >
          {(p) => (
            <input
              {...p}
              inputMode="decimal"
              data-testid="txn-fees"
              className={inputClass}
              value={draft.fees}
              onChange={(e) => set("fees", e.target.value)}
            />
          )}
        </FormField>
      </div>
      <FormField label="Note" error={errors.note ?? null}>
        {(p) => (
          <input
            {...p}
            data-testid="txn-note"
            className={inputClass}
            maxLength={500}
            value={draft.note}
            onChange={(e) => set("note", e.target.value)}
          />
        )}
      </FormField>
      {warning ? (
        <Banner tone="warn" testId="txn-nontrading-warning">
          {warning}
        </Banner>
      ) : null}
      {holidayNote && draft.tradeDate ? (
        <p className="text-caption text-text-2" data-testid="txn-holiday-note">
          {holidayNote}
        </p>
      ) : null}
      <p className="text-caption text-text-2" data-testid="txn-amount">
        {amount === null
          ? "Amount: enter quantity and price to see it."
          : `${draft.side === "buy" ? "Cost including fees" : "Proceeds after fees"}: ${inr(amount).text} (exact decimal arithmetic).`}
      </p>
      <p className="text-caption text-text-2" data-testid="txn-help">
        Same-day trades: buys are counted before sells on the same date, so a sell can use shares
        bought later that day, but a sell can never exceed what you hold on its date. Trade dates in
        the future are rejected. Quantities are in the units at the time of the trade; splits are
        applied from the adjustments below.
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="txn-save"
          disabled={saving}
          aria-busy={saving}
          className={`${BUTTON} border-accent font-medium`}
        >
          {saving ? "Saving..." : editing ? "Save changes" : "Save transaction"}
        </button>
        <button type="button" data-testid="txn-cancel" onClick={onDone} className={BUTTON}>
          {editing ? "Cancel" : "Close"}
        </button>
      </div>
    </form>
  );
}
