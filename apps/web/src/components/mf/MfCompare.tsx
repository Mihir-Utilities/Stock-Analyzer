"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField, inputClass } from "@/components/ui/FormField";
import { heatColor } from "@/components/ui/Heatmap";
import { Skeleton } from "@/components/ui/Skeleton";
import { STALE_TIME } from "@/components/shell/Providers";
import { ApiError } from "@/lib/api/client";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";
import { getCompare, mfKeys } from "@/lib/mf/api";
import { COMPARE_RANGES, MF_SOURCE, reasonText } from "@/lib/mf/derive";
import { parseCodes } from "@/lib/mf/compare";
import type { CompareResult } from "@/lib/mf/schemas";
import { btn, MfNotice } from "./parts";

export const SCATTER_UNAVAILABLE_REASON =
  "The chart frame has no scatter chart yet (OPEN_QUESTIONS F14-3). The table lists the same return, volatility and drawdown figures.";

export function compareErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 422 && e.details?.["reason"] === "no_common_dates") {
      return "These funds have no NAV date in common for this range. Try a longer range or different funds.";
    }
    return e.message;
  }
  return "The comparison could not be loaded.";
}

function ChartView({ r }: { r: CompareResult }) {
  const dataset = useMemo<ChartDataset>(() => {
    const x = r.series[0]?.points.map((p) => p[0]) ?? [];
    return {
      xName: "Date",
      x,
      series: r.series.map((s, i) => {
        const byDate = new Map(s.points);
        return {
          id: `s${s.code}`,
          name: `${s.name.length > 24 ? `${s.name.slice(0, 23)}…` : s.name} (${s.code})`,
          unit: `index, 100 = ${formatDate(r.common_start).text}`,
          kind: "line" as const,
          colorIndex: i,
          values: x.map((d) => byDate.get(d) ?? null),
          format: (v: number) => formatNumber(v, { decimals: 1 }).text,
          nullReason: "no NAV on this date",
        };
      }),
      source: MF_SOURCE,
      asOf: formatDate(r.common_end).text,
      zoom: true,
      panes: [
        { id: "cmp", name: "Rebased NAV", unit: `index (100 = ${r.common_start})`, weight: 1 },
      ],
    };
  }, [r]);
  return (
    <ChartFrame
      title="Rebased NAV"
      dataset={dataset}
      filename="mf-compare"
      testId="mf-compare-chart"
    />
  );
}

function TableView({ r }: { r: CompareResult }) {
  const rets = r.table.map((t) => t.return_pct).filter((v): v is number => v !== null);
  const maxAbs = Math.max(1, ...rets.map((v) => Math.abs(v)));
  return (
    <Card
      title="Returns, volatility and drawdown"
      source={MF_SOURCE}
      asOf={formatDate(r.common_end).text}
      testId="mf-compare-table-card"
    >
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Comparison table, scrollable"
      >
        <table
          aria-label="Comparison"
          data-testid="mf-compare-table"
          className="w-full min-w-[34rem]"
        >
          <thead>
            <tr className="text-left text-caption text-text-2">
              <th scope="col" className="px-2 py-1 font-medium">
                Fund
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium">
                Return (percent)
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium">
                Volatility (percent a year)
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium">
                Max drawdown (percent)
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                First NAV
              </th>
            </tr>
          </thead>
          <tbody>
            {r.table.map((t) => {
              const ret = formatPercent(t.return_pct, {
                signed: true,
                reason: "not enough history",
              });
              const vol = formatPercent(t.volatility_pct, {
                reason: reasonText(t.volatility_reason),
              });
              const dd = formatPercent(t.max_drawdown_pct, { reason: "not enough history" });
              return (
                <tr
                  key={t.code}
                  data-testid={`mf-compare-row-${t.code}`}
                  className="border-t border-border align-top"
                >
                  <th scope="row" className="px-2 py-1 text-left text-body-sm font-normal">
                    <Link
                      href={`/mf/${t.code}`}
                      data-testid={`mf-compare-fund-${t.code}`}
                      className="touch-target inline-flex items-center text-accent underline"
                    >
                      {t.name}
                    </Link>
                    {t.history_shorter_than_range ? (
                      <span className="block text-micro text-text-2">
                        history shorter than the range
                      </span>
                    ) : null}
                  </th>
                  <td
                    className="num px-2 py-1 text-right text-text-1"
                    title={ret.reason ?? undefined}
                    style={{ backgroundColor: heatColor(t.return_pct, maxAbs) }}
                  >
                    {ret.text}
                    <span className="block text-micro text-text-1">
                      {t.return_pct === null
                        ? ret.reason
                        : t.return_basis === "cagr"
                          ? "CAGR"
                          : "Absolute"}
                    </span>
                  </td>
                  <td className="num px-2 py-1 text-right" title={vol.reason ?? undefined}>
                    {vol.text}
                    {t.volatility_pct === null ? (
                      <span className="block text-micro text-text-2">{vol.reason}</span>
                    ) : null}
                  </td>
                  <td className="num px-2 py-1 text-right" title={dd.reason ?? undefined}>
                    {dd.text}
                  </td>
                  <td className="px-2 py-1 text-caption text-text-2">
                    {formatDate(t.first_nav_date).text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-caption text-text-2">
        Figures cover the common period {formatDate(r.common_start).text} to{" "}
        {formatDate(r.common_end).text}. Cell tint shows the size of the return; the value is always
        printed.
      </p>
    </Card>
  );
}

export function MfCompare() {
  const router = useRouter();
  const params = useSearchParams();
  const rawCodes = params.get("codes") ?? "";
  const range = COMPARE_RANGES.includes(params.get("range") as (typeof COMPARE_RANGES)[number])
    ? (params.get("range") as string)
    : "3Y";
  const parsed = parseCodes(rawCodes);
  const [text, setText] = useState(rawCodes);
  const [formError, setFormError] = useState<string | null>(null);

  const ready = parsed.ok;
  const key = parsed.ok ? parsed.codes.join(",") : "";
  const q = useQuery({
    queryKey: mfKeys.compare(key, range),
    queryFn: () => getCompare(key, range),
    enabled: ready,
    staleTime: STALE_TIME.mf,
    retry: false,
  });

  const go = (codes: string, r: string) =>
    router.push(`/mf/compare?codes=${encodeURIComponent(codes)}&range=${r}`);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseCodes(text);
    if (!p.ok) {
      setFormError(p.error);
      return;
    }
    setFormError(null);
    go(p.codes.join(","), range);
  };

  const result = q.data?.data;
  const stale = q.data?.meta?.stale === true;

  return (
    <div className="flex flex-col gap-4" data-testid="mf-compare-page">
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold text-text-1">Compare funds</h1>
        <p className="text-body-sm text-text-2">
          2 to 5 schemes, rebased to 100 at the first date they all have a NAV.{" "}
          <Link
            href="/mf"
            data-testid="mf-compare-browse"
            className="touch-target inline-flex items-center text-accent underline"
          >
            Find scheme codes
          </Link>
        </p>
      </header>
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
      >
        <FormField
          label="Scheme codes"
          hint="Comma separated, 2 to 5 different codes, for example 120503,118989"
          error={formError}
        >
          {(p) => (
            <input
              {...p}
              data-testid="mf-compare-codes"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className={inputClass}
            />
          )}
        </FormField>
        <div>
          <button type="submit" data-testid="mf-compare-submit" className={btn}>
            Compare
          </button>
        </div>
      </form>

      <div aria-live="polite" data-testid="mf-compare-live">
        {!ready && rawCodes === "" ? (
          <EmptyState message="Enter 2 to 5 scheme codes, or select funds on the funds list, to compare them." />
        ) : !parsed.ok && /^\s*\d{1,10}\s*,?\s*$/.test(rawCodes) ? (
          <Banner tone="info" testId="mf-compare-one">
            Scheme {rawCodes.replace(/[^0-9]/g, "")} is ready. Add 1 to 4 more scheme codes above to
            compare.
          </Banner>
        ) : !parsed.ok ? (
          <Banner tone="warn" testId="mf-compare-invalid">
            {parsed.error}
          </Banner>
        ) : q.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-64 w-full" label="Loading comparison" />
          </div>
        ) : q.isError ? (
          <div className="flex flex-col items-start gap-2">
            <Banner tone="error" testId="mf-compare-error">
              {compareErrorText(q.error)}
            </Banner>
            <button
              type="button"
              data-testid="mf-compare-retry"
              onClick={() => void q.refetch()}
              className={btn}
            >
              Retry
            </button>
          </div>
        ) : result ? (
          <div className="flex flex-col gap-4" data-testid="mf-compare-result">
            {stale ? (
              <Banner tone="warn" testId="mf-compare-stale">
                At least one NAV is more than 4 days old.
              </Banner>
            ) : null}
            {result.different_starts ? (
              <Banner tone="info" testId="mf-compare-different-starts">
                These funds start on different dates. Everything is rebased at the first common
                date, {formatDate(result.common_start).text}, so older history is not shown.
              </Banner>
            ) : null}
            <ChartView r={result} />
            <TableView r={result} />
            <Card title="Risk-return scatter" testId="mf-compare-scatter">
              <p className="text-body-sm text-text-2" data-testid="mf-compare-scatter-unavailable">
                {"—"} Not available yet. {SCATTER_UNAVAILABLE_REASON}
              </p>
            </Card>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Range">
        {COMPARE_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            data-testid={`mf-compare-range-${r}`}
            aria-pressed={r === range}
            disabled={!ready}
            onClick={() => go(key, r)}
            className={`${btn} aria-pressed:border-accent`}
          >
            {r}
          </button>
        ))}
      </div>
      <MfNotice />
    </div>
  );
}
