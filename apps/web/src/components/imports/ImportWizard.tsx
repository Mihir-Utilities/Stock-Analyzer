"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { ConfirmDialog } from "@/components/ui/overlays";
import { FormField, inputClass } from "@/components/ui/FormField";
import { Wizard, type WizardStep } from "@/components/ui/Wizard";
import { ApiError } from "@/lib/api/client";
import { commitUpload, validateUpload } from "@/lib/imports/api";
import { describeError, isApiError } from "@/lib/imports/errors";
import { formatCount, formatMb } from "@/lib/format";
import { precheckFile } from "@/lib/imports/precheck";
import { useSingleFlight } from "@/lib/imports/single-flight";
import {
  IMPORT_KINDS,
  type CommitResult,
  type ImportKind,
  type ValidateResult,
} from "@/lib/imports/schemas";
import { UNDOABLE_KINDS } from "@/lib/imports/batches";
import { DB_SOFT_LIMIT_MB, exceedsLimit, sizeGuardMessage } from "@/lib/imports/storage";
import { AdjustmentChoice } from "./AdjustmentChoice";
import { Fmt } from "./Fmt";
import { IssueList, PreviewTable } from "./IssueLists";
import { useDbStatus } from "./StorageMeter";

/**
 * Default limits of the API (docs/01 section 7: 5 MB and 50,000 rows). `IMPORT_PRICES_LARGE_ENABLED`
 * stays off until spike S9, and the API exposes no endpoint with the active values (assumption
 * F13a-1), so the wizard shows the defaults as a hint and lets the server enforce the real ones.
 */
export const DEFAULT_LIMIT_TEXT = "Default limit: 5 MB and 50,000 rows per file.";

const KIND_LABEL: Record<ImportKind, string> = {
  instruments: "Stock list (instruments.csv)",
  prices: "Daily prices (prices.csv)",
  holidays: "Market holidays for a year (holidays.csv)",
  results_quarterly: "Quarterly results (results_quarterly.csv)",
  results_annual: "Annual results (results_annual.csv)",
  balance_cashflow: "Balance sheet and cash flow (balance_cashflow.csv)",
  fundamentals_long: "Fundamentals, long format (fundamentals_long.csv)",
  shareholding: "Shareholding (shareholding.csv)",
  corporate_actions: "Corporate actions (corporate_actions.csv)",
  instrument_meta: "Sector, industry and index tags (instrument_meta.csv)",
};

/** What a commit does and whether it can be undone, per kind (docs/01 section 7, B06b-4). */
function commitEffect(kind: ImportKind): string {
  if (kind === "prices") return "Prices are written to the database and analytics are recomputed. ";
  if (kind === "instruments") return "Stocks are added or updated; nothing is deleted. ";
  if (kind === "holidays")
    return "For every year in the file, all stored holidays of that year are replaced by the rows of the file. ";
  if (kind === "instrument_meta")
    return "Sector, industry and company type are updated (an empty cell keeps the stored value) and index tags in the file replace those of that stock. ";
  return "Values are saved (a value already stored for the same period is overwritten) and analytics are refreshed. ";
}

export function undoable(kind: ImportKind): boolean {
  return UNDOABLE_KINDS.includes(kind);
}

const COMMIT_WARNING_TEXT: Record<string, string> = {
  TRACKED_OVER_400:
    "More than 400 stocks are now tracked. The free tier may get slower; consider trimming history.",
  POST_IMPORT_NOT_QUEUED:
    "The rows are saved, but the analytics refresh was not queued. Any later import refreshes them.",
};

export function templateUrl(kind: ImportKind): string {
  return `/api/v1/imports/templates/${kind}`;
}

function symbolsOf(preview: Array<Record<string, unknown>>): string[] {
  const set = new Set<string>();
  for (const r of preview) {
    const s = r.symbol;
    if (typeof s === "string" && s) set.add(s);
  }
  return [...set];
}

export function ImportWizard({ initialKind = "prices" }: { initialKind?: ImportKind }) {
  const [kind, setKind] = useState<ImportKind>(initialKind);
  const [picked, setPicked] = useState<File | null>(null);
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [adjustment, setAdjustment] = useState<boolean | null>(null);
  const [step, setStep] = useState(0);
  const [note, setNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [commitError, setCommitError] = useState<{ code: string; message: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const once = useSingleFlight();
  const db = useDbStatus();
  const currentMb = db.data?.db.size_mb ?? null;

  // Move focus to the step heading after each step change (keyboard and screen reader users).
  useEffect(() => {
    if (step > 0) headingRef.current?.focus();
  }, [step]);

  const validate = useMutation({
    mutationFn: (f: File) => validateUpload(kind, f),
    onSuccess: (data) => {
      setValidation(data);
      setAdjustment(data.prices_already_adjusted);
      setCommitError(null);
      setStep(1);
    },
  });

  const commit = useMutation({
    mutationFn: (id: string) => commitUpload(kind, id, note),
    onSuccess: (data) => {
      setConfirmOpen(false);
      setResult(data);
    },
    onError: (e) => {
      setConfirmOpen(false);
      const code = e instanceof ApiError ? e.code : "";
      if (isApiError(e, "PRICES_ADJUSTMENT_UNSET")) {
        setAdjustment(null);
        setStep(1);
      }
      if (isApiError(e, "DB_SIZE_LIMIT")) setStep(1);
      setCommitError({ code, message: describeError(e) });
    },
  });

  // Client-side pre-check (extension and size); the server stays authoritative.
  const pre = picked ? precheckFile(picked, kind) : null;
  const file = pre?.blocked ? null : picked;

  const restart = () => {
    setPicked(null);
    setValidation(null);
    setAdjustment(null);
    setNote("");
    setResult(null);
    setCommitError(null);
    setStep(0);
    validate.reset();
    commit.reset();
    if (fileRef.current) fileRef.current.value = "";
  };

  const growth = validation?.estimated_growth_mb ?? null;
  const sizeBlocked = kind === "prices" && exceedsLimit(currentMb, growth);
  const errorCount = validation?.error_count ?? 0;
  const needsAdjustment = kind === "prices" && adjustment === null;

  const steps: WizardStep[] = (() => {
    const uploadStep = (
      <div className="flex flex-col gap-3">
        <h2 className="text-lead font-semibold text-text-1">Choose a file</h2>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-caption font-medium text-text-1">File type</legend>
          {IMPORT_KINDS.map((k) => (
            <label
              key={k}
              className="touch-target flex items-center gap-2 text-body-sm text-text-1"
            >
              <input
                type="radio"
                name="import-kind"
                value={k}
                data-testid={`import-kind-${k}`}
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setValidation(null);
                  validate.reset();
                }}
              />
              {KIND_LABEL[k]}
            </label>
          ))}
        </fieldset>
        <p className="text-body-sm text-text-2">
          Need the column layout?{" "}
          <a
            href={templateUrl(kind)}
            download
            data-testid="import-template-link"
            className="touch-target inline-flex items-center text-accent underline"
          >
            Download the {kind} template
          </a>
          .
        </p>
        <FormField
          label="CSV file"
          hint={`${DEFAULT_LIMIT_TEXT} The server enforces the active limit. UTF-8, comma or semicolon separated.`}
          required
        >
          {(p) => (
            <input
              {...p}
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              data-testid="import-file"
              className={inputClass}
              onChange={(e) => {
                setPicked(e.target.files?.[0] ?? null);
                validate.reset();
              }}
            />
          )}
        </FormField>
        {pre?.blocked ? (
          <Banner tone="error" testId="import-file-error">
            {pre.blocked}
          </Banner>
        ) : null}
        {pre?.warning ? (
          <Banner tone="warn" testId="import-file-warning">
            {pre.warning}
          </Banner>
        ) : null}
        {validate.isError ? (
          <Banner tone="error" testId="import-validate-error">
            {describeError(validate.error)}
          </Banner>
        ) : null}
      </div>
    );

    const reviewStep = validation ? (
      <div className="flex flex-col gap-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-lead font-semibold text-text-1 outline-none focus-visible:outline-2 focus-visible:outline-accent"
        >
          Review the file
        </h2>
        <p role="status" data-testid="import-summary" className="text-body text-text-1">
          <Fmt f={formatCount(validation.rows)} /> rows read,{" "}
          <Fmt f={formatCount(validation.error_count)} /> errors,{" "}
          <Fmt f={formatCount(validation.warning_count)} /> warnings.
        </p>
        {kind === "holidays" ? (
          <Banner tone="info" testId="import-holidays-note">
            Committing replaces every stored holiday of each year in this file with the rows of this
            file (the preview shows the first 20). Import the whole year. A date that falls on a
            weekend is kept with a warning.
          </Banner>
        ) : null}
        {commitError ? (
          <Banner tone="error" testId="import-commit-error">
            {commitError.code === "DB_SIZE_LIMIT" ? sizeGuardMessage() : commitError.message}
          </Banner>
        ) : null}
        <IssueList kind="error" issues={validation.errors} total={validation.error_count} />
        <IssueList kind="warning" issues={validation.warnings} total={validation.warning_count} />
        <section aria-label="Preview" className="flex flex-col gap-2">
          <h3 className="text-body font-semibold text-text-1">Preview (first 20 rows)</h3>
          <PreviewTable rows={validation.preview} />
        </section>
        {kind === "prices" ? (
          <>
            <section
              aria-label="Database growth"
              data-testid="import-growth"
              className="flex flex-col gap-2"
            >
              <h3 className="text-body font-semibold text-text-1">Database growth</h3>
              <p className="text-body-sm text-text-1">
                Estimated growth: <Fmt f={formatMb(growth)} /> (upper bound, about 130 bytes per
                row).
                {currentMb !== null ? (
                  <>
                    {" "}
                    The database is now <Fmt f={formatMb(currentMb)} /> of {DB_SOFT_LIMIT_MB} MB.
                  </>
                ) : (
                  " The current database size is not available; the server still checks the limit at commit."
                )}
              </p>
              {sizeBlocked ? (
                <Banner tone="error" testId="import-size-guard">
                  {sizeGuardMessage()}
                </Banner>
              ) : null}
            </section>
            <AdjustmentChoice
              uploadId={validation.upload_id}
              current={adjustment}
              symbols={symbolsOf(validation.preview)}
              onChanged={(v) => {
                setAdjustment(v);
                setCommitError(null);
              }}
            />
          </>
        ) : null}
      </div>
    ) : null;

    const commitStep = (
      <div className="flex flex-col gap-3">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-lead font-semibold text-text-1 outline-none focus-visible:outline-2 focus-visible:outline-accent"
        >
          Commit
        </h2>
        <p className="text-body-sm text-text-2">
          <Fmt f={formatCount(validation?.rows ?? null)} /> rows go in as one batch, in one
          transaction.{" "}
          {undoable(kind)
            ? "You can undo this batch for 30 days on the Batches tab; values it overwrote are not restored."
            : "This batch cannot be undone; re-import corrected data to change it."}
        </p>
        {commitError ? (
          <Banner tone="error" testId="import-commit-error">
            {commitError.message}
          </Banner>
        ) : null}
        <FormField label="Note (optional)" hint="For example: as per statement dated 2026-10-01.">
          {(p) => (
            <input
              {...p}
              data-testid="import-note"
              className={inputClass}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </FormField>
      </div>
    );

    return [
      { id: "upload", label: "Upload", content: uploadStep },
      { id: "review", label: "Review", content: reviewStep },
      { id: "commit", label: "Commit", content: commitStep },
    ];
  })();

  const expired = isApiError(commit.error, "NOT_FOUND");
  const canAdvance =
    step === 0
      ? file !== null
      : step === 1
        ? validation !== null && errorCount === 0 && !needsAdjustment && !sizeBlocked
        : validation !== null;

  // One persistent live region: it exists before the result so the announcement is spoken.
  const announce = (
    <div role="status" aria-live="polite" className="sr-only" data-testid="import-announce">
      {result ? `Import saved, batch ${result.batch_id}.` : ""}
    </div>
  );
  if (result) {
    return (
      <>
        {announce}
        <ImportResult kind={kind} result={result} onAnother={restart} />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="import-wizard">
      {announce}
      {expired ? (
        <Banner tone="warn" testId="import-expired">
          This upload expired (uploads are kept for 1 hour). Upload the file again.{" "}
          <button
            type="button"
            data-testid="import-restart"
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
        busy={validate.isPending || commit.isPending}
        canAdvance={canAdvance}
        commitLabel="Commit import"
        onBack={() => {
          if (step === 1) {
            setValidation(null);
            setAdjustment(null);
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
        title={`Commit ${formatCount(validation?.rows ?? null).text} rows?`}
        message={
          <>
            {commitEffect(kind)}
            {undoable(kind)
              ? "You can undo it for 30 days; overwritten values are not restored."
              : "This batch cannot be undone."}
          </>
        }
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

function ImportResult({
  kind,
  result,
  onAnother,
}: {
  kind: ImportKind;
  result: CommitResult;
  onAnother: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The commit button and dialog are gone: move focus to the result so it is not lost to <body>.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <section
      data-testid="import-result"
      aria-label="Import result"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        data-testid="import-result-heading"
        className="text-lead font-semibold text-text-1 outline-none focus-visible:outline-2 focus-visible:outline-accent"
      >
        Import saved (batch {result.batch_id})
      </h2>
      <ul className="text-body-sm text-text-1">
        <li data-testid="result-inserted">
          Inserted: <Fmt f={formatCount(result.inserted)} />
        </li>
        <li data-testid="result-updated">
          Updated: <Fmt f={formatCount(result.updated)} />
        </li>
        {kind === "instruments" ? (
          <li data-testid="result-renamed">
            Renamed (previous_symbol): <Fmt f={formatCount(result.renamed)} />
          </li>
        ) : null}
      </ul>
      {result.warnings.map((w) => (
        <Banner key={w} tone="warn" testId="result-warning">
          {COMMIT_WARNING_TEXT[w] ?? w}
        </Banner>
      ))}
      <p className="text-body-sm text-text-2" data-testid="result-undo-note">
        {undoable(kind)
          ? "To reverse this import, use Undo on the Batches tab within 30 days. Values this batch overwrote are not restored."
          : kind === "prices"
            ? "Price batches cannot be undone. To fix a mistake, import corrected data or use Trim history on the Storage tab."
            : `${kind === "instruments" ? "Instrument batches" : "This kind of batch"} cannot be undone. To fix a mistake, import corrected data.`}
      </p>
      <div>
        <button
          type="button"
          data-testid="import-another"
          onClick={onAnother}
          className="touch-target h-9 rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3"
        >
          Import another file
        </button>
      </div>
    </section>
  );
}
