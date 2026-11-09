"use client";

import { useEffect, useRef, useState } from "react";
import { TelegramCard } from "@/components/alerts/TelegramCard";
import { useSignOutActions } from "@/components/shell/SessionMenu";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/overlays";
import { ApiError, apiRequest } from "@/lib/api/client";
import { PASSWORD_MAX, validatePasswordChange } from "@/lib/auth/session";
import { describeError, fieldErrors } from "@/lib/imports/errors";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { useTheme } from "@/lib/theme/use-theme";
import { z } from "zod";

const BTN =
  "touch-target h-9 rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3 disabled:opacity-50";

const okSchema = z.object({ ok: z.boolean() });

/** Change password (docs/03 section 2). Values live in state only and are cleared on success. */
function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [serverErr, setServerErr] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const once = useSingleFlight();
  const resultRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (done) resultRef.current?.focus();
  }, [done]);

  const fields = fieldErrors(serverErr);
  const serverMsg = (k: string) => fields.find((f) => f.field === k)?.message ?? null;
  const rateLimited = serverErr instanceof ApiError && serverErr.code === "RATE_LIMITED";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setDone(false);
    const v = validatePasswordChange(current, next, confirm);
    setErrors(v);
    if (v.current || v.new || v.confirm) return;
    once(async () => {
      setPending(true);
      setServerErr(null);
      try {
        await apiRequest("/auth/change-password", {
          schema: okSchema,
          method: "POST",
          body: { current, new: next },
        });
        setCurrent("");
        setNext("");
        setConfirm("");
        setDone(true);
      } catch (err) {
        setServerErr(err);
      } finally {
        setPending(false);
      }
    });
  };

  const shown = serverErr !== null && fields.length === 0;
  return (
    <Card title="Password" testId="password-card">
      <form
        onSubmit={submit}
        noValidate
        className="flex max-w-md flex-col gap-3"
        data-testid="password-form"
      >
        <FormField label="Current password" required error={errors.current ?? serverMsg("current")}>
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete="current-password"
              maxLength={PASSWORD_MAX}
              data-testid="password-current"
              className={inputClass}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="New password"
          hint="At least 12 characters, different from the current one. Other sessions are signed out."
          required
          error={errors.new ?? serverMsg("new")}
        >
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete="new-password"
              maxLength={PASSWORD_MAX}
              data-testid="password-new"
              className={inputClass}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Repeat new password" required error={errors.confirm}>
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete="new-password"
              maxLength={PASSWORD_MAX}
              data-testid="password-confirm"
              className={inputClass}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </FormField>
        {shown ? (
          <Banner tone="error" testId="password-error">
            {rateLimited
              ? `Too many wrong attempts. ${
                  serverErr instanceof ApiError && serverErr.retryAfterSeconds
                    ? `Try again in ${Math.ceil(serverErr.retryAfterSeconds / 60)} min.`
                    : "Try again later."
                }`
              : describeError(serverErr)}
          </Banner>
        ) : null}
        <button
          type="submit"
          data-testid="password-submit"
          disabled={pending}
          className="touch-target h-9 self-start rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
        >
          {pending ? "Saving" : "Change password"}
        </button>
      </form>
      <div role="status" aria-live="polite" data-testid="password-result">
        {done ? (
          <h4
            ref={resultRef}
            tabIndex={-1}
            data-testid="password-result-heading"
            className="mt-3 text-body font-semibold text-text-1 outline-none focus-visible:outline-2 focus-visible:outline-accent"
          >
            Password changed. Your other sessions were signed out.
          </h4>
        ) : null}
      </div>
    </Card>
  );
}

/** Theme is kept in this browser (docs/06a section 9); the other display preferences have no route. */
function DisplayCard() {
  const { theme, setTheme } = useTheme();
  return (
    <Card title="Display" testId="display-card">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body-sm font-medium text-text-1">Theme</legend>
        {(["dark", "light"] as const).map((t) => (
          <label key={t} className="touch-target flex items-center gap-2 text-body-sm text-text-1">
            <input
              type="radio"
              name="theme"
              data-testid={`display-theme-${t}`}
              checked={theme === t}
              onChange={() => setTheme(t)}
            />
            {t === "dark" ? "Dark" : "Light"}
          </label>
        ))}
      </fieldset>
      <p className="mt-3 text-body-sm text-text-2" data-testid="display-unavailable">
        Number format and showing experimental output are not available yet: the server has no route
        to save display preferences. The theme is saved in this browser only.
      </p>
    </Card>
  );
}

function SessionsCard() {
  const { busy, error, run } = useSignOutActions();
  const [confirmAll, setConfirmAll] = useState(false);
  return (
    <Card title="Sessions" testId="sessions-card">
      <p className="mb-3 text-body-sm text-text-2" data-testid="sessions-unavailable">
        The list of signed-in devices and revoking a single one are not available yet: the server
        has no route for them.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="settings-logout"
          disabled={busy}
          onClick={() => run(false)}
          className={BTN}
        >
          Sign out
        </button>
        <button
          type="button"
          data-testid="settings-logout-all"
          disabled={busy}
          onClick={() => setConfirmAll(true)}
          className={BTN}
        >
          Sign out everywhere
        </button>
      </div>
      {error ? (
        <div className="mt-2">
          <Banner tone="error" testId="settings-logout-error">
            {error}
          </Banner>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmAll}
        title="Sign out everywhere?"
        message="Every browser and device signed in to this app will be signed out. You will need your password again."
        confirmLabel="Sign out everywhere"
        danger
        busy={busy}
        onConfirm={() => run(true)}
        onCancel={() => setConfirmAll(false)}
      />
    </Card>
  );
}

function ExportCard() {
  return (
    <Card
      title="Export"
      testId="export-card"
      state="empty"
      message="Not available yet: the server has no export route for the watchlist, portfolio, alerts or owner data."
    />
  );
}

function AboutCard() {
  return (
    <Card title="About" testId="about-card">
      <ul className="list-disc pl-5 text-body-sm text-text-1">
        <li>
          Data sources: mutual fund NAV from AMFI via mfapi.in, and data you import or type
          yourself. Prices are not fetched from exchanges.
        </li>
        <li>Alerts go to your own Telegram bot, only when you link one.</li>
        <li>
          Safe use: enter or import only data you have the right to use. Prefer company filings and
          your own records.
        </li>
        <li>Third-party licences are listed in THIRD_PARTY_NOTICES.md in the project folder.</li>
        <li>App and data versions are not available yet: the server reports none.</li>
      </ul>
      <p className="mt-2 text-body-sm text-text-2">
        Personal research tool. Data may be delayed, incomplete or wrong. Not investment advice.
      </p>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-4" data-testid="settings-page">
      <h1 className="text-page font-semibold text-text-1">Settings</h1>
      <PasswordCard />
      <DisplayCard />
      <SessionsCard />
      <TelegramCard />
      <ExportCard />
      <AboutCard />
    </div>
  );
}
