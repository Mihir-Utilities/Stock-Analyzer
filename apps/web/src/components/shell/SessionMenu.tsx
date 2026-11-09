"use client";

import { QueryClientContext } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useContext, useState } from "react";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { describeError } from "@/lib/imports/errors";
import { signOut } from "@/lib/auth/session";

/**
 * Sign-out controls for the top bar: "Sign out" (this browser) and "Sign out everywhere" (every
 * session, behind a confirmation). Works without a query client (shell tests); with one, every
 * cache is cleared before the redirect to /login. Also used by Settings, sessions card.
 */
export function useSignOutActions() {
  const client = useContext(QueryClientContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const once = useSingleFlight();
  const run = (all: boolean) =>
    once(async () => {
      setBusy(true);
      setError(null);
      try {
        await signOut(all, {
          clear: () => client?.clear(),
          go: (url) => window.location.assign(url),
        });
      } catch (e) {
        setError(describeError(e));
        setBusy(false);
      }
    });
  return { busy, error, run };
}

const ITEM =
  "touch-target h-9 rounded-control px-3 text-left text-body-sm text-text-1 hover:bg-surface-3 disabled:opacity-50";

/**
 * Sign out and Sign out everywhere. The second one asks inline (no dialog, so the shell never
 * adds a second `confirm-ok` to pages that have their own confirmations).
 */
export function SignOutPanel({ prefix }: { prefix: string }) {
  const [confirmAll, setConfirmAll] = useState(false);
  const { busy, error, run } = useSignOutActions();
  return (
    <div className="flex flex-col gap-1" data-testid={`${prefix}panel`}>
      {confirmAll ? (
        <div role="group" aria-label="Confirm sign out everywhere" className="flex flex-col gap-1">
          <p className="px-2 text-caption text-text-1">
            Every browser and device will be signed out.
          </p>
          <button
            type="button"
            data-testid={`${prefix}logout-all-confirm`}
            disabled={busy}
            onClick={() => run(true)}
            className={`${ITEM} border border-down`}
          >
            {busy ? "Signing out" : "Yes, sign out everywhere"}
          </button>
          <button
            type="button"
            data-testid={`${prefix}logout-all-cancel`}
            disabled={busy}
            onClick={() => setConfirmAll(false)}
            className={ITEM}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            data-testid={`${prefix}logout`}
            disabled={busy}
            onClick={() => run(false)}
            className={ITEM}
          >
            {busy ? "Signing out" : "Sign out"}
          </button>
          <button
            type="button"
            data-testid={`${prefix}logout-all`}
            disabled={busy}
            onClick={() => setConfirmAll(true)}
            className={ITEM}
          >
            Sign out everywhere
          </button>
        </>
      )}
      {error ? (
        <p
          role="alert"
          data-testid={`${prefix}logout-error`}
          className="px-2 text-caption text-text-1"
        >
          <span className="font-medium text-down">Error: </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Desktop top bar: icon button with a small popover (below 1024 px the same panel is in More). */
export function SessionMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative hidden desktop:block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Account menu"
        data-testid="session-menu-button"
        className="touch-target inline-flex h-9 w-9 items-center justify-center rounded-control text-text-2 hover:bg-surface-2 hover:text-text-1"
      >
        <LogOut size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <div
          data-testid="session-menu"
          className="absolute right-0 top-full z-30 mt-1 w-56 rounded-control border border-border bg-surface-2 p-2"
        >
          <SignOutPanel prefix="" />
        </div>
      ) : null}
    </div>
  );
}
