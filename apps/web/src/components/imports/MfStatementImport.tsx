"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { ConfirmDialog } from "@/components/ui/overlays";
import { FormField, inputClass } from "@/components/ui/FormField";
import { Wizard, type WizardStep } from "@/components/ui/Wizard";
import { ApiError } from "@/lib/api/client";
import { DASH, formatCount, formatDate } from "@/lib/format";
import { undoBatch } from "@/lib/imports/api";
import { describeError, isApiError } from "@/lib/imports/errors";
import {
  canCommit,
  commitMfStatement,
  otherErrors,
  otherWarnings,
  putMapping,
  readMfPreview,
  revalidateMfStatement,
  rowsToImport,
  TYPE_ORDER,
  validateMfStatement,
} from "@/lib/imports/mf";
import { precheckFile } from "@/lib/imports/precheck";
import type { MfCommitResult, MfValidateResult } from "@/lib/imports/schemas";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { invalidatePortfolio } from "@/lib/portfolio/api";
import { typeLabel } from "@/lib/portfolio/mf-form";
import { breaksHoldingsText } from "./BatchesTab";
import { Fmt } from "./Fmt";
import { formatCell, IssueList } from "./IssueLists";
import { MfFundMapping, type Choice } from "./MfFundMapping";

const COLUMNS: Array<{ key: string; label: string }> = [
  { key: "row", label: "Row" },
  { key: "date", label: "Date" },
  { key: "fund_name", label: "Fund name" },
  { key: "txn_type", label: "Type" },
  { key: "folio", label: "Folio" },
  { key: "units", label: "Units" },
  { key: "nav", label: "NAV" },
  { key: "amount", label: "Amount" },
  { key: "stamp_duty", label: "Stamp duty" },
];

const COMMIT_WARNING_TEXT: Record<string, string> = {
  AMOUNT_MISMATCH:
    "Some amounts differ from units x NAV by more than the tolerance. Rows were kept as in your file.",
  NON_BUSINESS_DAY:
    "Some rows are dated on a weekend or market holiday. Rows were kept as in your file.",
};

const headingClass =
  "text-lead font-semibold text-text-1 outline-none focus-visible:outline-2 focus-visible:outline-accent";

/**
 * Import of the broker's mutual fund statement (docs/06 6.7a, docs/03 12a): upload, review (fund
 * name mapping, errors and warnings by row, first 20 normalised rows, untick rows), commit, undo.
 * Nothing is read from the file in the browser; the preview is what the API normalised.
 */
export function MfStatementImport() {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<File | null>(null);
  const [validation, setValidation] = useState<MfValidateResult | null>(null);
  const [step, setStep] = useState(0);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [mapError, setMapError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<MfCommitResult | null>(null);
  const [commitError, setCommitError] = useState<{ code: string; message: string } | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undone, setUndone] = useState<number | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const once = useSingleFlight();

  useEffect(() => {
    if (step > 0) headingRef.current?.focus();
  }, [step]);

  const validate = useMutation({
    mutationFn: (f: File) => validateMfStatement(f),
    onSuccess: (data) => {
      setValidation(data);
      setExcluded(new Set());
      setChoices({});
      setMapError(null);
      setCommitError(null);
      setStep(1);
    },
  });

  const saveMappings = useMutation({
    mutationFn: async (pending: Array<[string, Choice]>) => {
      for (const [fundName, c] of pending) {
        await putMapping({ fund_name: fundName, scheme_code: c.code, remap: false });
      }
      if (!validation) throw new Error("no upload");
      return revalidateMfStatement(validation.upload_id);
    },
    onSuccess: (data) => {
      setValidation(data);
      setMapError(null);
      setChoices({});
      invalidatePortfolio(qc);
    },
    onError: (e) => {
      if (isApiError(e, "NOT_FOUND")) setMapError("This upload expired. Upload the file again.");
      else if (isApiError(e, "FUND_MAPPING_IN_USE"))
        setMapError(
          "A stored transaction already depends on a different scheme for this name. Change it in the fund-name mappings list on the Portfolio page.",
        );
      else setMapError(describeError(e));
    },
  });

  const commit = useMutation({
    mutationFn: (id: string) => commitMfStatement(id, note, [...excluded]),
    onSuccess: (data) => {
      setConfirmOpen(false);
      setResult(data);
      invalidatePortfolio(qc);
    },
    onError: (e) => {
      setConfirmOpen(false);
      setCommitError({ code: e instanceof ApiError ? e.code : "", message: describeError(e) });
    },
  });

  const undo = useMutation({
    mutationFn: (id: number) => undoBatch(id),
    onSuccess: (d) => {
      setUndoOpen(false);
      setUndone(d.removed);
      setUndoError(null);
      void qc.invalidateQueries({ queryKey: ["import-batches"] });
      invalidatePortfolio(qc);
    },
    onError: (e) => {
      setUndoOpen(false);
      setUndoError(
        isApiError(e, "UNDO_BREAKS_HOLDINGS") ? breaksHoldingsText(e) : describeError(e),
      );
    },
  });

  const pre = picked ? precheckFile(picked, "mf_statement") : null;
  const file = pre?.blocked ? null : picked;

  const restart = () => {
    setPicked(null);
    setValidation(null);
    setExcluded(new Set());
    setChoices({});
    setMapError(null);
    setNote("");
    setResult(null);
    setCommitError(null);
    setUndone(null);
    setUndoError(null);
    setStep(0);
    validate.reset();
    commit.reset();
    saveMappings.reset();
    if (fileRef.current) fileRef.current.value = "";
  };

  const view = useMemo(() => (validation ? readMfPreview(validation) : null), [validation]);
  const unmappedCount = view?.unmapped.length ?? 0;
  const allowed = canCommit(validation, unmappedCount);
  const dupLines = useMemo(() => {
    const set = new Set<number>();
    for (const g of view?.dupGroups ?? []) for (const r of g.rows) set.add(r);
    return [...set].sort((a, b) => a - b);
  }, [view]);

  const toggle = (line: number, include: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (include) next.delete(line);
      else next.add(line);
      return next;
    });

  const importing = validation
    ? rowsToImport(validation.rows, excluded.size, validation.mf.duplicates_in_db)
    : null;
  const expired = isApiError(commit.error, "NOT_FOUND") || isApiError(validate.error, "NOT_FOUND");

  const steps: WizardStep[] = [
    {
      id: "upload",
      label: "Upload",
      content: (
        <div className="flex flex-col gap-3">
          <h2 className="text-lead font-semibold text-text-1">Choose your mutual fund statement</h2>
          <p className="text-body-sm text-text-2">
            The statement from your broker (columns Date, Fund Name, Transaction Type, Folio No,
            Units Traded, NAV, Amount, Stamp Duty), as .csv or .xlsx up to 2 MB and 5,000 rows. The
            file is checked and previewed first; nothing is saved until you commit.
          </p>
          <FormField
            label="Statement file"
            hint="CSV or Excel (.xlsx). Only the normalised rows are shown back to you."
            required
          >
            {(p) => (
              <input
                {...p}
                ref={fileRef}
                type="file"
                accept=".csv,.txt,.xlsx,text/csv"
                data-testid="mf-import-file"
                className={inputClass}
                onChange={(e) => {
                  setPicked(e.target.files?.[0] ?? null);
                  validate.reset();
                }}
              />
            )}
          </FormField>
          {pre?.blocked ? (
            <Banner tone="error" testId="mf-import-file-error">
              {pre.blocked}
            </Banner>
          ) : null}
          {validate.isError ? (
            <Banner tone="error" testId="mf-import-validate-error">
              {describeError(validate.error)}
            </Banner>
          ) : null}
        </div>
      ),
    },
    {
      id: "review",
      label: "Review",
      content:
        validation && view ? (
          <div className="flex flex-col gap-4">
            <h2 ref={headingRef} tabIndex={-1} className={headingClass}>
              Review the statement
            </h2>
            <p role="status" data-testid="mf-import-summary" className="text-body text-text-1">
              <Fmt f={formatCount(validation.rows)} /> rows read,{" "}
              <Fmt f={formatCount(validation.error_count)} /> errors,{" "}
              <Fmt f={formatCount(validation.warning_count)} /> warnings.
            </p>
            <section
              aria-label="Statement summary"
              data-testid="mf-import-preview"
              className="flex flex-col gap-1 text-body-sm text-text-1"
            >
              <p data-testid="mf-import-range">
                Dates: {validation.mf.date_from ? formatDate(validation.mf.date_from).text : DASH}{" "}
                to {validation.mf.date_to ? formatDate(validation.mf.date_to).text : DASH}.
              </p>
              <p data-testid="mf-import-types">
                Rows by type:{" "}
                {TYPE_ORDER.filter((t) => (validation.mf.rows_by_type[t] ?? 0) > 0)
                  .map(
                    (t) =>
                      `${typeLabel(t)} ${formatCount(validation.mf.rows_by_type[t] ?? 0).text}`,
                  )
                  .join(", ") || DASH}
                .
              </p>
              <p data-testid="mf-import-funds">
                Funds: {formatCount(view.funds.length).text}, of which{" "}
                {formatCount(view.funds.filter((f) => f.mapped).length).text} already matched to a
                scheme
                {view.funds
                  .filter((f) => f.mapped)
                  .map((f) => ` (${f.fund_name} -> ${f.scheme_name ?? f.scheme_code})`)
                  .join("")}
                .
              </p>
              {validation.mf.duplicates_in_db > 0 ? (
                <p data-testid="mf-import-in-db">
                  {formatCount(validation.mf.duplicates_in_db).text} rows are already stored and
                  will be skipped, so importing the same statement twice adds nothing.
                </p>
              ) : null}
            </section>
            {view.badRows > 0 ? (
              <Banner tone="warn" testId="mf-import-bad-rows">
                Part of the funds block could not be read ({view.badRows} items); the rest is shown.
              </Banner>
            ) : null}
            <MfFundMapping
              funds={view.unmapped}
              choices={choices}
              onChoose={(name, c) => setChoices((prev) => ({ ...prev, [name]: c }))}
              onSave={() => saveMappings.mutate(Object.entries(choices))}
              saving={saveMappings.isPending}
              error={mapError}
            />
            {commitError ? (
              <Banner tone="error" testId="mf-import-commit-error">
                {commitError.message}
              </Banner>
            ) : null}
            <IssueList
              kind="error"
              issues={otherErrors(validation.errors)}
              total={otherErrors(validation.errors).length}
            />
            {unmappedCount > 0 ? (
              <p className="text-body-sm text-text-2" data-testid="mf-import-unmapped-note">
                {formatCount(unmappedCount).text} fund names have no scheme yet; their rows cannot
                be imported until you choose.
              </p>
            ) : null}
            <IssueList
              kind="warning"
              issues={otherWarnings(validation.warnings)}
              total={otherWarnings(validation.warnings).length}
            />
            {dupLines.length > 0 ? (
              <section
                aria-label="Repeated rows"
                data-testid="mf-import-dups"
                className="flex flex-col gap-2"
              >
                <h3 className="text-body font-semibold text-text-1">Repeated rows</h3>
                <p className="text-body-sm text-text-2">
                  These rows are identical in the file. Two identical rows are usually two real
                  transactions (for example two SIPs on one day), so every row stays selected.
                  Untick a row to leave it out.
                </p>
                {view.dupGroups.map((g, gi) => (
                  <fieldset
                    key={gi}
                    className="rounded-control border border-border p-2"
                    data-testid={`mf-dup-group-${gi}`}
                  >
                    <legend className="px-1 text-caption text-text-2">
                      {formatCount(g.count).text} identical rows
                    </legend>
                    <div className="flex flex-wrap gap-3">
                      {g.rows.map((line) => (
                        <label
                          key={line}
                          className="touch-target inline-flex items-center gap-2 text-body-sm"
                        >
                          <input
                            type="checkbox"
                            data-testid={`mf-dup-include-${line}`}
                            checked={!excluded.has(line)}
                            onChange={(e) => toggle(line, e.target.checked)}
                          />
                          Row {line}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </section>
            ) : null}
            <section aria-label="Preview" className="flex flex-col gap-2">
              <h3 className="text-body font-semibold text-text-1">Preview (first 20 rows)</h3>
              {validation.preview.length === 0 ? (
                <p className="text-body-sm text-text-2" data-testid="mf-import-preview-empty">
                  No valid rows to preview.
                </p>
              ) : (
                <div
                  tabIndex={0}
                  role="region"
                  aria-label="Preview table"
                  className="overflow-auto rounded-control border border-border"
                >
                  <table
                    data-testid="mf-import-preview-table"
                    className="w-full text-left text-body-sm"
                  >
                    <caption className="sr-only">
                      First rows of the statement as normalised by the server
                    </caption>
                    <thead className="bg-surface-2 text-text-2">
                      <tr>
                        <th scope="col" className="px-2 py-1 font-medium">
                          Include
                        </th>
                        {COLUMNS.map((c) => (
                          <th
                            key={c.key}
                            scope="col"
                            className="whitespace-nowrap px-2 py-1 font-medium"
                          >
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {validation.preview.map((r, i) => {
                        const line = typeof r.row === "number" ? r.row : null;
                        return (
                          <tr
                            key={i}
                            className="border-t border-border"
                            data-testid={`mf-import-row-${line ?? i}`}
                          >
                            <td className="px-2 py-1">
                              {line !== null ? (
                                <input
                                  type="checkbox"
                                  aria-label={`Include row ${line}`}
                                  data-testid={`mf-row-include-${line}`}
                                  checked={!excluded.has(line)}
                                  onChange={(e) => toggle(line, e.target.checked)}
                                />
                              ) : (
                                DASH
                              )}
                            </td>
                            {COLUMNS.map((c) => (
                              <td key={c.key} className="whitespace-nowrap px-2 py-1 tabular-nums">
                                {formatCell(r[c.key])}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {excluded.size > 0 ? (
                <p className="text-body-sm text-text-1" data-testid="mf-import-excluded">
                  {formatCount(excluded.size).text} rows are unticked and will not be imported.
                </p>
              ) : null}
            </section>
          </div>
        ) : null,
    },
    {
      id: "commit",
      label: "Commit",
      content: (
        <div className="flex flex-col gap-3">
          <h2 ref={headingRef} tabIndex={-1} className={headingClass}>
            Commit
          </h2>
          <p className="text-body-sm text-text-2" data-testid="mf-import-commit-note">
            <Fmt f={formatCount(importing)} /> rows will be added as one batch, in one transaction
            {excluded.size > 0
              ? `, leaving out ${formatCount(excluded.size).text} unticked rows`
              : ""}
            {validation && validation.mf.duplicates_in_db > 0
              ? ` and skipping ${formatCount(validation.mf.duplicates_in_db).text} that are already stored`
              : ""}
            . You can undo the batch for 30 days on the Batches tab. A redemption that would exceed
            the units held in its scheme and folio stops the whole import and nothing is saved.
          </p>
          {commitError ? (
            <Banner tone="error" testId="mf-import-commit-error">
              {commitError.message}
            </Banner>
          ) : null}
          <FormField label="Note (optional)" hint="For example: broker statement 2023 to 2026.">
            {(p) => (
              <input
                {...p}
                data-testid="mf-import-note"
                className={inputClass}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </FormField>
        </div>
      ),
    },
  ];

  const canAdvance = step === 0 ? file !== null : allowed;

  const announce = (
    <div role="status" aria-live="polite" className="sr-only" data-testid="mf-import-announce">
      {result ? `Statement imported, batch ${result.batch_id}.` : ""}
    </div>
  );

  if (result) {
    return (
      <>
        {announce}
        <section
          data-testid="mf-import-result"
          aria-label="Import result"
          className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
        >
          <h2
            ref={headingRef}
            tabIndex={-1}
            data-testid="mf-import-result-heading"
            className={headingClass}
          >
            Statement imported (batch {result.batch_id})
          </h2>
          <ul className="text-body-sm text-text-1">
            <li data-testid="mf-result-inserted">
              Added: <Fmt f={formatCount(result.inserted)} />
            </li>
            <li data-testid="mf-result-skipped">
              Skipped, already stored: <Fmt f={formatCount(result.skipped_duplicates)} />
            </li>
          </ul>
          {result.warnings.map((w) => (
            <Banner key={w} tone="warn" testId="mf-result-warning">
              {COMMIT_WARNING_TEXT[w] ?? w}
            </Banner>
          ))}
          {undone !== null ? (
            <Banner tone="info" testId="mf-result-undone">
              Batch {result.batch_id} undone: {formatCount(undone).text} rows removed.
            </Banner>
          ) : null}
          {undoError ? (
            <Banner tone="error" testId="mf-result-undo-error">
              {undoError}
            </Banner>
          ) : null}
          <p className="text-body-sm text-text-2" data-testid="mf-result-undo-note">
            Holdings are computed from your transactions, so they update at once. You can undo this
            batch within 30 days, here or on the Batches tab.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="mf-result-undo"
              disabled={undone !== null || undo.isPending}
              onClick={() => setUndoOpen(true)}
              className="touch-target h-9 rounded-control border border-down px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50"
            >
              Undo this import
            </button>
            <button
              type="button"
              data-testid="mf-import-another"
              onClick={restart}
              className="touch-target h-9 rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3"
            >
              Import another statement
            </button>
          </div>
        </section>
        <ConfirmDialog
          open={undoOpen}
          title={`Undo batch ${result.batch_id}?`}
          message="This removes the transactions of this import. If a later redemption would then exceed the units held, nothing is removed and you are told which one."
          confirmLabel="Undo batch"
          danger
          busy={undo.isPending}
          onCancel={() => setUndoOpen(false)}
          onConfirm={() => once(() => undo.mutateAsync(result.batch_id))}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="mf-import-wizard">
      {announce}
      {expired ? (
        <Banner tone="warn" testId="mf-import-expired">
          This upload expired (uploads are kept for 1 hour). Upload the file again.{" "}
          <button
            type="button"
            data-testid="mf-import-restart"
            onClick={restart}
            className="touch-target inline-flex items-center underline"
          >
            Start over
          </button>
        </Banner>
      ) : null}
      <Wizard
        steps={steps}
        step={step}
        busy={validate.isPending || commit.isPending || saveMappings.isPending}
        canAdvance={canAdvance}
        commitLabel="Commit import"
        onBack={() => {
          if (step === 1) {
            setValidation(null);
            validate.reset();
          }
          setStep(step - 1);
        }}
        onNext={() => {
          if (step === 0 && file) validate.mutate(file);
          else setStep(step + 1);
        }}
        onCommit={() => {
          if (validation) setConfirmOpen(true);
        }}
      />
      <ConfirmDialog
        open={confirmOpen}
        title={`Commit ${formatCount(importing).text} rows?`}
        message="The rows are added to your mutual fund ledger. You can undo the batch for 30 days."
        confirmLabel="Commit"
        busy={commit.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          if (validation) once(() => commit.mutateAsync(validation.upload_id));
        }}
      />
    </div>
  );
}
