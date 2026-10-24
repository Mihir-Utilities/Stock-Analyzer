"use client";

import { useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { ApiError, apiRequest } from "@/lib/api/client";
import { safeNext } from "@/lib/safe-next";
import { FormField, inputClass } from "@/components/ui/FormField";
import { formatCount } from "@/lib/format";

/** Exact copy from docs/06 section 6.1: identical for a wrong password and a lockout. */
export const LOGIN_ERROR = "Invalid credentials or temporarily locked.";

const loginResponse = z.object({ authenticated: z.boolean(), expires_at: z.string().nullish() });

/** Pure: the message for a failed login. Never says which of wrong/locked applies. */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return LOGIN_ERROR;
    if (error.status === 429) {
      const s = error.retryAfterSeconds;
      return s === null
        ? "Too many requests. Wait a moment and try again."
        : `Too many requests. Try again in ${formatCount(s).text} s.`;
    }
    if (error.code === "TIMEOUT" || error.code === "NETWORK") {
      return "Could not reach the server. Check your connection and try again.";
    }
  }
  return "Sign-in failed because of a server problem. Try again.";
}

/** Password form (docs/06 section 6.1). No registration and no recovery link (CLI reset: RUNBOOK). */
export function LoginForm() {
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password.length === 0) {
      setError("Enter your password.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/auth/login", {
        schema: loginResponse,
        method: "POST",
        body: { password },
        skipUnauthorizedHandler: true,
      });
      // Full navigation so the new httpOnly cookie is used by the gate and caches start empty.
      const next = safeNext(new URLSearchParams(window.location.search).get("next"));
      window.location.assign(next);
    } catch (err) {
      setError(loginErrorMessage(err));
      setPassword("");
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <form
      data-testid="login-form"
      onSubmit={(e) => void submit(e)}
      noValidate
      className="mt-6 flex flex-col gap-4"
    >
      <FormField label="Password" error={error}>
        {(props) => (
          <>
            <input
              {...props}
              ref={input}
              data-testid="login-password"
              type={shown ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={200}
              className={inputClass}
            />
            <button
              type="button"
              data-testid="login-toggle"
              aria-pressed={shown}
              onClick={() => setShown((s) => !s)}
              className="h-9 touch-target shrink-0 rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3"
            >
              {shown ? "Hide" : "Show"}
            </button>
          </>
        )}
      </FormField>
      <button
        type="submit"
        data-testid="login-submit"
        disabled={busy}
        className="h-10 touch-target rounded-control border border-accent bg-accent-weak px-4 text-body font-medium text-text-1 disabled:opacity-60"
      >
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
