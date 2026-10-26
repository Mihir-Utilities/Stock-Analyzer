"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/overlays";
import { deleteManualResults, postResults } from "@/lib/imports/api";
import {
  RESULT_FIELDS,
  noteError,
  todayIst,
  validateResults,
  type FieldErrors,
  type ResultField,
} from "@/lib/imports/entry-validate";
import { describeError, isApiError } from "@/lib/imports/errors";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { formatCount } from "@/lib/format";
import { Fmt } from "./Fmt";
import {
  CellInput,
  GenericError,
  ManualResultPanel,
  NoteInput,
  SubmitButton,
  SymbolInput,
  pick,
  serverFieldMap,
} from "./ManualCommon";

const LABELS: Record<ResultField, string> = {
  revenue: "Revenue",
  ebitda: "EBITDA",
  operating_income: "Operating income",
  other_income: "Other income",
  interest: "Interest",
  depreciation: "Depreciation",
  pbt: "Profit before tax",
  tax: "Tax",
  net_profit: "Net profit",
  eps: "EPS",
};

/** Copy required by B08-8 (manual re-entry with fewer metrics keeps the old manual metrics). */
export const REENTRY_COPY =
  "Metrics you leave out are not removed: values saved by an earlier manual entry for this period stay. To remove them, delete the manual period and enter it again.";

const emptyValues = (): Record<ResultField, string> =>
  Object.fromEntries(RESULT_FIELDS.map((k) => [k, ""])) as Record<ResultField, string>;

/** Manual quarterly or annual results (docs/01 7.6; same validators as results_*.csv, IMP-17). */
export function ResultsForm() {
  const [symbol, setSymbol] = useState("");
  const [basis, setBasis] = useState("consolidated");
  const [periodType, setPeriodType] = useState("Q");
  const [periodEnd, setPeriodEnd] = useState("");
  const [values, setValues] = useState<Record<ResultField, string>>(emptyValues);
  const [note, setNote] = useState("");
  const [local, setLocal] = useState<FieldErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const once = useSingleFlight();

  const save = useMutation({
    mutationFn: (v: { symbol: string; body: Record<string, unknown> }) =>
      postResults(v.symbol, v.body),
  });
  const remove = useMutation({
    mutationFn: (v: { symbol: string; periodType: string; periodEnd: string; basis: string }) =>
      deleteManualResults(v.symbol, v),
    onSettled: () => setConfirmDelete(false),
  });

  const server = serverFieldMap(save.error);
  const msg = (k: string) => pick(local, server, k);

  const checkSymbol = (errs: FieldErrors) => {
    if (!symbol.trim()) errs.symbol = "Enter the exchange symbol.";
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { errors, body } = validateResults({ basis, periodType, periodEnd, values }, todayIst());
    checkSymbol(errors);
    const ne = noteError(note);
    if (ne) errors.note = ne;
    setLocal(errors);
    remove.reset();
    if (Object.keys(errors).length > 0 || !body) return;
    const payload: Record<string, unknown> = { ...body };
    if (note.trim()) payload.note = note.trim();
    once(() => save.mutateAsync({ symbol, body: payload }));
  };

  // Delete needs the same period fields as the entry; reuse the date and basis checks.
  const askDelete = () => {
    const probe = { ...emptyValues(), revenue: "1" };
    const { errors, body } = validateResults(
      { basis, periodType, periodEnd, values: probe },
      todayIst(),
    );
    delete errors.values;
    checkSymbol(errors);
    setLocal(errors);
    save.reset();
    if (Object.keys(errors).length > 0 || !body) return;
    setConfirmDelete(true);
  };

  const periodBody = () =>
    validateResults(
      { basis, periodType, periodEnd, values: { ...emptyValues(), revenue: "1" } },
      todayIst(),
    ).body;

  const unknownText = "This symbol is not in your stock list. Add the stock first.";
  const anyFieldShown = Object.keys(server).length > 0;

  return (
    <Card title="Quarterly or annual results" testId="results-form">
      <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-3">
        <p className="text-body-sm text-text-2" data-testid="results-reentry-copy">
          {REENTRY_COPY}
        </p>
        <SymbolInput
          value={symbol}
          onChange={setSymbol}
          error={msg("symbol")}
          testId="results-symbol"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Period type" required error={msg("period_type")}>
            {(p) => (
              <select
                {...p}
                data-testid="results-period-type"
                className={inputClass}
                value={periodType}
                onChange={(e) => setPeriodType(e.target.value)}
              >
                <option value="Q">Quarterly</option>
                <option value="A">Annual</option>
              </select>
            )}
          </FormField>
          <FormField label="Basis" required error={msg("basis")}>
            {(p) => (
              <select
                {...p}
                data-testid="results-basis"
                className={inputClass}
                value={basis}
                onChange={(e) => setBasis(e.target.value)}
              >
                <option value="consolidated">Consolidated</option>
                <option value="standalone">Standalone</option>
              </select>
            )}
          </FormField>
          <CellInput
            label="Period end"
            hint={
              periodType === "Q"
                ? "A quarter end: 31 Mar, 30 Jun, 30 Sep or 31 Dec."
                : "Usually 31 March."
            }
            required
            value={periodEnd}
            onChange={setPeriodEnd}
            error={msg("period_end")}
            testId="results-period-end"
            placeholder="2026-09-30"
          />
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="text-caption font-medium text-text-1">
            Values (INR crore, EPS in INR). Leave a cell empty if the filing has no value.
          </legend>
          {msg("values") ? (
            <p role="alert" data-testid="results-values-error" className="text-caption text-text-1">
              <span className="font-medium text-down">Error: </span>
              {msg("values")}
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {RESULT_FIELDS.map((k) => (
              <CellInput
                key={k}
                label={LABELS[k]}
                unit={k === "eps" ? "INR" : "INR crore"}
                value={values[k]}
                onChange={(v) => setValues((s) => ({ ...s, [k]: v }))}
                error={msg(k)}
                testId={`results-${k}`}
              />
            ))}
          </div>
        </fieldset>
        <NoteInput value={note} onChange={setNote} error={msg("note")} testId="results-note" />
        <GenericError
          error={save.error}
          shown={anyFieldShown}
          testId="results-error"
          unknownSymbolText={unknownText}
        />
        {save.isSuccess ? (
          <ManualResultPanel result={save.data} title="Results saved" testId="results-saved" />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <SubmitButton testId="results-submit" pending={save.isPending} label="Save results" />
          <button
            type="button"
            data-testid="results-delete"
            disabled={remove.isPending}
            onClick={askDelete}
            className="touch-target h-9 rounded-control border border-down px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50"
          >
            Delete manual period
          </button>
        </div>
        {remove.isSuccess ? (
          <div role="status" data-testid="results-deleted" className="flex flex-col gap-2">
            <Banner tone="info" testId="results-deleted-note">
              Removed <Fmt f={formatCount(remove.data.deleted)} /> manual values (batch{" "}
              {remove.data.batch_id ?? "none"}). Values from CSV imports stay.
            </Banner>
            {remove.data.warnings.map((w) => (
              <Banner key={w} tone="warn" testId="results-deleted-warning">
                {w === "POST_IMPORT_NOT_QUEUED"
                  ? "The delete is saved, but the analytics refresh was not queued."
                  : w}
              </Banner>
            ))}
          </div>
        ) : null}
        {remove.isError ? (
          <Banner tone="error" testId="results-delete-error">
            {isApiError(remove.error, "NOT_FOUND")
              ? "This period has no manual entry for this stock (values from CSV imports are not removed here)."
              : describeError(remove.error)}
          </Banner>
        ) : null}
      </form>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete the manual values of this period?"
        message={
          <>
            Removes the values you entered by hand for {symbol.trim().toUpperCase()},{" "}
            {periodEnd.trim()} ({periodType === "Q" ? "quarterly" : "annual"}, {basis}). Values that
            came from a CSV import stay. This cannot be undone; enter the period again to restore
            it.
          </>
        }
        confirmLabel="Delete manual period"
        danger
        busy={remove.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          const b = periodBody();
          if (!b) return;
          once(() =>
            remove.mutateAsync({
              symbol,
              periodType: b.period_type,
              periodEnd: b.period_end,
              basis: b.basis,
            }),
          );
        }}
      />
    </Card>
  );
}
