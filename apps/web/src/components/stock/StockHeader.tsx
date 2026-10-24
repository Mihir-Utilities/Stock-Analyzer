"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, GitCompare, Plus, RefreshCw, Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Banner } from "@/components/ui/banners";
import { DeltaBadge } from "@/components/ui/DeltaBadge";
import { RangeBar } from "@/components/ui/RangeBar";
import { useToast } from "@/components/ui/overlays";
import { cx } from "@/components/ui/cx";
import {
  formatDate,
  formatDateTime,
  formatInr,
  formatNumber,
  formatPercent,
  formatRelative,
} from "@/lib/format";
import { describeError } from "@/lib/imports/errors";
import { addToWatchlist, getWatchlistId, removeFromWatchlist, stockKeys } from "@/lib/stock/api";
import { headerPrice, importChip, profileBadges, weekRange } from "@/lib/stock/derive";
import {
  REFRESH_COPY,
  rateLimitedCopy,
  runRefresh,
  type RefreshOutcome,
} from "@/lib/stock/refresh";
import type { Bar, IndicatorsData, StockProfile } from "@/lib/stock/schemas";

const btn =
  "inline-flex h-9 touch-target items-center gap-1.5 rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60";

export const ALERT_UNAVAILABLE =
  "Alerts can not be created from this page yet: the alerts screen is not built.";
export const TXN_UNAVAILABLE =
  "Transactions can not be added from this page yet: the portfolio screen is not built.";

function WatchlistButton({ symbol }: { symbol: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  // The id is looked up per symbol (DELETE needs it).
  const key = [...stockKeys.watchlist, symbol] as const;
  const idQ = useQuery({ queryKey: key, queryFn: () => getWatchlistId(symbol) });
  const id = idQ.data ?? null;
  const toggle = useMutation({
    mutationFn: async () => {
      if (id === null) await addToWatchlist(symbol);
      else await removeFromWatchlist(id);
    },
    onSuccess: () => {
      toast(
        id === null ? `${symbol} added to the watchlist.` : `${symbol} removed from the watchlist.`,
      );
      void qc.invalidateQueries({ queryKey: stockKeys.watchlist });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(describeError(e), "error"),
  });
  const on = id !== null;
  return (
    <button
      type="button"
      data-testid="header-watchlist"
      aria-pressed={on}
      disabled={idQ.isPending || toggle.isPending}
      onClick={() => toggle.mutate()}
      className={btn}
    >
      <Star size={16} strokeWidth={1.75} aria-hidden="true" className={cx(on && "fill-current")} />
      Watchlist
    </button>
  );
}

function RefreshButton({ symbol, onDone }: { symbol: string; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RefreshOutcome | null>(null);
  const go = async () => {
    setBusy(true);
    setOutcome(null);
    const o = await runRefresh(symbol);
    setBusy(false);
    setOutcome(o);
    if (o.kind === "ok") {
      toast(REFRESH_COPY.done);
      onDone();
    }
  };
  let note: string | null = null;
  if (busy) note = REFRESH_COPY.working;
  else if (outcome?.kind === "rate_limited") note = rateLimitedCopy(outcome.minutes);
  else if (outcome?.kind === "timeout") note = REFRESH_COPY.timeout;
  else if (outcome?.kind === "failed") note = outcome.message;
  return (
    <>
      <button
        type="button"
        data-testid="header-refresh"
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
      <span aria-live="polite" data-testid="refresh-note" className="text-caption text-text-2">
        {note}
      </span>
      {outcome?.kind === "broker_session_missing" ? (
        <Banner tone="warn" testId="broker-banner">
          {REFRESH_COPY.brokerSession}{" "}
          <Link
            href="/settings"
            data-testid="reconnect-broker"
            className="touch-target inline-flex items-center underline"
          >
            Reconnect broker
          </Link>
        </Banner>
      ) : null}
    </>
  );
}

/** Compact part that stays visible while scrolling: symbol, name and price (docs/06 4.2). */
export function StockHeader({
  profile,
  bars,
  indicators,
  onRefreshed,
}: {
  profile: StockProfile;
  bars: ReadonlyArray<Bar> | null;
  indicators: IndicatorsData | null;
  onRefreshed: () => void;
}) {
  const price = headerPrice(profile, bars);
  const range = weekRange(profile, indicators);
  const chip = importChip(profile);
  const badges = profileBadges(profile);
  const manual = profile.price_mode !== "broker";
  const ltp = formatInr(price.ltp, { reason: price.reason ?? "no data" });
  const changeAbs = formatInr(price.change, { reason: "no earlier price to compare" });
  const pct = formatPercent(price.changePct, {
    signed: true,
    reason: "no earlier price to compare",
  });
  const deltaText =
    price.change === null || price.changePct === null
      ? null
      : `${price.change > 0 ? "+" : ""}${changeAbs.text} (${pct.text})`;
  const asOf =
    price.kind === "quote"
      ? formatDateTime(price.asOf).text
      : formatDate(price.asOf, { reason: "unknown" }).text;
  const age = price.kind === "quote" ? formatRelative(price.asOf).text : null;
  const meta = [profile.sector, profile.industry].filter(Boolean).join(" / ");

  return (
    <>
      <div
        data-testid="stock-header-bar"
        className="sticky top-[3.25rem] z-10 -mx-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border bg-surface-1 px-4 py-2 desktop:top-14 desktop:-mx-6 desktop:px-6"
      >
        <div className="min-w-0">
          <h1 data-testid="stock-symbol" className="text-page font-semibold text-text-1">
            {profile.symbol}
          </h1>
          <div data-testid="stock-name" className="truncate text-body-sm text-text-2">
            {profile.name}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          {price.ltp !== null ? (
            <span data-testid="header-ltp" className="num text-page font-semibold text-text-1">
              {ltp.text}
            </span>
          ) : (
            <span data-testid="header-ltp-null" className="text-body-sm text-text-2">
              {"—"} {ltp.reason}
            </span>
          )}
          {price.ltp !== null ? (
            <span data-testid="header-change">
              <DeltaBadge value={price.change} text={deltaText} />
            </span>
          ) : null}
        </div>
      </div>

      <section
        aria-label="Price details"
        data-testid="stock-header-details"
        className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
      >
        <div className="flex flex-wrap items-center gap-2 text-caption text-text-2">
          {price.kind !== "none" ? (
            <span data-testid="header-price-meta" className="num">
              {price.kind === "quote" ? "Quote" : "Last close"} as of {asOf}
              {age ? ` (${age})` : ""} | Source: {price.source}
              {price.kind === "last_close" ? " | adjusted price, excludes dividends" : ""}
            </span>
          ) : null}
          {meta ? (
            <span
              data-testid="header-sector"
              className="rounded-chip border border-border px-2 py-0.5 text-micro"
            >
              {meta}
            </span>
          ) : null}
          {badges.map((b) => (
            <span
              key={b.id}
              data-testid={`badge-${b.id}`}
              className="rounded-chip border border-border bg-surface-2 px-2 py-0.5 text-micro text-text-1"
            >
              {b.text}
            </span>
          ))}
          {manual ? (
            <>
              <span
                data-testid="import-chip"
                data-stale={chip.stale}
                className={cx(
                  "rounded-chip border bg-surface-2 px-2 py-0.5 text-micro",
                  chip.stale ? "border-warn text-text-1" : "border-border text-text-2",
                )}
              >
                {chip.text}
                {chip.stale ? " (stale)" : ""}
              </span>
              <Link
                href="/imports"
                data-testid="header-import-prices"
                className="touch-target inline-flex items-center text-body-sm text-accent underline"
              >
                Import prices
              </Link>
            </>
          ) : null}
          {profile.freshness.holidays_missing ? (
            <span
              data-testid="holidays-missing-chip"
              title="No market holidays are loaded for this year, so staleness uses weekends only."
              className="rounded-chip border border-warn bg-surface-2 px-2 py-0.5 text-micro text-text-1"
            >
              Holiday list missing
            </span>
          ) : null}
        </div>

        {price.kind === "quote" && profile.quote ? (
          <div data-testid="header-day-stats" className="num text-caption text-text-2">
            Day range {formatInr(profile.quote.day_low ?? null, { reason: "not provided" }).text} to{" "}
            {formatInr(profile.quote.day_high ?? null, { reason: "not provided" }).text} | Previous
            close {formatInr(profile.quote.prev_close ?? null, { reason: "not provided" }).text} |
            Volume{" "}
            {
              formatNumber(profile.quote.volume ?? null, { decimals: 0, reason: "not provided" })
                .text
            }
          </div>
        ) : null}

        <div className="max-w-xl">
          <RangeBar
            low={range.low}
            high={range.high}
            value={price.ltp}
            lowText={formatInr(range.low).text}
            highText={formatInr(range.high).text}
            valueText={formatInr(price.ltp).text}
            nullReason="needs 252 trading days of imported prices (insufficient history)"
          />
          <div className="mt-1 text-micro text-text-2">Source: {range.source}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2" data-testid="header-actions">
          <WatchlistButton symbol={profile.symbol} />
          <button
            type="button"
            data-testid="header-alert"
            disabled
            title={ALERT_UNAVAILABLE}
            className={btn}
          >
            <Bell size={16} strokeWidth={1.75} aria-hidden="true" />
            Alert
          </button>
          <button
            type="button"
            data-testid="header-add-txn"
            disabled
            title={TXN_UNAVAILABLE}
            className={btn}
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            Add transaction
          </button>
          <Link
            href={`/compare?symbols=${encodeURIComponent(profile.symbol)}`}
            data-testid="header-compare"
            className={btn}
          >
            <GitCompare size={16} strokeWidth={1.75} aria-hidden="true" />
            Compare
          </Link>
          {!manual ? <RefreshButton symbol={profile.symbol} onDone={onRefreshed} /> : null}
        </div>
        <p data-testid="header-actions-note" className="text-micro text-text-2">
          Alert and Add transaction are switched off here until the alerts and portfolio screens
          exist.
        </p>
      </section>
    </>
  );
}
