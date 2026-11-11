"use client";

import { ArrowDown, ArrowUp, Minus, Star } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Card } from "@/components/ui/Card";
import { SmallSampleChip } from "@/components/ui/chips";
import { cx } from "@/components/ui/cx";
import { useSeasonality, type SeasonScope } from "@/lib/dashboard/queries";
import type { SeasonStock } from "@/lib/dashboard/schemas";
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

const SCOPES: ReadonlyArray<{ value: SeasonScope; label: string }> = [
  { value: "all", label: "All stocks" },
  { value: "watchlist", label: "Watchlist" },
];

/**
 * All stocks | Watchlist (docs/06 6.2a, D-INV2). Radio-group semantics: one tab stop, arrow keys move
 * and select, Home/End jump; the active segment is announced through `aria-checked`.
 */
function ScopeSwitch({
  value,
  onChange,
}: {
  value: SeasonScope;
  onChange: (v: SeasonScope) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (i: number) => {
    const n = (i + SCOPES.length) % SCOPES.length;
    const next = SCOPES[n];
    if (next === undefined) return;
    onChange(next.value);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SCOPES.findIndex((o) => o.value === value);
    const step: Record<string, number | undefined> = {
      ArrowRight: i + 1,
      ArrowDown: i + 1,
      ArrowLeft: i - 1,
      ArrowUp: i - 1,
      Home: 0,
      End: SCOPES.length - 1,
    };
    const to = step[e.key];
    if (to === undefined) return;
    e.preventDefault();
    move(to);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Stocks to show"
      data-testid="dash-seasonality-scope"
      data-scope={value}
      onKeyDown={onKey}
      className="inline-flex rounded-control border border-border bg-surface-2 p-0.5"
    >
      {SCOPES.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          data-testid={`dash-seasonality-scope-${o.value}`}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-9 touch-target rounded-control px-3 text-body-sm",
            o.value === value
              ? "bg-surface-1 font-medium text-text-1 shadow-sm"
              : "text-text-2 hover:text-text-1",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

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

function Row({ row, month, showWatch }: { row: RankedRow; month: string; showWatch: boolean }) {
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
            {showWatch && stock.on_watchlist === true ? (
              <span
                data-testid={`dash-seasonality-watch-${stock.symbol}`}
                className="inline-flex shrink-0 items-center gap-1 rounded-chip border border-border bg-surface-2 px-2 py-0.5 text-micro text-text-2"
              >
                <Star size={12} strokeWidth={1.75} aria-hidden="true" />
                Watchlist
              </span>
            ) : null}
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

/** Home tile (docs/06 6.2a): how often each tracked stock's current month ended higher in past years. */
export function SeasonalityCard() {
  const [scope, setScope] = useState<SeasonScope>("all");
  const q = useSeasonality(scope);
  const [sort, setSort] = useState<SeasonSort>("share");
  const [minYears, setMinYears] = useState<number>(3);
  const [live, setLive] = useState("");
  const sortId = useId();
  const minId = useId();
  const announceNext = useRef(false);
  // After a scope change the count is announced once the new list has arrived.
  useEffect(() => {
    if (!announceNext.current || !q.data || q.isPlaceholderData) return;
    announceNext.current = false;
    const n = rankSeasonality(q.data.data.stocks, sort, minYears).ranked.length;
    setLive(`${n} stocks shown`);
  }, [q.data, q.isPlaceholderData, sort, minYears]);
  const changeScope = (v: SeasonScope) => {
    if (v === scope) return;
    announceNext.current = true;
    setScope(v);
  };
  const switcher = <ScopeSwitch value={scope} onChange={changeScope} />;
  const noun = scope === "all" ? "tracked" : "watchlist";

  if (q.isPending) return <Card title={TITLE} state="loading" testId="dash-seasonality" />;
  if (q.isError) {
    const u = describeError(q.error, "This month across the years");
    return (
      <Card
        title={TITLE}
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        actions={switcher}
        source={SEASON_SOURCE}
        testId="dash-seasonality"
      />
    );
  }
  const list = q.data.data;
  const stocks: SeasonStock[] = list.stocks;
  if (stocks.length === 0) {
    return (
      <Card
        title={TITLE}
        state="empty"
        message={
          scope === "all"
            ? "No stocks are tracked yet. Import prices for a stock to see how this month has behaved in past years."
            : "Add stocks to your watchlist to see how this month has behaved in past years."
        }
        source={SEASON_SOURCE}
        actions={
          <>
            {switcher}
            <BrowseAction />
          </>
        }
        testId="dash-seasonality"
      />
    );
  }
  const month = list.month_name ?? tileMonth(stocks, new Date());
  const { ranked, short } = rankSeasonality(stocks, sort, minYears);
  const asOf = list.as_of ?? latestSeasonAsOf(stocks);
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
      actions={switcher}
      source={SEASON_SOURCE}
      asOf={asOfText(asOf)}
      testId="dash-seasonality"
    >
      <div className="flex flex-col gap-3" aria-busy={q.isPlaceholderData}>
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
              {`${scope === "all" ? "Tracked" : "Watchlist"} stocks by how often ${month} ended higher in past years`}
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
                <Row key={r.stock.symbol} row={r} month={month} showWatch={scope === "all"} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-body-sm text-text-2" data-testid="dash-seasonality-none">
            {`No ${noun} stock has ${minYears} years of this month yet. Import more price history.`}
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
                  key={r.stock.symbol}
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
