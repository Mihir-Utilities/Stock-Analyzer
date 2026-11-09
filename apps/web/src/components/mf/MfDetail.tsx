"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Star } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/EmptyState";
import { Heatmap, type HeatCell } from "@/components/ui/Heatmap";
import { InfoPopover, ToastProvider, useToast } from "@/components/ui/overlays";
import { RangeBar } from "@/components/ui/RangeBar";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { AsOfChip, SourceChip } from "@/components/ui/chips";
import { STALE_TIME } from "@/components/shell/Providers";
import { ApiError } from "@/lib/api/client";
import { formatDate, formatInr, formatNumber, formatPercent } from "@/lib/format";
import { describeError } from "@/lib/imports/errors";
import { addMfWatch, getMfWatchId, getScheme, mfKeys, removeMfWatch } from "@/lib/mf/api";
import {
  MF_SOURCE,
  MF_UNIT,
  planOptionLabels,
  reasonText,
  returnRows,
  warningText,
} from "@/lib/mf/derive";
import { MF_REFRESH_COPY, runMfRefresh } from "@/lib/mf/refresh";
import type { SchemeDetail } from "@/lib/mf/schemas";
import { rateLimitedCopy, type RefreshOutcome } from "@/lib/stock/refresh";
import { NavChart } from "./NavChart";
import { btn, linkBtn, MfChip, MfNotice } from "./parts";
import { LumpsumCard, SipCalculator } from "./SipCalculator";

const RETURNS_INFO =
  "Windows 1M, 3M and 6M are absolute returns (end NAV / start NAV - 1); 1Y and longer are CAGR using the actual number of days between the NAV dates. The start is the NAV on or before end minus the window; with no NAV that early the value is unknown. Returns use NAV only, so IDCW payouts are excluded. Source: analytics spec section 9.2.";
const RISK_INFO =
  "Volatility = standard deviation of daily log NAV changes x sqrt(252), over 3 years (or the full history if shorter but at least 1 year); unknown for weekly-NAV schemes. Max drawdown is the largest peak-to-trough fall of the NAV. Sharpe-like uses the risk-free rate shown. Source: analytics spec section 9.3.";

function useWatchStar(code: number) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = mfKeys.watch(code);
  const idQ = useQuery({ queryKey: key, queryFn: () => getMfWatchId(code) });
  const id = idQ.data ?? null;
  const toggle = useMutation({
    mutationFn: async () => {
      if (id === null) await addMfWatch(code);
      else await removeMfWatch(id);
    },
    onSuccess: () => {
      toast(id === null ? "Fund added to the watchlist." : "Fund removed from the watchlist.");
      void qc.invalidateQueries({ queryKey: ["watchlist"] });
    },
    onError: (e) => toast(describeError(e), "error"),
  });
  return {
    on: id !== null,
    pending: idQ.isPending || toggle.isPending,
    toggle: () => toggle.mutate(),
  };
}

function StarButton({ code }: { code: number }) {
  const s = useWatchStar(code);
  return (
    <button
      type="button"
      data-testid="mf-watchlist"
      aria-pressed={s.on}
      disabled={s.pending}
      onClick={s.toggle}
      className={btn}
    >
      <Star
        size={16}
        strokeWidth={1.75}
        aria-hidden="true"
        className={cx(s.on && "fill-current")}
      />
      Watchlist
    </button>
  );
}

function RefreshButton({ code, onDone }: { code: number; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RefreshOutcome | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const go = async () => {
    if (busy) return; // single flight
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setOutcome(null);
    const o = await runMfRefresh(code, ctl.signal);
    if (ctl.signal.aborted) return;
    setBusy(false);
    setOutcome(o);
    if (o.kind === "ok") {
      toast(MF_REFRESH_COPY.done);
      onDone();
    }
  };
  let note: string | null = null;
  if (busy) note = MF_REFRESH_COPY.working;
  else if (outcome?.kind === "rate_limited") note = rateLimitedCopy(outcome.minutes);
  else if (outcome?.kind === "timeout") note = MF_REFRESH_COPY.timeout;
  else if (outcome?.kind === "failed") note = outcome.message;
  return (
    <>
      <button
        type="button"
        data-testid="mf-refresh"
        disabled={busy}
        onClick={() => void go()}
        className={btn}
      >
        <RefreshCw
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className={cx(busy && "animate-spin")}
        />
        Refresh
      </button>
      <span aria-live="polite" data-testid="mf-refresh-note" className="text-caption text-text-2">
        {note}
      </span>
    </>
  );
}

interface Suggestion {
  code: number;
  name: string;
}

function suggestionsOf(e: ApiError): Suggestion[] {
  const raw = e.details?.["suggestions"];
  if (!Array.isArray(raw)) return [];
  const out: Suggestion[] = [];
  for (const s of raw) {
    if (typeof s === "object" && s !== null) {
      const r = s as Record<string, unknown>;
      if (typeof r["code"] === "number" && typeof r["name"] === "string") {
        out.push({ code: r["code"], name: r["name"] });
      }
    }
  }
  return out;
}

/** MF-13: a wrong scheme code is a 404 with suggestions. */
function NotFound({ code, error }: { code: string; error: ApiError }) {
  const sug = suggestionsOf(error);
  return (
    <div data-testid="mf-not-found" className="flex flex-col gap-3">
      <EmptyState
        message={`No fund with the scheme code ${code}. Check the code or search by name.`}
        action={
          <Link href="/mf" data-testid="mf-browse-link" className={linkBtn}>
            Search funds
          </Link>
        }
      />
      {sug.length > 0 ? (
        <section
          aria-label="Suggestions"
          data-testid="mf-suggestions"
          className="flex flex-col gap-1"
        >
          <h2 className="text-lead font-semibold">Did you mean</h2>
          <ul className="flex flex-col">
            {sug.map((s) => (
              <li key={s.code}>
                <Link
                  href={`/mf/${s.code}`}
                  data-testid={`mf-suggestion-${s.code}`}
                  className="touch-target inline-flex items-center text-body-sm text-accent underline"
                >
                  {s.name} ({s.code})
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Header({
  d,
  asOf,
  stale,
  onRefreshed,
}: {
  d: SchemeDetail;
  asOf: string | null;
  stale: boolean;
  onRefreshed: () => void;
}) {
  const [plan, option] = planOptionLabels(d);
  const nav = d.latest_nav;
  const navText = formatInr(nav?.value ?? null, { reason: "no NAV data yet" });
  const date = formatDate(nav?.date ?? null, { reason: "no NAV date" });
  return (
    <header className="flex flex-col gap-2" data-testid="mf-header">
      <h1 className="text-title font-semibold text-text-1" data-testid="mf-name">
        {d.name}
      </h1>
      <div className="flex flex-wrap items-center gap-2 text-body-sm text-text-2">
        <span data-testid="mf-house">{d.fund_house ?? "fund house not known"}</span>
        <span aria-hidden="true">|</span>
        <span data-testid="mf-cat">{d.category ?? "category not known"}</span>
        <MfChip testId="mf-plan-chip">{plan}</MfChip>
        <MfChip testId="mf-option-chip" tone={d.option === "idcw" ? "warn" : "neutral"}>
          {option}
        </MfChip>
        {d.status === "inactive" ? (
          <MfChip testId="mf-inactive-chip" tone="warn">
            Inactive
          </MfChip>
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span data-testid="mf-nav-value" className="num text-section font-semibold text-text-1">
          {navText.text}
        </span>
        <span data-testid="mf-nav-meta" className="text-caption text-text-2">
          {nav ? `${MF_UNIT}, NAV of ${date.text}` : `NAV: ${navText.reason}`}
        </span>
        <SourceChip source={MF_SOURCE} />
        <AsOfChip asOf={asOf === null ? null : formatDate(asOf).text} stale={stale} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StarButton code={d.code} />
        <RefreshButton code={d.code} onDone={onRefreshed} />
        <Link
          href={`/mf/compare?codes=${d.code}`}
          data-testid="mf-compare-link"
          className={linkBtn}
        >
          Compare
        </Link>
      </div>
    </header>
  );
}

function ReturnsCard({ d }: { d: SchemeDetail }) {
  const rows = returnRows(d);
  const known = rows.filter((r) => r.value !== null);
  const maxAbs = Math.max(1, ...known.map((r) => Math.abs(r.value ?? 0)));
  const cells: HeatCell[][] = [
    rows.map((r) => ({
      value: r.value,
      text: r.value === null ? null : formatPercent(r.value, { signed: true }).text,
    })),
  ];
  const asOf = d.metrics_as_of ?? d.latest_nav?.date ?? null;
  if (d.nav_count === 0) {
    return (
      <Card
        title="Returns"
        state="empty"
        message="No NAV data yet, so no returns. They appear after the first NAV refresh."
        testId="mf-returns"
      />
    );
  }
  return (
    <Card
      title="Returns"
      info={<InfoPopover label="About returns">{RETURNS_INFO}</InfoPopover>}
      source={MF_SOURCE}
      asOf={asOf === null ? null : formatDate(asOf).text}
      testId="mf-returns"
    >
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Returns table, scrollable"
      >
        <table
          aria-label="Returns by window"
          data-testid="mf-returns-table"
          className="w-full min-w-[22rem]"
        >
          <thead>
            <tr className="text-left text-caption text-text-2">
              <th scope="col" className="px-2 py-1 font-medium">
                Window
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium">
                Return (percent)
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                Basis
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const f = formatPercent(r.value, { signed: true, reason: r.reason ?? "no data" });
              return (
                <tr
                  key={r.key}
                  data-testid={`mf-return-${r.key}`}
                  className="border-t border-border"
                >
                  <th scope="row" className="px-2 py-1 text-left text-body-sm font-normal">
                    {r.label}
                  </th>
                  <td className="num px-2 py-1 text-right" title={f.reason ?? undefined}>
                    {f.text}
                    {r.value === null ? (
                      <span className="block text-micro text-text-2">{f.reason}</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1 text-caption text-text-2">
                    {r.value === null ? "" : (r.basis ?? "")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3">
        <Heatmap
          label="Returns heatmap by window"
          rows={["Return"]}
          columns={rows.map((r) => r.label)}
          cells={cells}
          maxAbs={maxAbs}
          legend={{
            negative: formatPercent(-maxAbs).text,
            positive: formatPercent(maxAbs, { signed: true }).text,
          }}
          nullReason="History is shorter than the window, or no NAV yet"
        />
      </div>
    </Card>
  );
}

function RiskCard({ d }: { d: SchemeDetail }) {
  const r = d.risk;
  if (!r) {
    return (
      <Card
        title="Risk"
        state="empty"
        message="Risk figures are not computed yet (no NAV history or metrics pending)."
        testId="mf-risk"
      />
    );
  }
  const vol = formatPercent(r.volatility_pct, { reason: reasonText(r.volatility_reason) });
  const dd = formatPercent(r.max_drawdown_pct, { reason: "history too short" });
  const sh = formatNumber(r.sharpe_like, { reason: reasonText(r.sharpe_reason) });
  const rf = formatPercent(r.risk_free_rate, { reason: "not available" });
  const yrs = formatNumber(r.volatility_years, { decimals: 1 });
  const asOf = d.metrics_as_of ?? null;
  return (
    <Card
      title="Risk"
      info={<InfoPopover label="About risk">{RISK_INFO}</InfoPopover>}
      source={MF_SOURCE}
      asOf={asOf === null ? null : formatDate(asOf).text}
      testId="mf-risk"
    >
      <div className="grid grid-cols-2 gap-4 tablet:grid-cols-4">
        <Stat
          label="Volatility (annualised)"
          value={r.volatility_pct === null ? null : vol.text}
          nullReason={vol.reason ?? "not available"}
        />
        <Stat
          label="Max drawdown"
          value={r.max_drawdown_pct === null ? null : dd.text}
          nullReason={dd.reason ?? "not available"}
        />
        <Stat
          label="Sharpe-like"
          value={r.sharpe_like === null ? null : sh.text}
          nullReason={sh.reason ?? "not available"}
        />
        <Stat
          label="Risk-free rate used"
          value={r.risk_free_rate === null ? null : rf.text}
          nullReason={rf.reason ?? "not available"}
        />
      </div>
      {r.volatility_years !== null ? (
        <p className="mt-2 text-caption text-text-2">Volatility window: {yrs.text} years.</p>
      ) : null}
    </Card>
  );
}

function RollingCard({ d }: { d: SchemeDetail }) {
  const r = d.rolling_1y;
  if (!r) {
    return (
      <Card
        title="Rolling 1Y returns"
        state="empty"
        message="Needs at least one year of NAV history."
        testId="mf-rolling"
      />
    );
  }
  const min = formatPercent(r.min, { signed: true });
  const med = formatPercent(r.median, { signed: true });
  const max = formatPercent(r.max, { signed: true });
  const pos = formatPercent(r.pct_positive, { decimals: 1 });
  return (
    <Card
      title="Rolling 1Y returns"
      source={MF_SOURCE}
      asOf={d.metrics_as_of ? formatDate(d.metrics_as_of).text : null}
      testId="mf-rolling"
    >
      <RangeBar
        label="Range of rolling 1Y returns (CAGR, percent)"
        low={r.min}
        high={r.max}
        value={r.median}
        lowText={min.text}
        highText={max.text}
        valueText={`Median ${med.text}`}
      />
      <div className="mt-3 grid grid-cols-2 gap-4 tablet:grid-cols-4">
        <Stat label="Worst window" value={r.min === null ? null : min.text} nullReason="no data" />
        <Stat label="Median" value={r.median === null ? null : med.text} nullReason="no data" />
        <Stat label="Best window" value={r.max === null ? null : max.text} nullReason="no data" />
        <Stat
          label="Windows with a positive return"
          value={r.pct_positive === null ? null : pos.text}
          nullReason="no data"
        />
      </div>
      <p className="mt-2 text-caption text-text-2">
        Based on {formatNumber(r.count, { decimals: 0 }).text} rolling 1-year windows. Past returns
        do not predict future returns.
      </p>
    </Card>
  );
}

export const SERIES_UNAVAILABLE_REASON =
  "The server sends only the summary of rolling 1Y returns, not the series, and no calendar-year returns. The NAV points are downsampled, so computing them here would not be exact (OPEN_QUESTIONS F14-2).";

function UnavailableViews() {
  return (
    <Card title="Calendar-year returns and rolling-return histogram" testId="mf-series-unavailable">
      <p className="text-body-sm text-text-2" data-testid="mf-series-unavailable-text">
        {"—"} Not available yet. {SERIES_UNAVAILABLE_REASON}
      </p>
    </Card>
  );
}

function Inner({ code }: { code: number }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: mfKeys.detail(code),
    queryFn: () => getScheme(code),
    staleTime: STALE_TIME.mf,
    refetchInterval: (query) => {
      const b = query.state.data?.data.backfill;
      return b && (b.status === "queued" || b.status === "running") ? 5_000 : false;
    },
  });

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" data-testid="mf-loading">
        <Skeleton className="h-8 w-2/3" label="Loading fund" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return <NotFound code={String(code)} error={q.error} />;
    }
    return (
      <div className="flex flex-col items-start gap-2" data-testid="mf-error-view">
        <Banner tone="error" testId="mf-error">
          {q.error instanceof ApiError ? q.error.message : "This fund could not be loaded."}
          {q.error instanceof ApiError && q.error.requestId
            ? ` (request id ${q.error.requestId})`
            : ""}
        </Banner>
        <button
          type="button"
          data-testid="mf-retry"
          onClick={() => void q.refetch()}
          className={btn}
        >
          Retry
        </button>
      </div>
    );
  }

  const d = q.data.data;
  const stale = q.data.meta?.stale === true;
  const warnings = q.data.warnings;
  const hasMergedWarning = warnings.some((w) => w.code === "SCHEME_MAY_BE_MERGED");
  const refreshed = () => void qc.invalidateQueries({ queryKey: ["mf", code] });
  const noNav = d.nav_count === 0 || d.latest_nav === null;
  const backfilling = d.backfill?.status === "queued" || d.backfill?.status === "running";

  return (
    <div className="flex flex-col gap-4" data-testid="mf-detail">
      <Header
        d={d}
        asOf={q.data.meta?.as_of ?? d.latest_nav?.date ?? null}
        stale={stale}
        onRefreshed={refreshed}
      />
      {stale ? (
        <Banner tone="warn" testId="mf-stale">
          The latest NAV is more than 4 days old. Use Refresh to check for a newer one.
        </Banner>
      ) : null}
      {d.status === "inactive" && !hasMergedWarning ? (
        <Banner tone="warn" testId="mf-inactive">
          This scheme is inactive: it may be merged or closed. Figures are historical.
        </Banner>
      ) : null}
      {warnings.map((w) => (
        <Banner key={w.code} tone="warn" testId={`mf-warning-${w.code}`}>
          {warningText(w)}
        </Banner>
      ))}
      {noNav ? (
        <Banner tone="info" testId="mf-no-nav">
          {backfilling
            ? "No NAV history yet: it is being fetched now. This page updates by itself."
            : "No NAV history yet. Use Refresh to fetch it."}
        </Banner>
      ) : null}

      {noNav ? null : (
        <NavChart detail={d} asOf={q.data.meta?.as_of ?? d.latest_nav?.date ?? null} />
      )}
      <ReturnsCard d={d} />
      <div className="grid grid-cols-1 gap-4 desktop:grid-cols-2">
        <RiskCard d={d} />
        <RollingCard d={d} />
      </div>
      <UnavailableViews />
      <SipCalculator detail={d} />
      <LumpsumCard />
      <MfNotice />
    </div>
  );
}

export function MfDetail({ code }: { code: string }) {
  const n = Number(code);
  const valid = /^\d{1,10}$/.test(code) && Number.isSafeInteger(n) && n > 0;
  return (
    <ToastProvider>
      {valid ? (
        <Inner key={n} code={n} />
      ) : (
        <div data-testid="mf-not-found">
          <EmptyState
            message={`"${code}" is not a scheme code. Scheme codes are positive whole numbers.`}
            action={
              <Link href="/mf" data-testid="mf-browse-link" className={linkBtn}>
                Search funds
              </Link>
            }
          />
        </div>
      )}
    </ToastProvider>
  );
}
