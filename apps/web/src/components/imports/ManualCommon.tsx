"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Banner } from "@/components/ui/banners";
import { FormField, inputClass } from "@/components/ui/FormField";
import { fieldErrors, describeError, isApiError } from "@/lib/imports/errors";
import type { FieldErrors } from "@/lib/imports/entry-validate";
import type { ManualResult } from "@/lib/imports/schemas";
import { formatCount } from "@/lib/format";
import { Fmt } from "./Fmt";

/** Sentences for the warning codes of the manual endpoints; an unknown code shows its message. */
const WARNING_TEXT: Record<string, string> = {
  POST_IMPORT_NOT_QUEUED:
    "The entry is saved, but the analytics refresh was not queued. Any later import refreshes them.",
};

export const FILING_NOTE_HINT = 'For example: "as per company filing dated 2026-08-12".';

/** Server `details.fields` mapped to form field names (`values.revenue` becomes `revenue`). */
export function serverFieldMap(error: unknown): FieldErrors {
  const out: FieldErrors = {};
  for (const f of fieldErrors(error)) {
    const key = f.field.startsWith("values.") ? f.field.slice("values.".length) : f.field;
    if (!(key in out)) out[key] = f.message;
  }
  return out;
}

/** True when the error is a 404 for the symbol path (unknown or old symbol). */
export function isUnknownSymbol(error: unknown): boolean {
  return isApiError(error, "NOT_FOUND");
}

/** Message for a field: the local check first, then the server's. */
export function pick(local: FieldErrors, server: FieldErrors, key: string): string | null {
  return local[key] ?? server[key] ?? null;
}

export function SymbolInput({
  value,
  onChange,
  error,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  testId: string;
}) {
  return (
    <FormField
      label="Symbol"
      hint="The exchange symbol of a stock that is already in your list, for example TCS."
      required
      error={error}
    >
      {(p) => (
        <input
          {...p}
          data-testid={testId}
          className={inputClass}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}

export function NoteInput({
  value,
  onChange,
  error,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  testId: string;
}) {
  return (
    <FormField label="Note (optional)" hint={FILING_NOTE_HINT} error={error}>
      {(p) => (
        <input
          {...p}
          data-testid={testId}
          className={inputClass}
          maxLength={500}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}

/** Text input for one number or date cell. The value stays as typed so a bad cell can be fixed. */
export function CellInput({
  label,
  hint,
  unit,
  value,
  onChange,
  error,
  testId,
  required = false,
  placeholder,
}: {
  label: string;
  hint?: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  testId: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <FormField label={label} hint={hint} unit={unit} error={error} required={required}>
      {(p) => (
        <input
          {...p}
          data-testid={testId}
          className={inputClass}
          autoComplete="off"
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}

/** Errors that no field shows (a banner above the submit button). */
export function GenericError({
  error,
  shown,
  testId,
  unknownSymbolText,
}: {
  error: unknown;
  /** True when a field already shows the server's message. */
  shown: boolean;
  testId: string;
  unknownSymbolText: string;
}) {
  if (!error || shown) return null;
  return (
    <Banner tone="error" testId={testId}>
      {isUnknownSymbol(error) ? unknownSymbolText : describeError(error)}
    </Banner>
  );
}

/**
 * Result of a saved manual entry. It is announced (`role="status"`) and takes focus, because the
 * submit button keeps its place but the owner needs to hear the outcome.
 */
export function ManualResultPanel({
  result,
  title,
  testId,
  children,
}: {
  result: ManualResult;
  title: string;
  testId: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [result]);
  return (
    <section
      role="status"
      aria-live="polite"
      data-testid={testId}
      className="flex flex-col gap-2 rounded-card border border-border bg-surface-1 p-3"
    >
      <h3
        ref={ref}
        tabIndex={-1}
        data-testid={`${testId}-heading`}
        className="text-body font-semibold text-text-1 outline-none focus-visible:outline-2 focus-visible:outline-accent"
      >
        {title} (batch {result.batch_id})
      </h3>
      <p className="text-body-sm text-text-1">
        Added: <Fmt f={formatCount(result.inserted)} />, updated:{" "}
        <Fmt f={formatCount(result.updated)} />.
      </p>
      {result.warnings.map((w, i) => (
        <Banner key={`${w.code}-${i}`} tone="warn" testId="manual-warning">
          {WARNING_TEXT[w.code] ?? w.message}
        </Banner>
      ))}
      {children}
    </section>
  );
}

export function SubmitButton({
  testId,
  pending,
  label,
}: {
  testId: string;
  pending: boolean;
  label: string;
}) {
  return (
    <button
      type="submit"
      data-testid={testId}
      disabled={pending}
      className="touch-target h-9 rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
    >
      {pending ? "Saving" : label}
    </button>
  );
}
