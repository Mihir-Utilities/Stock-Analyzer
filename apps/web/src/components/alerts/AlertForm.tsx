"use client";

import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { FormField, inputClass } from "@/components/ui/FormField";
import { useCreateAlert, usePatchAlert } from "@/lib/alerts/api";
import {
  ALERT_KINDS,
  KIND_FIELDS,
  isAlertKind,
  paramText,
  targetTypeFor,
  validateCooldown,
  validateExpiry,
  validateParams,
  validateTarget,
  type AlertKind,
} from "@/lib/alerts/kinds";
import type { AlertItem } from "@/lib/alerts/schemas";
import { thresholdMessage } from "@/lib/alerts/text";
import { alertKindLabel } from "@/lib/dashboard/labels";
import { describeError, fieldErrors, isApiError } from "@/lib/imports/errors";
import { useSingleFlight } from "@/lib/imports/single-flight";

/** Server field names (`params.price`, `target.symbol`) to the form's keys. */
function serverFields(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fieldErrors(error)) {
    const key = f.field.replace(/^params\./, "").replace(/^target\./, "");
    if (!(key in out)) out[key] = f.message;
  }
  return out;
}

const DEFAULT_KIND: AlertKind = "price_above";

/** A create form opened with a stock, a price kind and a price already filled in (all editable). */
export interface AlertPrefill {
  symbol: string;
  kind: "price_above" | "price_below";
  /** Plain decimal text, for example "1035.00". */
  price: string;
}

/**
 * Create (no `initial`) or edit (`initial`: only the parameters change, B12-3) one alert.
 * Prices are typed as text and checked with decimal arithmetic (lib/alerts/kinds.ts).
 */
export function AlertForm({
  initial,
  prefill,
  onDone,
}: {
  initial?: AlertItem;
  /** Create mode only (ALS-3): the Analysis tab shortcuts open the form with these filled in. */
  prefill?: AlertPrefill;
  onDone: (message: string) => void;
}) {
  const editing = initial !== undefined;
  const initialKind =
    initial && isAlertKind(initial.kind) ? initial.kind : (prefill?.kind ?? DEFAULT_KIND);
  const [kind, setKind] = useState<AlertKind>(initialKind);
  const [symbol, setSymbol] = useState(initial?.target.symbol ?? prefill?.symbol ?? "");
  const [code, setCode] = useState(initial?.target.code ? String(initial.target.code) : "");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const [k, val] of Object.entries(initial?.params ?? {})) v[k] = paramText(val);
    if (!initial && prefill) v["price"] = prefill.price;
    return v;
  });
  const [oneShot, setOneShot] = useState(initial?.one_shot ?? true);
  const [cooldown, setCooldown] = useState(initial ? String(initial.cooldown_minutes) : "");
  const [expiry, setExpiry] = useState(initial?.expires_on ?? "");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const once = useSingleFlight();
  const create = useCreateAlert();
  const patch = usePatchAlert();
  const active = editing ? patch : create;
  const server = serverFields(active.error);
  const thresholdText = thresholdMessage(active.error);
  const thresholdKey = kind.startsWith("nav_") ? "nav" : "price";
  const msg = (k: string): string | null =>
    local[k] ?? (k === thresholdKey && thresholdText ? thresholdText : (server[k] ?? null));

  // After a submit that shows field errors (local or from the API), focus the first invalid control.
  useEffect(() => {
    if (attempt > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt, local, active.error]);

  const setValue = (k: string, v: string) => setValues((o) => ({ ...o, [k]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    const p = validateParams(kind, values);
    Object.assign(errors, p.errors);
    let body: Record<string, unknown> | null = null;
    if (!editing) {
      const t = validateTarget(kind, { symbol, code });
      if (t.error) errors[t.error.field] = t.error.message;
      const c = validateCooldown(cooldown);
      if (c.error) errors.cooldown_minutes = c.error;
      const x = validateExpiry(expiry);
      if (x.error) errors.expires_on = x.error;
      if (Object.keys(errors).length === 0 && p.params) {
        body = { target: t.target, kind, params: p.params, one_shot: oneShot };
        if (c.value !== null) body.cooldown_minutes = c.value;
        if (x.value !== null) body.expires_on = x.value;
      }
    } else if (Object.keys(errors).length === 0 && p.params) {
      body = { params: p.params };
    }
    setLocal(errors);
    setAttempt((n) => n + 1);
    if (!body) return;
    const payload = body;
    once(async () => {
      if (initial) {
        await patch.mutateAsync({ id: initial.id, body: { params: payload.params } });
        onDone("Alert updated.");
      } else {
        await create.mutateAsync(payload);
        onDone("Alert created.");
      }
    });
  };

  const known = new Set([
    "symbol",
    "code",
    "cooldown_minutes",
    "expires_on",
    ...KIND_FIELDS[kind].map((f) => f.key),
  ]);
  const mappedServer = Object.keys(server).some((k) => known.has(k));
  const showBanner = active.error && thresholdText === null && !mappedServer;
  const firstServer = Object.values(server)[0];
  const isMf = targetTypeFor(kind) === "mf";

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      data-testid="alert-form"
      className="flex flex-col gap-3"
    >
      <FormField label="Kind" required>
        {(p) => (
          <select
            {...p}
            data-testid="alert-kind"
            className={inputClass}
            value={kind}
            disabled={editing}
            onChange={(e) => {
              if (isAlertKind(e.target.value)) {
                setKind(e.target.value);
                setValues({});
                setLocal({});
              }
            }}
          >
            {ALERT_KINDS.map((k) => (
              <option key={k} value={k}>
                {alertKindLabel(k)}
              </option>
            ))}
          </select>
        )}
      </FormField>

      {isMf ? (
        <FormField
          label="Scheme code"
          hint="The AMFI scheme code of a fund in your list, for example 120503."
          required
          error={editing ? null : msg("code")}
        >
          {(p) => (
            <input
              {...p}
              data-testid="alert-code"
              className={inputClass}
              inputMode="numeric"
              autoComplete="off"
              disabled={editing}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          )}
        </FormField>
      ) : (
        <FormField
          label="Symbol"
          hint="The exchange symbol of a stock in your list, for example TCS."
          required
          error={editing ? null : msg("symbol")}
        >
          {(p) => (
            <input
              {...p}
              data-testid="alert-symbol"
              className={inputClass}
              autoComplete="off"
              disabled={editing}
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            />
          )}
        </FormField>
      )}

      {KIND_FIELDS[kind].map((f) =>
        f.type === "enum" ? (
          <FormField key={f.key} label={f.label} hint={f.hint} required error={msg(f.key)}>
            {(p) => (
              <select
                {...p}
                data-testid={`alert-param-${f.key}`}
                className={inputClass}
                value={values[f.key] ?? ""}
                onChange={(e) => setValue(f.key, e.target.value)}
              >
                <option value="">Choose</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        ) : (
          <FormField
            key={f.key}
            label={f.label}
            hint={f.hint}
            unit={f.unit}
            required
            error={msg(f.key)}
          >
            {(p) => (
              <input
                {...p}
                data-testid={`alert-param-${f.key}`}
                className={inputClass}
                inputMode={f.type === "int" ? "numeric" : "decimal"}
                autoComplete="off"
                value={values[f.key] ?? ""}
                onChange={(e) => setValue(f.key, e.target.value)}
              />
            )}
          </FormField>
        ),
      )}
      {KIND_FIELDS[kind].length === 0 ? (
        <p className="text-body-sm text-text-2" data-testid="alert-no-params">
          This kind has no parameters.
        </p>
      ) : null}

      {!editing ? (
        <>
          <label className="touch-target flex items-center gap-2 text-body-sm text-text-1">
            <input
              type="checkbox"
              data-testid="alert-one-shot"
              checked={oneShot}
              onChange={(e) => setOneShot(e.target.checked)}
            />
            Fire once, then stop (one-shot)
          </label>
          <FormField
            label="Cooldown"
            unit="minutes"
            hint="Minutes to wait before a recurring alert can fire again. Empty means 1,440 (one day)."
            error={msg("cooldown_minutes")}
          >
            {(p) => (
              <input
                {...p}
                data-testid="alert-cooldown"
                className={inputClass}
                inputMode="numeric"
                autoComplete="off"
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="Expires on (optional)"
            hint="A date as YYYY-MM-DD, today or later (India time)."
            error={msg("expires_on")}
          >
            {(p) => (
              <input
                {...p}
                data-testid="alert-expiry"
                className={inputClass}
                placeholder="2027-03-31"
                autoComplete="off"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            )}
          </FormField>
        </>
      ) : (
        <p className="text-body-sm text-text-2">
          Only the parameters can be changed. To change the target or kind, create a new alert.
        </p>
      )}

      <p className="text-caption text-text-2">
        Alerts are checked against the last price import, not live prices.
      </p>

      {showBanner ? (
        <Banner tone="error" testId="alert-form-error">
          {isApiError(active.error, "CONFLICT")
            ? editing
              ? "This alert cannot be changed or resumed: the 200 active alert limit is reached or the alert is final. Pause or delete another alert first."
              : "You already have 200 active alerts. Pause or delete one first."
            : isApiError(active.error, "NOT_FOUND")
              ? isMf
                ? "That fund scheme was not found."
                : "That symbol was not found. Check the exchange symbol."
              : (firstServer ?? describeError(active.error))}
        </Banner>
      ) : null}

      <button
        type="submit"
        data-testid="alert-submit"
        disabled={active.isPending}
        className="touch-target h-9 self-start rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
      >
        {active.isPending ? "Saving" : editing ? "Save changes" : "Create alert"}
      </button>
    </form>
  );
}
