"use client";

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { MetricValue, StampView, BTN } from "@/components/screener/parts";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField, inputClass } from "@/components/ui/FormField";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import { describeError } from "@/lib/dashboard/state";
import { fieldErrors } from "@/lib/imports/errors";
import { formatDate, formatNumber } from "@/lib/format";
import { getCompare, screenerKeys } from "@/lib/screener/api";
import {
  BEST_HEURISTIC_NOTE,
  COMPARE_RANGES,
  MAX_COMPARE,
  MIN_COMPARE,
  parseRange,
  parseSymbols,
} from "@/lib/screener/compare";
import { formatMetric, reasonWords } from "@/lib/screener/display";
import { metricHeader } from "@/lib/screener/metrics";
import type { CompareResult } from "@/lib/screener/schemas";

const COMPARE_SOURCE = "Imported prices (adj_close) and the analytics run";
const DASHES = ["solid", "dashed", "dotted", "solid", "dashed"] as const;

function RebasedChart({ r }: { r: CompareResult }) {
  const dataset = useMemo<ChartDataset>(() => {
    const base = formatDate(r.rebased.base_date).text;
    return {
      xName: "Date",
      x: r.rebased.dates,
      series: r.symbols.flatMap((s, i) => {
        const values = r.rebased.series[s.symbol];
        if (!values) return [];
        return [
          {
            id: `s${i}`,
            name: s.symbol,
            unit: `index, 100 = ${base}`,
            kind: "line" as const,
            colorIndex: i,
            dash: DASHES[i % DASHES.length],
            values,
            format: (v: number) => formatNumber(v, { decimals: 1 }).text,
            nullReason: "no price on this date",
          },
        ];
      }),
      source: COMPARE_SOURCE,
      asOf: formatDate(r.rebased.dates[r.rebased.dates.length - 1] ?? null).text,
      zoom: true,
      panes: [{ id: "cmp", name: "Rebased price", unit: `index (100 = ${base})`, weight: 1 }],
    };
  }, [r]);
  return (
    <ChartFrame
      title="Rebased price (adjusted close)"
      dataset={dataset}
      filename="compare"
      testId="compare-chart"
    />
  );
}

function MetricsTable({ r }: { r: CompareResult }) {
  const keys = Object.keys(r.metrics[r.symbols[0]?.symbol ?? ""] ?? {});
  return (
    <Card title="Metrics" source="Analytics run (screener row)" testId="compare-metrics-card">
      <div
        className="relative overflow-x-auto"
        role="region"
        tabIndex={0}
        aria-label="Compared metrics, scrollable table"
        data-testid="compare-table-scroll"
      >
        <table
          className="w-full min-w-max border-collapse text-body-sm"
          data-testid="compare-table"
        >
          <caption className="sr-only">Compared metrics</caption>
          <thead>
            <tr className="border-b border-border align-top">
              <th scope="col" className="px-2 py-1 text-left text-caption font-medium text-text-2">
                Metric
              </th>
              {r.symbols.map((s) => (
                <th
                  key={s.symbol}
                  scope="col"
                  data-testid={`compare-col-${s.symbol}`}
                  data-stale={s.stale}
                  className={`px-2 py-1 text-left font-normal ${s.stale ? "border-l-4 border-l-warn bg-surface-2" : ""}`}
                >
                  <div className="flex flex-col gap-1">
                    <Link
                      href={`/stocks/${encodeURIComponent(s.symbol)}`}
                      data-testid={`compare-link-${s.symbol}`}
                      className="touch-target inline-flex items-center font-medium text-accent underline"
                    >
                      {s.symbol}
                    </Link>
                    <span className="text-caption text-text-2">{s.name}</span>
                    {s.short_history ? (
                      <span
                        data-testid={`compare-short-${s.symbol}`}
                        className="w-fit rounded-chip border border-warn bg-surface-2 px-1.5 py-0.5 text-micro text-text-1"
                      >
                        Short history: {s.bars} price {s.bars === 1 ? "day" : "days"}
                        {s.prices_reason ? `, ${reasonWords(s.prices_reason)}` : ""}
                      </span>
                    ) : null}
                    <StampView stamp={s} testId={`compare-stamp-${s.symbol}`} />
                    <span className="text-micro text-text-2">
                      Metrics as of {formatDate(s.metrics_as_of).text}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} data-testid={`compare-row-${k}`} className="border-b border-border">
                <th scope="row" className="px-2 py-1 text-left font-normal text-text-1">
                  {metricHeader(k, r.units)}
                </th>
                {r.symbols.map((s) => {
                  const f = formatMetric(
                    k,
                    r.metrics[s.symbol]?.[k],
                    r.metric_reasons?.[s.symbol]?.[k],
                    r.units[k],
                  );
                  const best = r.best[k] === s.symbol;
                  return (
                    <td
                      key={s.symbol}
                      data-testid={`compare-cell-${s.symbol}-${k}`}
                      data-best={best}
                      className={`whitespace-nowrap px-2 py-1 tabular-nums text-text-1 ${best ? "font-semibold underline decoration-2 underline-offset-4" : ""}`}
                    >
                      <MetricValue f={f} />
                      {best ? (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-chip border border-border px-1.5 text-micro font-medium">
                          <Check size={12} strokeWidth={2} aria-hidden="true" />
                          Best
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-caption text-text-2" data-testid="compare-best-note">
        {BEST_HEURISTIC_NOTE}
      </p>
    </Card>
  );
}

export function compareErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) {
    return "One of these symbols is not a known stock. Check the symbols and try again.";
  }
  if (e instanceof ApiError && e.status === 422) {
    const f = fieldErrors(e)[0];
    return f ? `The comparison was not accepted: ${f.field} ${f.message}.` : e.message;
  }
  return describeError(e, "The comparison").message;
}

export function ComparePage() {
  const router = useRouter();
  const params = useSearchParams();
  const rawSymbols = params.get("symbols") ?? "";
  const range = parseRange(params.get("range"));
  const parsed = parseSymbols(rawSymbols);
  const [text, setText] = useState(rawSymbols);
  const [formError, setFormError] = useState<string | null>(null);
  // Back/forward or a link changes the URL: the text box follows it.
  const [seenRaw, setSeenRaw] = useState(rawSymbols);
  if (seenRaw !== rawSymbols) {
    setSeenRaw(rawSymbols);
    setText(rawSymbols);
    setFormError(null);
  }

  const symbols = parsed.ok ? parsed.symbols : [];
  const key = symbols.join(",");
  const q = useQuery({
    queryKey: screenerKeys.compare(key, range),
    queryFn: ({ signal }) => getCompare(symbols, range, signal),
    enabled: parsed.ok,
    staleTime: STALE_TIME.analysis,
    retry: false,
  });

  const go = (syms: string, r: string) =>
    router.push(`/compare?symbols=${encodeURIComponent(syms)}&range=${encodeURIComponent(r)}`);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseSymbols(text);
    if (!p.ok) {
      setFormError(p.error);
      return;
    }
    setFormError(null);
    go(p.symbols.join(","), range);
  };

  const r = q.data?.data;
  const anyStale = r?.symbols.some((s) => s.stale) ?? false;
  const noCommon = r !== undefined && r.rebased.dates.length === 0;
  const failureId = q.error instanceof ApiError ? q.error.requestId : null;

  return (
    <div className="flex flex-col gap-4" data-testid="compare-page">
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold text-text-1" data-testid="compare-title">
          Compare stocks
        </h1>
        <p className="text-body-sm text-text-2">
          {MIN_COMPARE} to {MAX_COMPARE} stocks, rebased to 100 on the first date they all have a
          price. Returns exclude dividends.{" "}
          <Link
            href="/stocks"
            data-testid="compare-browse"
            className="touch-target inline-flex items-center text-accent underline"
          >
            Find symbols
          </Link>
        </p>
      </header>

      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
      >
        <FormField
          label="Symbols"
          hint="Comma separated, 2 to 5 different symbols, for example TCS, INFY, M&M"
          error={formError}
        >
          {(p) => (
            <input
              {...p}
              data-testid="compare-symbols"
              value={text}
              maxLength={200}
              onChange={(e) => setText(e.target.value)}
              className={inputClass}
            />
          )}
        </FormField>
        <div>
          <button type="submit" data-testid="compare-submit" className={BTN}>
            Compare
          </button>
        </div>
      </form>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Range">
        {COMPARE_RANGES.map((x) => (
          <button
            key={x}
            type="button"
            data-testid={`compare-range-${x}`}
            aria-pressed={x === range}
            disabled={!parsed.ok}
            aria-describedby={!parsed.ok ? "compare-range-disabled" : undefined}
            onClick={() => go(key, x)}
            className={`${BTN} aria-pressed:border-accent aria-pressed:font-semibold`}
          >
            {x}
          </button>
        ))}
      </div>
      {!parsed.ok ? (
        <p id="compare-range-disabled" className="text-caption text-text-2">
          The range buttons work after you enter 2 to 5 valid symbols.
        </p>
      ) : null}

      <div aria-live="polite" data-testid="compare-live" className="flex flex-col gap-4">
        {rawSymbols === "" ? (
          <EmptyState message="Enter 2 to 5 stock symbols to compare them." />
        ) : !parsed.ok ? (
          <Banner tone="warn" testId="compare-invalid">
            {parsed.error}
          </Banner>
        ) : q.isPending ? (
          <div aria-busy="true">
            <Skeleton className="h-64 w-full" label="Loading comparison" />
          </div>
        ) : q.isError ? (
          <div className="flex flex-col items-start gap-2">
            <Banner tone="error" testId="compare-error">
              {compareErrorText(q.error)}
              {failureId ? ` Request id: ${failureId}.` : ""}
            </Banner>
            <button
              type="button"
              data-testid="compare-retry"
              onClick={() => void q.refetch()}
              className={BTN}
            >
              Retry
            </button>
          </div>
        ) : r ? (
          <div className="flex flex-col gap-4" data-testid="compare-result">
            {anyStale ? (
              <Banner tone="warn" testId="compare-stale">
                At least one stock has stale owner data. The stamp under its symbol says why.
              </Banner>
            ) : null}
            {noCommon ? (
              <Banner tone="info" testId="compare-no-common-dates">
                No chart: {reasonWords(r.rebased.reason, "there is no common trading date")}. The
                metrics table below still applies.
              </Banner>
            ) : (
              <RebasedChart r={r} />
            )}
            <MetricsTable r={r} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
