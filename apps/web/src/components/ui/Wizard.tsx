"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx";

export interface WizardStep {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * Multi-step flow (upload, validate, preview, commit) with a progress list. Controlled: the
 * caller owns `step` and decides when `canAdvance` is true (for example after validation).
 */
export function Wizard({
  steps,
  step,
  canAdvance,
  busy = false,
  onBack,
  onNext,
  onCommit,
  commitLabel = "Commit",
}: {
  steps: WizardStep[];
  step: number;
  canAdvance: boolean;
  busy?: boolean;
  onBack: () => void;
  onNext: () => void;
  onCommit: () => void;
  commitLabel?: string;
}) {
  const last = step === steps.length - 1;
  const current = steps[step];
  return (
    <div data-testid="wizard" className="flex flex-col gap-4">
      <ol aria-label="Progress" className="flex flex-wrap gap-2">
        {steps.map((s, i) => (
          <li
            key={s.id}
            data-testid={`wizard-step-${s.id}`}
            aria-current={i === step ? "step" : undefined}
            className={cx(
              "flex items-center gap-1 rounded-chip border px-3 py-1 text-caption",
              i === step ? "border-accent text-text-1" : "border-border text-text-2",
            )}
          >
            {i < step ? <Check size={12} strokeWidth={2} aria-label="Done" /> : null}
            <span>
              {i + 1}. {s.label}
            </span>
          </li>
        ))}
      </ol>
      <div aria-busy={busy}>{current?.content}</div>
      <div className="flex justify-between gap-2">
        <button
          type="button"
          data-testid="wizard-back"
          disabled={step === 0 || busy}
          onClick={onBack}
          className="h-9 rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50"
        >
          Back
        </button>
        {last ? (
          <button
            type="button"
            data-testid="wizard-commit"
            disabled={!canAdvance || busy}
            onClick={onCommit}
            className="h-9 rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
          >
            {busy ? "Working" : commitLabel}
          </button>
        ) : (
          <button
            type="button"
            data-testid="wizard-next"
            disabled={!canAdvance || busy}
            onClick={onNext}
            className="h-9 rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
