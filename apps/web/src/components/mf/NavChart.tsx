"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ChartFrame } from "@/components/charts/ChartFrame";
import type { ChartDataset } from "@/components/charts/chart-data";
import { ApiError } from "@/lib/api/client";
import { formatDate, formatInr, formatPercent } from "@/lib/format";
import { getNav, mfKeys } from "@/lib/mf/api";
import { MF_UNIT, MF_SOURCE, NAV_RANGES } from "@/lib/mf/derive";
import type { SchemeDetail } from "@/lib/mf/schemas";
import { STALE_TIME } from "@/components/shell/Providers";
import { btn } from "./parts";

/**
 * NAV line (docs/06 section 6.9). The server downsamples to at most 2,000 points with LTTB (peaks
 * kept) and `log` only echoes the axis choice, so the log scale is applied by the chart. Jumps
 * above 25% are kept in the data and marked (MF-08).
 */
export function NavChart({ detail, asOf }: { detail: SchemeDetail; asOf: string | null }) {
  const [range, setRange] = useState<string>("1Y");
  const [log, setLog] = useState(false);
  const q = useQuery({
    queryKey: mfKeys.nav(detail.code, range),
    queryFn: () => getNav(detail.code, range),
    staleTime: STALE_TIME.mf,
    placeholderData: keepPreviousData,
  });
  const nav = q.data?.data;
  const jumps = useMemo(() => detail.nav_jumps ?? [], [detail.nav_jumps]);

  const dataset = useMemo<ChartDataset>(() => {
    const x = nav ? nav.points.map((p) => p[0]) : [];
    const markers = jumps
      .map((j) => ({
        index: x.indexOf(j.date),
        label: `NAV jump ${formatPercent(j.change_pct, { signed: true, decimals: 1 }).text}`,
      }))
      .filter((m) => m.index >= 0);
    return {
      xName: "Date",
      x,
      series: [
        {
          id: "nav",
          name: "NAV",
          unit: MF_UNIT,
          kind: "line",
          values: nav ? nav.points.map((p) => p[1]) : [],
          format: (v: number) => formatInr(v).text,
          nullReason: "no NAV",
        },
      ],
      source: MF_SOURCE,
      asOf: asOf === null ? null : formatDate(asOf).text,
      ...(nav?.downsampled ? { downsampledFrom: nav.raw_count } : {}),
      panes: [{ id: "nav", name: "NAV", unit: MF_UNIT, weight: 1 }],
      markers,
      logScale: log,
      zoom: true,
    };
  }, [nav, jumps, log, asOf]);

  const state = q.isPending
    ? "loading"
    : q.isError && !nav
      ? "error"
      : nav && nav.points.length === 0
        ? "empty"
        : "ready";
  const message =
    state === "error"
      ? q.error instanceof ApiError
        ? q.error.message
        : "The NAV history could not be loaded."
      : state === "empty"
        ? "No NAV points in this range."
        : undefined;

  return (
    <div className="flex flex-col gap-2" data-testid="mf-nav">
      <ChartFrame
        title="NAV history"
        dataset={dataset}
        state={state}
        {...(message ? { message } : {})}
        onRetry={() => void q.refetch()}
        ranges={{ options: NAV_RANGES, value: range, onChange: setRange }}
        filename={`mf-${detail.code}-nav-${range}`}
        testId="mf-nav-chart"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="mf-nav-log"
          aria-pressed={log}
          onClick={() => setLog((v) => !v)}
          className={btn}
        >
          Log scale
        </button>
      </div>
      {jumps.length > 0 ? (
        <div data-testid="mf-nav-jumps" className="text-caption text-text-2">
          NAV changes above 25% between consecutive days (kept in the data, flagged; possible split,
          merger or data error):{" "}
          {jumps
            .map(
              (j) =>
                `${formatDate(j.date).text} ${formatPercent(j.change_pct, { signed: true, decimals: 1 }).text}`,
            )
            .join(", ")}
          .
        </div>
      ) : null}
      <p className="text-caption text-text-2">
        The rolling-return band on the NAV chart is not shown: the server sends only the summary of
        rolling 1Y returns (see the card below), not the series.
      </p>
    </div>
  );
}
