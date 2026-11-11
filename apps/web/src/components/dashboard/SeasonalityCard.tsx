"use client";

import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Card } from "@/components/ui/Card";
import { SmallSampleChip } from "@/components/ui/chips";
import { useWatchlist } from "@/lib/dashboard/queries";
import type { WatchStock } from "@/lib/dashboard/schemas";
import {
  HISTORY_NOTE,
  MIN_YEARS_OPTIONS,
  SEASON_NOTE,
  SEASON_SOURCE,
  SORT_LABELS,
  ariaSort,
  latestSeasonAsOf,
  mainLine,
  rankSeasonality,
  subLine,
  tileMonth,
  type RankedRow,
  type SeasonSort,
} from "@/lib/dashboard/seasonality";
import { asOfText, describeError, isOlderThanExpected } from "@/lib/dashboard/state";
import { formatCount, formatDate, formatPercent } from "@/lib/format";
import { invReason } from "@/lib/stock/inv-model";

const TITLE = "This month, across the years";
const selectCls =
  "h-9 touch-target min-w-0 rounded-control border border-border bg-surface-1 px-2 text-body-sm text-text-1";

function MonthSoFar({ row, month }: { row: RankedRow; month: string }) {
  const s = row.s;
  const f = formatPercent(s.mtd_return_pct ?? null, { signed: true });
  const known = typeof s.mtd_return_pct === "number" && f.reason === null;
  const Arrow = f.direction === "up" ? ArrowUp : f.direction === "down" ? ArrowDown : Minus;
  const reason = invReason(s.mtd_reason, "no month-to-date figure");
  return (
    <span
      className="num inline-flex flex-wrap items-center gap-1 text-caption text-text-2"
      data-testid={`dash-seasonality-mtd-${row.stock.symbol}`}
    >
      {`${s.month_name ?? month} so far:`}
      {known ? (
        <>
          <Arrow size={12} strokeWidth={2} aria-hidden="true" />
          <span className="text-text-1">{f.text}</span>
          {s.mtd_as_of ? ` (as of ${formatDate(s.mtd_as_of).text})` : ""}
        </>
      ) : (
        <span title={reason}>{`— (${reason})`}</span>
      )}
    </span>
  );
}

function Row({ row, month }: { row: RankedRow; month: string }) {
  const { stock, s } = row;
  const pct = formatPercent(s.green_pct ?? null, { decimals: 0 });
  const width = Math.min(100, Math.max(0, s.green_pct ?? 0));
  return (
    <tr>
      <td className="border-t border-border p-0">
        <Link
          href={`/stocks/${encodeURIComponent(stock.symbol)}?tab=analysis`}
          data-testid={`dash-seasonality-row-${stock.symbol}`}
          className="flex min-h-11 min-w-0 flex-col gap-1 px-1 py-2 text-text-1 hover:bg-surface-3"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-body-sm font-medium">{stock.symbol}</span>
            <span className="truncate text-caption text-text-2" title={stock.name}>
              {stock.name}
            </span>
          </span>
          <span className="num text-body-sm" data-testid={`dash-seasonality-main-${stock.symbol}`}>
            {mainLine(s, pct.text)}
          </span>
          <span aria-hidden="true" className="h-2 w-full max-w-64 rounded-chip bg-surface-3">
            <span className="block h-2 rounded-chip bg-text-2" style={{ width: `${width}%` }} />
          </span>
          <span className="text-caption text-text-2">{subLine(s)}</span>
          {s.small_sample ? (
            <span className="flex flex-wrap items-center gap-2 text-caption text-text-2">
              <SmallSampleChip testId={`dash-seasonality-small-${stock.symbol}`} />
              {`Only ${formatCount(s.n_years ?? 0).text} years: a rough guide`}
            </span>
          ) : null}
          <MonthSoFar row={row} month={month} />
        </Link>
      </td>
    </tr>
  );
}

function BrowseAction() {
  return (
    <Link
      href="/stocks"
      data-testid="dash-seasonality-browse"
      className="inline-flex h-9 touch-target items-center rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3"
    >
      Browse stocks
    </Link>
  );
}

/** Home tile (docs/06 6.2a): how often each watchlist stock's current month ended higher in past years. */
export function SeasonalityCard() {
  const q = useWatchlist();
  const [sort, setSort] = useState<SeasonSort>("share");
  const [minYears, setMinYears] = useState<number>(3);
  const [live, setLive] = useState("");
  const sortId = useId();
  const minId = useId();

  if (q.isPending) return <Card title={TITLE} state="loading" testId="dash-seasonality" />;
  if (q.isError) {
    const u = describeError(q.error, "This month across the years");
    return (
      <Card
        title={TITLE}
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        source={SEASON_SOURCE}
        testId="dash-seasonality"
      />
    );
  }
  const stocks: WatchStock[] = q.data.data.stocks;
  if (stocks.length === 0) {
    return (
      <Card
        title={TITLE}
        state="empty"
        message="Add stocks to your watchlist to see how this month has behaved in past years."
        source={SEASON_SOURCE}
        actions={<BrowseAction />}
        testId="dash-seasonality"
      />
    );
  }
  const month = tileMonth(stocks, new Date());
  const { ranked, short } = rankSeasonality(stocks, sort, minYears);
  const asOf = latestSeasonAsOf(stocks);
  const stale = isOlderThanExpected(asOf, new Date()) || q.data.meta?.stale === true;
  const noSnapshot = stocks.filter((s) => !s.seasonality).length;
  const announce = (nextSort: SeasonSort, nextMin: number) => {
    const n = rankSeasonality(stocks, nextSort, nextMin).ranked.length;
    setLive(`${n} stocks shown`);
  };
  return (
    <Card
      title={TITLE}
      state={noSnapshot > 0 ? "partial" : "ready"}
      message={
        noSnapshot > 0
          ? `${noSnapshot} of ${stocks.length} stocks have no analysis yet; they are listed with the reason.`
          : undefined
      }
      stale={stale}
      source={SEASON_SOURCE}
      asOf={asOfText(asOf)}
      testId="dash-seasonality"
    >
      <div className="flex flex-col gap-3">
        <p className="text-body font-medium text-text-1" data-testid="dash-seasonality-month">
          {month}
        </p>
        <p className="text-caption text-text-2">
          The month still running is not in the share; it is shown separately as the month so far.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={sortId} className="text-caption text-text-2">
              Sort
            </label>
            <select
              id={sortId}
              data-testid="dash-seasonality-sort"
              value={sort}
              className={selectCls}
              onChange={(e) => {
                const v = e.target.value as SeasonSort;
                setSort(v);
                announce(v, minYears);
              }}
            >
              {(Object.keys(SORT_LABELS) as SeasonSort[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={minId} className="text-caption text-text-2">
              Minimum years
            </label>
            <select
              id={minId}
              data-testid="dash-seasonality-min-years"
              value={String(minYears)}
              className={selectCls}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMinYears(v);
                announce(sort, v);
              }}
            >
              {MIN_YEARS_OPTIONS.map((n) => (
                <option key={n} value={String(n)}>
                  {`${n} years`}
                </option>
              ))}
            </select>
          </div>
        </div>
        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="dash-seasonality-live"
        >
          {live}
        </span>
        {ranked.length > 0 ? (
          <table className="w-full" data-testid="dash-seasonality-list">
            <caption className="sr-only">
              {`Watchlist stocks by how often ${month} ended higher in past years`}
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  aria-sort={ariaSort(sort)}
                  className="pb-1 text-left text-caption font-medium text-text-2"
                >
                  {`Stock, years ${month} ended higher, and ${month} so far (${SORT_LABELS[sort].toLowerCase()})`}
                </th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => (
                <Row key={r.stock.id} row={r} month={month} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-body-sm text-text-2" data-testid="dash-seasonality-none">
            {`No watchlist stock has ${minYears} years of this month yet. Import more price history.`}
          </p>
        )}
        {short.length > 0 ? (
          <details data-testid="dash-seasonality-short" className="text-body-sm text-text-1">
            <summary className="min-h-11 cursor-pointer py-2 text-text-2">
              {`Not enough years yet (${short.length})`}
            </summary>
            <ul className="flex flex-col gap-1 pb-1">
              {short.map((r) => (
                <li
                  key={r.stock.id}
                  data-testid={`dash-seasonality-short-row-${r.stock.symbol}`}
                  className="text-caption text-text-2"
                >
                  <span className="font-medium text-text-1">{r.stock.symbol}</span>
                  {`: ${r.reason}`}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="text-caption text-text-2" data-testid="dash-seasonality-note">
          {SEASON_NOTE}
        </p>
        <p className="text-caption text-text-2">{HISTORY_NOTE}</p>
      </div>
    </Card>
  );
}
