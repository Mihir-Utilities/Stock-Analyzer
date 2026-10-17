"use client";

import { useSyncExternalStore } from "react";
import {
  WAKING_MESSAGE,
  wakingTracker,
  type WakingSnapshot,
  type WakingTracker,
} from "@/lib/api/waking";

export function useWaking(tracker: WakingTracker = wakingTracker): WakingSnapshot {
  return useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot);
}

/** Shown after 3 s of waiting on the API, with elapsed seconds; hides on its own (UI-01). */
export function WakingBanner({ tracker = wakingTracker }: { tracker?: WakingTracker }) {
  const { waking, elapsedSeconds } = useWaking(tracker);
  return (
    <div role="status" aria-live="polite" data-testid="waking-region">
      {waking ? (
        <p
          data-testid="waking-banner"
          className="border-b border-border bg-surface-2 px-4 py-2 text-body-sm text-text-1"
        >
          {WAKING_MESSAGE} <span data-testid="waking-elapsed">{elapsedSeconds} s</span>
        </p>
      ) : null}
    </div>
  );
}
