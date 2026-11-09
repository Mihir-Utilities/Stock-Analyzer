import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { MF_NOTICE } from "@/lib/mf/derive";

export const btn =
  "inline-flex h-9 touch-target items-center justify-center gap-1.5 rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60";
export const linkBtn = cx(btn, "no-underline");

// The attribution "NAV data: AMFI, via mfapi.in" (SAF-03, D-W 7) is shown by the app shell footer on
// every /mf path (components/shell/Footer.tsx), also while loading and on error.

export function MfNotice() {
  return (
    <p data-testid="mf-notice" className="text-caption text-text-2">
      {MF_NOTICE}.
    </p>
  );
}

export function MfChip({
  children,
  testId,
  tone = "neutral",
}: {
  children: ReactNode;
  testId: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <span
      data-testid={testId}
      className={cx(
        "inline-flex items-center rounded-chip border bg-surface-2 px-2 py-0.5 text-micro",
        tone === "warn" ? "border-warn text-text-1" : "border-border text-text-2",
      )}
    >
      {children}
    </span>
  );
}
