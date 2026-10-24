"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Banner } from "@/components/ui/banners";
import { ConfirmDialog } from "@/components/ui/overlays";
import { FormField, inputClass } from "@/components/ui/FormField";
import { runAdjustmentCheck, setPricesAdjustment } from "@/lib/imports/api";
import { describeError, fieldMessage, isApiError } from "@/lib/imports/errors";
import { formatRatio, UNKNOWN } from "@/lib/imports/local-format";
import type { AdjustmentCheck } from "@/lib/imports/schemas";

/** Wizard text of docs/01 section 3.7 (rule 4), shown verbatim. */
export const ADJUSTMENT_WIZARD_TEXT =
  "Raw prices jump at splits and bonuses; adjusted prices are already smoothed. Choose what your file contains and keep one kind per source. Do not mix raw and adjusted files.";

function storedChoice(current: boolean | null): AdjustmentValue | null {
  return current === null ? null : current ? "adjusted" : "raw";
}

export type AdjustmentValue = "raw" | "adjusted" | "unknown";

const OPTIONS: Array<{ value: AdjustmentValue; label: string }> = [
  { value: "raw", label: "Raw (not adjusted for splits and bonus)" },
  { value: "adjusted", label: "Already adjusted for splits and bonus" },
  { value: "unknown", label: "I don't know" },
];

const HINT_TEXT: Record<AdjustmentCheck["hint"], string> = {
  raw_likely:
    "The close gaps near the expected ratio, so the file looks raw. This is a hint only; you decide.",
  adjusted_likely:
    "The close shows no gap at the ex-date, so the file looks already adjusted. This is a hint only; you decide.",
  inconclusive:
    "The ratio matches neither a gap nor a smooth series. Try another split or bonus you know about. This is a hint only.",
};

/**
 * The required raw / already adjusted / I don't know choice of the prices wizard (docs/01 3.7,
 * decision D-K). `current` is the stored setting (`null` = not chosen yet). Choosing raw or
 * adjusted persists it via PUT /settings/prices-adjustment; "I don't know" persists nothing and
 * opens the Adjustment check on the validated upload.
 */
export function AdjustmentChoice({
  uploadId,
  current,
  symbols,
  onChanged,
}: {
  uploadId: string;
  current: boolean | null;
  symbols: string[];
  onChanged: (value: boolean) => void;
}) {
  const [choice, setChoice] = useState<AdjustmentValue | null>(storedChoice(current));
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: ({ value, confirm }: { value: boolean; confirm: boolean }) =>
      setPricesAdjustment(value, confirm),
    onSuccess: (data, vars) => {
      setPending(null);
      setError(null);
      setChoice(vars.value ? "adjusted" : "raw");
      if (data.value !== null) onChanged(data.value);
    },
    onError: (e, vars) => {
      // The API asks for confirmation when an already-set value changes (field `confirm`).
      setChoice(storedChoice(current)); // undo the optimistic selection
      if (fieldMessage(e, "confirm") !== null) {
        setPending(vars.value);
        return;
      }
      setError(describeError(e));
    },
  });

  const choose = (v: AdjustmentValue) => {
    setError(null);
    if (v === "unknown") {
      setChoice("unknown");
      return;
    }
    const value = v === "adjusted";
    if (current !== null && current !== value) {
      setPending(value); // changing a stored value: show the mixing warning first
      return;
    }
    setChoice(v); // optimistic; reverted if the save fails
    save.mutate({ value, confirm: false });
  };

  return (
    <fieldset
      data-testid="adjustment-choice"
      className="flex flex-col gap-3 rounded-card border border-border p-3"
    >
      <legend className="px-1 text-body font-semibold text-text-1">
        These prices are:{" "}
        <span className="text-text-2">(required before the first prices commit)</span>
      </legend>
      <p className="text-body-sm text-text-2" data-testid="adjustment-wizard-text">
        {ADJUSTMENT_WIZARD_TEXT}
      </p>
      <div className="flex flex-col gap-2">
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-body-sm text-text-1">
            <input
              type="radio"
              name="prices-adjustment"
              value={o.value}
              data-testid={`adjustment-${o.value}`}
              checked={choice === o.value}
              disabled={save.isPending}
              onChange={() => choose(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
      {choice === null ? (
        <Banner tone="warn" testId="adjustment-required">
          Choose one option to continue. The commit is blocked until the setting is chosen.
        </Banner>
      ) : null}
      {choice === "unknown" ? (
        <Banner tone="warn" testId="adjustment-unknown">
          Nothing was saved. Run the check below, then choose Raw or Already adjusted.
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="error" testId="adjustment-error">
          {error}
        </Banner>
      ) : null}
      {choice === "unknown" ? <AdjustmentCheckPanel uploadId={uploadId} symbols={symbols} /> : null}
      <ConfirmDialog
        open={pending !== null}
        title="Change the raw / adjusted setting?"
        message="Bars already stored keep their own setting. Mixing raw and adjusted files for the same stock is an owner error and can show a false split or bonus warning."
        confirmLabel="Change setting"
        danger
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending !== null) save.mutate({ value: pending, confirm: true });
        }}
      />
    </fieldset>
  );
}

function parseRatio(num: string, den: string): { num: number; den: number } | null | "invalid" {
  if (!num.trim() && !den.trim()) return null;
  const n = Number(num);
  const d = Number(den);
  if (!Number.isInteger(n) || !Number.isInteger(d) || n <= 0 || d <= 0) return "invalid";
  return { num: n, den: d };
}

/** Adjustment check (docs/01 3.7 rule 2): closes around a known ex-date from the uploaded file. */
function AdjustmentCheckPanel({ uploadId, symbols }: { uploadId: string; symbols: string[] }) {
  const [symbol, setSymbol] = useState(symbols[0] ?? "");
  const [exDate, setExDate] = useState("");
  const [num, setNum] = useState("");
  const [den, setDen] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const check = useMutation({ mutationFn: runAdjustmentCheck });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!symbol.trim()) errs.symbol = "Enter a symbol from the file.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate)) errs.exDate = "Enter the ex-date as a date.";
    const ratio = parseRatio(num, den);
    if (ratio === "invalid")
      errs.ratio = "Enter both numbers as whole numbers above 0, or leave both empty.";
    setLocal(errs);
    if (Object.keys(errs).length > 0 || ratio === "invalid") return;
    check.mutate({ uploadId, symbol: symbol.trim().toUpperCase(), exDate, ratio });
  };

  const apiSymbolErr = check.error ? fieldMessage(check.error, "symbol") : null;
  const apiDateErr = check.error ? fieldMessage(check.error, "ex_date") : null;
  const gone = isApiError(check.error, "NOT_FOUND");

  return (
    <form
      onSubmit={submit}
      noValidate
      data-testid="adjustment-check"
      className="flex flex-col gap-3 rounded-control border border-border bg-surface-2 p-3"
    >
      <h4 className="text-body font-semibold text-text-1">Adjustment check</h4>
      <p className="text-body-sm text-text-2">
        Pick a split or bonus you know about. The check reads the uploaded file only and writes
        nothing.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Symbol" required error={local.symbol ?? apiSymbolErr}>
          {(p) => (
            <input
              {...p}
              data-testid="check-symbol"
              list="check-symbols"
              className={inputClass}
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            />
          )}
        </FormField>
        <datalist id="check-symbols">
          {symbols.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <FormField label="Ex-date" required error={local.exDate ?? apiDateErr}>
          {(p) => (
            <input
              {...p}
              type="date"
              data-testid="check-exdate"
              className={inputClass}
              value={exDate}
              onChange={(e) => setExDate(e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Expected ratio (optional)"
          hint="After / before, for example 1 and 2 for a 1:2 split."
          error={local.ratio}
        >
          {(p) => (
            <div className="flex items-center gap-2">
              <input
                {...p}
                inputMode="numeric"
                aria-label="Expected ratio numerator"
                data-testid="check-ratio-num"
                className={inputClass}
                value={num}
                onChange={(e) => setNum(e.target.value)}
              />
              <span aria-hidden="true">:</span>
              <input
                inputMode="numeric"
                aria-label="Expected ratio denominator"
                data-testid="check-ratio-den"
                className={inputClass}
                value={den}
                onChange={(e) => setDen(e.target.value)}
              />
            </div>
          )}
        </FormField>
      </div>
      <div>
        <button
          type="submit"
          data-testid="check-run"
          disabled={check.isPending}
          className="h-9 rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
        >
          {check.isPending ? "Checking" : "Run check"}
        </button>
      </div>
      {check.isError && !apiSymbolErr && !apiDateErr ? (
        <Banner tone="error" testId="check-error">
          {gone ? "The upload expired. Upload the file again." : describeError(check.error)}
        </Banner>
      ) : null}
      {check.data ? <AdjustmentResult result={check.data} /> : null}
    </form>
  );
}

function AdjustmentResult({ result }: { result: AdjustmentCheck }) {
  return (
    <div data-testid="check-result" role="status" className="flex flex-col gap-2">
      <table className="w-full max-w-sm text-left text-body-sm">
        <caption className="sr-only">Closes around the ex-date</caption>
        <thead className="text-text-2">
          <tr>
            <th scope="col" className="px-2 py-1 font-medium">
              Date
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              Close
            </th>
          </tr>
        </thead>
        <tbody>
          {result.bars.map(([d, c]) => (
            <tr key={d} className="border-t border-border">
              <td className="px-2 py-1">{d}</td>
              <td className="px-2 py-1 tabular-nums">{Number.isFinite(c) ? c : UNKNOWN}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-body-sm text-text-1">
        Observed ratio (close on the ex-date / previous close):{" "}
        <span data-testid="check-ratio">{formatRatio(result.ratio)}</span>
        {result.nearest_fraction
          ? ` (nearest ${result.nearest_fraction})`
          : " (no common fraction)"}
      </p>
      <Banner tone="info" testId="check-hint">
        {HINT_TEXT[result.hint]}
      </Banner>
    </div>
  );
}
