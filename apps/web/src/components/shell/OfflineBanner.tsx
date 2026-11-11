"use client";

import { useSyncExternalStore } from "react";

export const OFFLINE_MESSAGE =
  "You are offline. Showing the data already loaded; it may be out of date. Reconnect to refresh.";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** `navigator.onLine`; the server snapshot is online so the first paint never flashes the banner. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * Offline banner (UI-06). Views keep showing what TanStack Query already holds; the banner says
 * the numbers may be old. The live region is always mounted so a screen reader hears the change.
 */
export function OfflineBanner() {
  const online = useOnline();
  return (
    <div role="status" aria-live="polite" data-testid="offline-region">
      {online ? null : (
        <p
          data-testid="offline-banner"
          className="border-b border-warn bg-surface-2 px-4 py-2 text-body-sm text-text-1"
        >
          {OFFLINE_MESSAGE}
        </p>
      )}
    </div>
  );
}
