"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/banners";
import { FormField, inputClass } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/overlays";
import { istDate } from "@/lib/dashboard/state";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { useHolidays } from "@/lib/portfolio/api";
import { useCreateMfTxn, usePatchMfTxn, mfKeys } from "@/lib/portfolio/mf-api";
import {
  changedMfFields,
  describeMfError,
  draftFromTxn,
  EMPTY_MF_DRAFT,
  MF_TXN_TYPES,
  MF_WARNING_LABEL,
  nextMfAttempt,
  typeLabel,
  unitsTimesNav,
  validateMfDraft,
  type MfAttempt,
  type MfDraft,
  type MfFieldErrors,
  type MfTxnBody,
} from "@/lib/portfolio/mf-form";
import type { MfTxn } from "@/lib/portfolio/mf-schemas";
import { nonTradingWarning } from "@/lib/portfolio/txn-form";
import {
  inr,
  MF_STATEMENT_SOURCE,
  optionLabel,
  planLabel,
  SWITCH_NOT_SUPPORTED_COPY,
} from "./text";
import { SchemePicker } from "./SchemePicker";

const BUTTON =
  "h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50";

const NEW_KEY_WARNING =
  "You changed values after a failed try, so this is sent as a new transaction. If the earlier try was saved after all, it now exists twice: check the list.";

/**
 * Add or edit a mutual fund transaction (docs/06 6.7a, docs/03 12a). One Idempotency-Key per submit
 * attempt (reused only when the same body is retried); a single-flight guard stops a double submit.
 */
export function MfTxnForm({
  editing,
  onDone,
}: {
  editing: MfTxn | null;
  onDone: (reason: "saved" | "cancelled") => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const create = useCreateMfTxn();
  const patch = usePatchMfTxn();
  const single = useSingleFlight();
  const attempt = useRef<MfAttempt | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<MfDraft>(editing ? draftFromTxn(editing) : EMPTY_MF_DRAFT);
  const [errors, setErrors] = useState<MfFieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Array<{ code: string; message: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<{ plan: string; option: string } | null>(
    editing ? { plan: editing.plan, option: editing.option } : null,
  );

  const year = /^\d{4}-/.test(draft.date) ? Number(draft.date.slice(0, 4)) : null;
  const holidays = useHolidays(year);
  const holidaySet = useMemo(() => {
    const d = holidays.data?.data;
    return d?.year_loaded ? new Set((d.items ?? []).map((i) => i.date)) : null;
  }, [holidays.data]);
  const warning = nonTradingWarning(draft.date, holidaySet);

  const set = <K extends keyof MfDraft>(k: K, v: MfDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const product = unitsTimesNav(draft.units, draft.nav);
  const changed = useMemo<Partial<MfTxnBody> | null>(() => {
    if (!editing) return null;
    const next = validateMfDraft(draft, istDate(new Date())).body;
    return next === null ? null : changedMfFields(draftFromTxn(editing), next);
  }, [editing, draft]);
  const unchanged = changed !== null && Object.keys(changed).length === 0;

  const run = async () => {
    const { errors: errs, body } = validateMfDraft(draft, istDate(new Date()));
    setErrors(errs);
    setServerError(null);
    setWarnings([]);
    if (body === null) {
      summaryRef.current?.focus();
      return;
    }
    if (editing && changed !== null && Object.keys(changed).length === 0) return;
    setSaving(true);
    try {
      if (editing) {
        const patchBody = { ...(changed ?? {}) };
        const r = await patch.mutateAsync({ id: editing.id, body: patchBody });
        toast("Transaction updated. The whole sequence for this scheme and folio was re-checked.");
        if (r.warnings.length > 0) setWarnings(r.warnings);
        onDone("saved");
      } else {
        const prev = attempt.current;
        const a = nextMfAttempt(prev, body);
        const newKeyAfterFailure = prev !== null && a !== prev;
        attempt.current = a;
        setNotice(newKeyAfterFailure ? NEW_KEY_WARNING : null);
        const r = await create.mutateAsync({ body, attempt: a });
        attempt.current = null;
        toast(
          `Transaction saved: ${typeLabel(body.txn_type).toLowerCase()} of ${body.units} units.`,
        );
        setWarnings(r.warnings);
        setNotice(newKeyAfterFailure ? NEW_KEY_WARNING : null);
        setDraft({
          ...EMPTY_MF_DRAFT,
          schemeCode: draft.schemeCode,
          schemeName: draft.schemeName,
          folio: draft.folio,
          date: body.txn_date,
        });
      }
    } catch (err) {
      const view = describeMfError(err);
      if (view.conflict) attempt.current = null;
      if (view.lost) void qc.invalidateQueries({ queryKey: mfKeys.txnsAll });
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
      data-testid="pf-mf-txn-form"
      aria-label={editing ? "Edit mutual fund transaction" : "Add mutual fund transaction"}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    >
      <h3 className="text-lead font-semibold">
        {editing ? "Edit mutual fund transaction" : "Add mutual fund transaction"}
      </h3>
      <div ref={summaryRef} tabIndex={-1} aria-live="polite" className="outline-none">
        {serverError ? (
          <Banner tone="error" testId="pf-mf-txn-error">
            {serverError}
          </Banner>
        ) : null}
        {notice ? (
          <Banner tone="warn" testId="pf-mf-txn-notice">
            {notice}
          </Banner>
        ) : null}
        {warnings.map((w, i) => (
          <Banner key={`${w.code}-${i}`} tone="warn" testId={`pf-mf-txn-warning-${w.code}`}>
            <strong>{MF_WARNING_LABEL[w.code] ?? w.code}:</strong> {w.message}
          </Banner>
        ))}
      </div>
      {editing ? (
        <p className="text-body-sm text-text-1" data-testid="pf-mf-txn-scheme">
          {draft.schemeName} ({planLabel(editing.plan)}, {optionLabel(editing.option)}). The scheme
          cannot be changed: delete this transaction and add it again instead.
        </p>
      ) : (
        <>
          {draft.schemeCode !== "" ? (
            <p className="text-body-sm text-text-1" data-testid="pf-mf-txn-scheme">
              Chosen: {draft.schemeName}
              {picked ? ` (${planLabel(picked.plan)}, ${optionLabel(picked.option)})` : ""}, code{" "}
              {draft.schemeCode}.
            </p>
          ) : null}
          <SchemePicker
            error={errors.schemeCode ?? null}
            onPick={(s) => {
              setDraft((d) => ({ ...d, schemeCode: String(s.code), schemeName: s.name }));
              setPicked({ plan: s.plan, option: s.option });
              setErrors((e) => ({ ...e, schemeCode: undefined }));
            }}
          />
        </>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FormField
          label="Folio"
          required
          error={errors.folio ?? null}
          hint="Folio number from your statement (1 to 40 characters)"
        >
          {(p) => (
            <input
              {...p}
              data-testid="pf-mf-txn-folio"
              className={inputClass}
              autoComplete="off"
              maxLength={40}
              value={draft.folio}
              onChange={(e) => set("folio", e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Type" required error={errors.type ?? null}>
          {(p) => (
            <select
              {...p}
              data-testid="pf-mf-txn-type"
              className={inputClass}
              value={draft.type}
              onChange={(e) => {
                const t = MF_TXN_TYPES.find((x) => x === e.target.value);
                if (t) set("type", t);
              }}
            >
              {MF_TXN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Date" required error={errors.date ?? null}>
          {(p) => (
            <input
              {...p}
              type="date"
              data-testid="pf-mf-txn-date"
              className={inputClass}
              value={draft.date}
              onChange={(e) => set("date", e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Units"
          required
          error={errors.units ?? null}
          unit="units"
          hint="Up to 4 decimals"
        >
          {(p) => (
            <input
              {...p}
              inputMode="decimal"
              data-testid="pf-mf-txn-units"
              className={inputClass}
              value={draft.units}
              onChange={(e) => set("units", e.target.value)}
            />
          )}
        </FormField>
        <FormField label="NAV" required error={errors.nav ?? null} unit="INR per unit">
          {(p) => (
            <input
              {...p}
              inputMode="decimal"
              data-testid="pf-mf-txn-nav"
              className={inputClass}
              value={draft.nav}
              onChange={(e) => set("nav", e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Amount"
          required
          error={errors.amount ?? null}
          unit="INR"
          hint="Units x NAV, without stamp duty (for a redemption: the net amount credited)"
        >
          {(p) => (
            <input
              {...p}
              inputMode="decimal"
              data-testid="pf-mf-txn-amount"
              className={inputClass}
              value={draft.amount}
              onChange={(e) => set("amount", e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Stamp duty"
          error={errors.stampDuty ?? null}
          unit="INR"
          hint="Separate charge; empty means none. A purchase costs amount + stamp duty."
        >
          {(p) => (
            <input
              {...p}
              inputMode="decimal"
              data-testid="pf-mf-txn-stamp"
              className={inputClass}
              value={draft.stampDuty}
              onChange={(e) => set("stampDuty", e.target.value)}
            />
          )}
        </FormField>
      </div>
      <FormField label="Note" error={errors.note ?? null}>
        {(p) => (
          <input
            {...p}
            data-testid="pf-mf-txn-note"
            className={inputClass}
            maxLength={500}
            value={draft.note}
            onChange={(e) => set("note", e.target.value)}
          />
        )}
      </FormField>
      {warning ? (
        <Banner tone="warn" testId="pf-mf-txn-nontrading-warning">
          {warning}
        </Banner>
      ) : null}
      <p className="text-caption text-text-2" data-testid="pf-mf-txn-product">
        {product === null
          ? "Units x NAV: enter units and NAV to see it."
          : `Units x NAV: ${inr(product).text} (exact decimal arithmetic, a check only; the amount you enter is saved).`}
      </p>
      <p className="text-caption text-text-2" data-testid="pf-mf-txn-help">
        Source: {MF_STATEMENT_SOURCE}. Types offered: purchase, SIP, redemption, IDCW payout and
        IDCW reinvestment. {SWITCH_NOT_SUPPORTED_COPY} A redemption cannot exceed the units held in
        that scheme and folio on its date, and dates in the future are rejected.
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="pf-mf-txn-save"
          disabled={saving || unchanged}
          aria-busy={saving}
          className={`${BUTTON} border-accent font-medium`}
        >
          {saving ? "Saving..." : editing ? "Save changes" : "Save transaction"}
        </button>
        <button
          type="button"
          data-testid="pf-mf-txn-cancel"
          onClick={() => onDone("cancelled")}
          className={BUTTON}
        >
          {editing ? "Cancel" : "Close"}
        </button>
      </div>
      {unchanged ? (
        <p className="text-caption text-text-2" data-testid="pf-mf-txn-unchanged">
          Nothing has changed yet, so there is nothing to save.
        </p>
      ) : null}
    </form>
  );
}
