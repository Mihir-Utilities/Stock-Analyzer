"use client";

import { AlertTriangle } from "lucide-react";
import type { Formatted } from "@/lib/format";
import { staleReasonText, stampText, type Stamp } from "@/lib/screener/display";

export const BTN =
  "inline-flex h-9 touch-target items-center justify-center rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60";

export const SELECT =
  "h-9 touch-target w-full min-w-0 rounded-control border border-border bg-surface-1 px-2 text-body text-text-1";

/** A formatted value; an unknown value is a dash with its reason in text for screen readers. */
export function MetricValue({ f }: { f: Formatted }) {
  if (f.reason === null) return <>{f.text}</>;
  return (
    <span title={f.reason}>
      {f.text}
      <span className="sr-only">, {f.reason}</span>
    </span>
  );
}

/**
 * The per-stock last updated stamp (decision D-R) and the stale flag. Stale is shown as the word
 * "Stale" with an icon and the reason, so colour is not the only signal.
 */
export function StampView({ stamp, testId }: { stamp: Stamp; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId} data-stale={stamp.stale}>
      <span className="text-caption text-text-1">{stampText(stamp)}</span>
      {stamp.stale ? (
        <span className="inline-flex items-center gap-1 text-micro text-text-1">
          <AlertTriangle size={12} strokeWidth={1.75} className="text-warn" aria-hidden="true" />
          <span className="rounded-chip border border-warn bg-surface-2 px-1.5 py-0.5">
            Stale: {staleReasonText(stamp.stale_reason)}
          </span>
        </span>
      ) : null}
    </div>
  );
}
