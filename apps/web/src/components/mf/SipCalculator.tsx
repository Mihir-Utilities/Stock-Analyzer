"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { FormField, inputClass } from "@/components/ui/FormField";
import { InfoPopover } from "@/components/ui/overlays";
import { Stat } from "@/components/ui/Stat";
import { formatCount, formatDate, formatInr, formatPercent } from "@/lib/format";
import { describeError, fieldMessage } from "@/lib/imports/errors";
import { getSip } from "@/lib/mf/api";
import {
  MF_SOURCE,
  reasonText,
  sipGrowth,
  sipMoney,
  validateSip,
  type SipErrors,
  type SipInput,
} from "@/lib/mf/derive";
import type { SchemeDetail, SipResult } from "@/lib/mf/schemas";
import { btn } from "./parts";

const INITIAL: SipInput = { amount: "5000", start: "", end: "", day: "1" };

const SIP_INFO =
  "Monthly amount on the chosen day (1 to 28) from the start to the end date. Each installment buys at the NAV on the first date on or after the installment date (next available NAV); units = amount / NAV, with no load or duty. Value = total units x latest NAV on or before the end. XIRR uses the dated cash flows. Source: analytics spec section 9.4.";

export const LUMPSUM_REASON =
  "The server has no lumpsum endpoint and docs/06 gives no lumpsum formula, so no figure is computed here rather than showing an unspecified one (OPEN_QUESTIONS B10-9, F14-1).";

/** Lumpsum calculator (docs/06 section 6.9): honest "not available yet" with the reason. */
export function LumpsumCard() {
  return (
    <Card title="Lumpsum calculator" state="ready" testId="mf-lumpsum">
      <p data-testid="mf-lumpsum-unavailable" className="text-body-sm text-text-2">
        {"—"} Not available yet. {LUMPSUM_REASON}
      </p>
    </Card>
  );
}

function fieldErrorsFrom(error: unknown): SipErrors {
  const out: SipErrors = {};
  for (const k of ["amount", "start", "end", "day"] as const) {
    const m = fieldMessage(error, k);
    if (m) out[k] = m;
  }
  return out;
}

export function SipCalculator({ detail }: { detail: SchemeDetail }) {
  const [form, setForm] = useState<SipInput>(INITIAL);
  const [errors, setErrors] = useState<SipErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const run = useMutation({
    // `end` is optional: the API ends at the latest NAV and says so when it clamps.
    mutationFn: (v: SipInput) =>
      getSip(detail.code, v.amount.trim(), v.start, Number(v.day), v.end.trim()),
  });

  const serverErrors = run.isError ? fieldErrorsFrom(run.error) : {};
  const shown: SipErrors = { ...serverErrors, ...errors };

  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (run.isPending) return;
    const v = validateSip(form);
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    run.mutate(form);
  };
  const set = (patch: Partial<SipInput>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
  };

  const res = run.data?.data;
  const warnings = run.data?.warnings ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="mf-sip">
      <Card
        title="SIP calculator"
        info={<InfoPopover label="About the SIP calculator">{SIP_INFO}</InfoPopover>}
        testId="mf-sip-card"
      >
        <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2">
            <FormField label="Monthly amount" unit="INR" error={shown.amount ?? null} required>
              {(p) => (
                <input
                  {...p}
                  data-testid="sip-amount"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                  className={inputClass}
                />
              )}
            </FormField>
            <FormField
              label="Installment day of month"
              hint="1 to 28 (days 29 to 31 do not exist in every month)"
              error={shown.day ?? null}
              required
            >
              {(p) => (
                <input
                  {...p}
                  data-testid="sip-day"
                  inputMode="numeric"
                  value={form.day}
                  onChange={(e) => set({ day: e.target.value })}
                  className={inputClass}
                />
              )}
            </FormField>
            <FormField label="Start date" error={shown.start ?? null} required>
              {(p) => (
                <input
                  {...p}
                  type="date"
                  data-testid="sip-start"
                  min="1990-01-01"
                  value={form.start}
                  onChange={(e) => set({ start: e.target.value })}
                  className={inputClass}
                />
              )}
            </FormField>
            <FormField
              label="End date (optional)"
              hint="Empty means the latest NAV date"
              error={shown.end ?? null}
            >
              {(p) => (
                <input
                  {...p}
                  type="date"
                  data-testid="sip-end"
                  value={form.end}
                  onChange={(e) => set({ end: e.target.value })}
                  className={inputClass}
                />
              )}
            </FormField>
          </div>
          <div>
            <button type="submit" data-testid="sip-submit" disabled={run.isPending} className={btn}>
              {run.isPending ? "Calculating" : "Calculate SIP"}
            </button>
          </div>
        </form>
        {detail.option === "idcw" ? (
          <div className="mt-3">
            <Banner tone="warn" testId="sip-idcw">
              IDCW scheme: payouts are not modelled in this simulation.
            </Banner>
          </div>
        ) : null}
      </Card>

      <div aria-live="polite" data-testid="sip-live">
        {run.isError && Object.keys(fieldErrorsFrom(run.error)).length === 0 ? (
          <Banner tone="error" testId="sip-error">
            {describeError(run.error)}
          </Banner>
        ) : null}
        {res ? <SipResultView res={res} warnings={warnings} detail={detail} /> : null}
      </div>
    </div>
  );
}

function SipResultView({
  res,
  warnings,
  detail,
}: {
  res: SipResult;
  warnings: ReadonlyArray<{ code: string; message: string }>;
  detail: SchemeDetail;
}) {
  const asOf = formatDate(res.end_nav_date, { reason: "no NAV date" });
  const value = sipMoney(res.value);
  const xirr = formatPercent(res.xirr_pct, { reason: reasonText(res.xirr_reason) });
  const abs = formatPercent(res.absolute_return_pct, { reason: "no installment was executed" });
  const growth = useMemo(
    () => sipGrowth(res.schedule ?? [], res.amount, { date: res.end_nav_date, nav: res.end_nav }),
    [res],
  );
  const dataset = useMemo<ChartDataset>(() => {
    const first = growth[0];
    const lastExec = (res.schedule ?? []).length;
    const markers = [
      ...(first ? [{ index: 0, label: "First installment" }] : []),
      ...(lastExec > 1 ? [{ index: lastExec - 1, label: "Last installment" }] : []),
    ];
    return {
      xName: "Execution NAV date",
      x: growth.map((g) => g.date),
      series: [
        {
          id: "invested",
          name: "Invested",
          unit: "INR",
          kind: "area",
          dash: "dashed",
          values: growth.map((g) => g.invested),
          format: (v: number) => formatInr(v).text,
        },
        {
          id: "value",
          name: "Value",
          unit: "INR",
          kind: "area",
          values: growth.map((g) => g.value),
          format: (v: number) => formatInr(v).text,
        },
      ],
      source: MF_SOURCE,
      asOf: res.end_nav_date === null ? null : asOf.text,
      panes: [{ id: "sip", name: "Amount", unit: "INR", weight: 1 }],
      markers,
    };
  }, [growth, res, asOf.text]);

  return (
    <div className="flex flex-col gap-4" data-testid="sip-result">
      {warnings.map((w) => (
        <Banner key={w.code} tone="warn" testId={`sip-warning-${w.code}`}>
          {w.message}
        </Banner>
      ))}
      <Card
        title="SIP result"
        source={MF_SOURCE}
        asOf={res.end_nav_date === null ? null : asOf.text}
        testId="sip-result-card"
      >
        <div className="grid grid-cols-2 gap-4 tablet:grid-cols-3">
          <Stat label="Invested" value={formatInr(Number(res.invested)).text} />
          <Stat
            label="Value at end"
            value={value}
            nullReason="no installment could be executed in this period"
          />
          <Stat
            label="Absolute return"
            value={res.absolute_return_pct === null ? null : abs.text}
            nullReason={abs.reason ?? "not available"}
          />
          <Stat
            label="XIRR"
            value={res.xirr_pct === null ? null : xirr.text}
            nullReason={xirr.reason ?? "not available"}
          />
          <Stat label="Installments executed" value={formatCount(res.installments).text} />
          <Stat label="Installments skipped" value={formatCount(res.skipped_installments).text} />
        </div>
        <p data-testid="sip-skipped-note" className="mt-2 text-caption text-text-2">
          Skipped installments fall before the first NAV, or have no NAV to execute at on or before
          the end date. {detail.option === "idcw" ? "Payouts are not modelled." : ""}
        </p>
      </Card>
      {growth.length > 0 ? (
        <ChartFrame
          title="SIP growth"
          dataset={dataset}
          filename={`mf-${res.code}-sip`}
          testId="mf-sip-chart"
        />
      ) : null}
      <p className="text-caption text-text-2">
        Value over time is each installment&apos;s accumulated units at that installment&apos;s own
        NAV (an illustration of the path); the last point uses the end NAV.
      </p>
    </div>
  );
}
