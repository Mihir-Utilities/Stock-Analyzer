"use client";

import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { DeltaBadge } from "@/components/ui/DeltaBadge";
import { heatColor } from "@/components/ui/Heatmap";
import { useWatchlist } from "@/lib/dashboard/queries";
import type { WatchStock } from "@/lib/dashboard/schemas";
import {
  asOfText,
  describeError,
  isOlderThanExpected,
  lastPriceImportDate,
  topMovers,
} from "@/lib/dashboard/state";
import { formatInr, formatPercent } from "@/lib/format";

export const WATCH_SOURCE = "Your imported prices (day change = last two bars)";
const MOVERS_SHOWN = 5;

function AddStocksAction() {
  return (
    <Link
      href="/stocks"
      data-testid="watchlist-browse"
      className="inline-flex h-9 touch-target items-center rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3"
    >
      Browse stocks
    </Link>
  );
}

function HeatTile({ stock, maxAbs }: { stock: WatchStock; maxAbs: number }) {
  const change = formatPercent(stock.change_pct ?? null, { signed: true });
  return (
    <Link
      href={`/stocks/${encodeURIComponent(stock.symbol)}`}
      data-testid="watch-tile"
      title={change.reason ?? stock.change_reason ?? undefined}
      className="flex min-h-11 touch-target min-w-0 flex-col justify-between gap-1 rounded-control border border-border px-3 py-2 text-text-1"
      style={{ backgroundColor: heatColor(stock.change_pct ?? null, maxAbs) }}
    >
      <span className="truncate text-body-sm font-medium">{stock.symbol}</span>
      {/* Text stays --text-1: up/down colours do not reach 4.5:1 on the tinted tile. The arrow and the sign carry direction. */}
      <span className="num inline-flex items-center gap-0.5 text-body-sm">
        {change.direction === "up" ? (
          <ArrowUp size={12} strokeWidth={2} aria-hidden="true" />
        ) : change.direction === "down" ? (
          <ArrowDown size={12} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Minus size={12} strokeWidth={2} aria-hidden="true" />
        )}
        {change.reason === null ? change.text : "n/a"}
      </span>
    </Link>
  );
}

/** Watchlist heat tiles: colour = day change, and the signed value is printed on every tile. */
export function WatchlistHeatCard() {
  const q = useWatchlist();
  const title = "Watchlist";
  if (q.isPending) return <Card title={title} state="loading" testId="dash-watchlist" />;
  if (q.isError) {
    const u = describeError(q.error, "The watchlist");
    return (
      <Card
        title={title}
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        source={WATCH_SOURCE}
        testId="dash-watchlist"
      />
    );
  }
  const stocks = q.data.data.stocks;
  if (stocks.length === 0) {
    return (
      <Card
        title={title}
        state="empty"
        message="Your watchlist has no stocks. Add one from its stock page."
        source={WATCH_SOURCE}
        actions={<AddStocksAction />}
        testId="dash-watchlist"
      />
    );
  }
  const last = lastPriceImportDate(stocks);
  const missing = stocks.filter((s) => s.change_pct === null || s.change_pct === undefined).length;
  const stale = isOlderThanExpected(last, new Date()) || q.data.meta?.stale === true;
  const maxAbs = Math.max(1, ...stocks.map((s) => Math.abs(s.change_pct ?? 0)));
  return (
    <Card
      title={title}
      state={missing > 0 ? "partial" : stale ? "stale" : "ready"}
      message={`${missing} of ${stocks.length} stocks have no day change (at least two imported bars are needed).${stale ? " Prices are stale." : ""}`}
      source={WATCH_SOURCE}
      asOf={asOfText(last)}
      testId="dash-watchlist"
    >
      <div
        data-testid="watch-tiles"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 desktop:grid-cols-2 xl:grid-cols-3"
      >
        {stocks.map((s) => (
          <HeatTile key={s.id} stock={s} maxAbs={maxAbs} />
        ))}
      </div>
    </Card>
  );
}

function MoverTable({ label, rows }: { label: string; rows: WatchStock[] }) {
  return (
    <div className="min-w-0">
      <table aria-label={label} data-testid="movers-table" className="w-full text-body-sm">
        <caption className="pb-1 text-left text-caption font-medium text-text-2">{label}</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col">Price</th>
            <th scope="col">Day change</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="py-1 text-text-2">
                None
              </td>
            </tr>
          ) : (
            rows.map((s) => {
              const change = formatPercent(s.change_pct ?? null, { signed: true });
              return (
                <tr key={s.id} data-testid="mover-row">
                  <th scope="row" className="py-1 pr-2 text-left font-medium">
                    {s.symbol}
                  </th>
                  <td className="num py-1 pr-2 text-right">{formatInr(s.ltp ?? null).text}</td>
                  <td className="py-1 text-right">
                    <DeltaBadge value={s.change_pct ?? null} text={change.text} />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Gainers and losers among the stocks on the watchlist (not market wide: no screener data). */
export function MoversCard() {
  const q = useWatchlist();
  const title = "Watchlist movers";
  if (q.isPending) return <Card title={title} state="loading" testId="dash-movers" />;
  if (q.isError) {
    const u = describeError(q.error, "Movers");
    return (
      <Card
        title={title}
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        source={WATCH_SOURCE}
        testId="dash-movers"
      />
    );
  }
  const stocks = q.data.data.stocks;
  const { gainers, losers } = topMovers(stocks, MOVERS_SHOWN);
  if (gainers.length === 0 && losers.length === 0) {
    return (
      <Card
        title={title}
        state="empty"
        message={
          stocks.length === 0
            ? "No movers: your watchlist is empty."
            : "No movers: no watchlist stock has a day change (at least two imported bars are needed)."
        }
        source={WATCH_SOURCE}
        asOf={asOfText(lastPriceImportDate(stocks))}
        testId="dash-movers"
      />
    );
  }
  const last = lastPriceImportDate(stocks);
  return (
    <Card
      title={title}
      state={isOlderThanExpected(last, new Date()) ? "stale" : "ready"}
      source={WATCH_SOURCE}
      asOf={asOfText(last)}
      testId="dash-movers"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <MoverTable label="Top gainers" rows={gainers} />
        <MoverTable label="Top losers" rows={losers} />
      </div>
    </Card>
  );
}
