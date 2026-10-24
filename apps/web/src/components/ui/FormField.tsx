import { useId, type ReactNode } from "react";
import { cx } from "./cx";

export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": boolean;
}

export const inputClass =
  "h-9 touch-target w-full min-w-0 rounded-control border border-border bg-surface-1 px-2 text-body text-text-1 aria-[invalid=true]:border-down";

/** Label, hint, optional unit suffix, inline error and accessible description. */
export function FormField({
  label,
  hint,
  unit,
  error,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  unit?: string;
  error?: string | null;
  required?: boolean;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ");
  return (
    <div data-testid="form-field" className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption font-medium text-text-1">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <div className="flex items-center gap-2">
        {children({
          id,
          "aria-describedby": describedBy || undefined,
          "aria-invalid": Boolean(error),
        })}
        {unit ? <span className="shrink-0 text-body-sm text-text-2">{unit}</span> : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-caption text-text-2">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errId}
          role="alert"
          data-testid="form-field-error"
          className={cx("text-caption text-text-1")}
        >
          <span className="font-medium text-down">Error: </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}
