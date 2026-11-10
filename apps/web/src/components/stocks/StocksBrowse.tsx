"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner } from "@/components/ui/banners";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField, inputClass } from "@/components/ui/FormField";
import { Skeleton } from "@/components/ui/Skeleton";
import { MAX_COMPARE, MIN_COMPARE } from "@/lib/screener/compare";
import { describeError } from "@/lib/dashboard/state";
import {
  listStocks,
  STOCK_KINDS,
  STOCK_STATUSES,
  stocksKeys,
  type BrowseParams,
  type StockRow,
} from "@/lib/stocks/api";
import { useDebounced } from "@/lib/use-debounced";

export const BROWSE_DEBOUNCE_MS = 250;

const DEFAULTS: BrowseParams = { q: "", kind: "equity", status: "active", sector: "" };
const BTN =
  "inline-flex h-9 touch-target items-center justify-center rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60";

function label(s: string): string {
  return s.replace(/_/g, " ");
}

function Row({
  s,
  selected,
  canSelect,
  onToggle,
}: {
  s: StockRow;
  selected: boolean;
  canSelect: boolean;
  onToggle: () => void;
}) {
  const tags = [s.sector, s.industry].filter((x): x is string => !!x);
  return (
    <li
      data-testid={`stocks-row-${s.symbol}`}
      className="flex flex-col gap-1 border-t border-border py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <label className="touch-target inline-flex items-center gap-2 text-caption text-text-2">
          <input
            type="checkbox"
            data-testid={`stocks-select-${s.symbol}`}
            checked={selected}
            disabled={!selected && !canSelect}
            aria-describedby={!selected && !canSelect ? "stocks-compare-hint" : undefined}
            onChange={onToggle}
          />
          <span className="sr-only">Compare {s.symbol}</span>
          <span aria-hidden="true">Compare</span>
        </label>
        <Link
          href={`/stocks/${encodeURIComponent(s.symbol)}`}
          data-testid={`stocks-link-${s.symbol}`}
          className="touch-target inline-flex items-center font-medium text-accent underline"
        >
          {s.symbol}
        </Link>
        <span className="min-w-0 break-words text-body-sm text-text-1">{s.name}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-2">
        <span>{tags.length > 0 ? tags.join(" | ") : "sector not known"}</span>
        {s.status !== "active" ? <span>Status: {label(s.status)}</span> : null}
        {s.instrument_kind !== "equity" ? <span>Kind: {s.instrument_kind}</span> : null}
        <span>{s.tracked ? "Tracked" : "Not tracked: import prices to see history"}</span>
      </div>
    </li>
  );
}

export function StocksBrowse() {
  const [form, setForm] = useState<BrowseParams>(DEFAULTS);
  const dq = useDebounced(form.q, BROWSE_DEBOUNCE_MS);
  const dsector = useDebounced(form.sector, BROWSE_DEBOUNCE_MS);
  const params = useMemo<BrowseParams>(
    () => ({ ...form, q: dq, sector: dsector }),
    [form, dq, dsector],
  );
  const typing = form.q !== dq || form.sector !== dsector;
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (symbol: string) =>
    setPicked((p) => (p.includes(symbol) ? p.filter((x) => x !== symbol) : [...p, symbol]));
  const set = (patch: Partial<BrowseParams>) => setForm((f) => ({ ...f, ...patch }));

  const q = useInfiniteQuery({
    queryKey: stocksKeys.list(params),
    queryFn: ({ pageParam, signal }) => listStocks(params, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: STALE_TIME.stockIndex,
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered =
    params.q.trim() !== "" ||
    params.sector.trim() !== "" ||
    params.kind !== DEFAULTS.kind ||
    params.status !== DEFAULTS.status;
  const failure = q.isError ? describeError(q.error, "Stocks") : null;

  return (
    <div className="flex flex-col gap-4" data-testid="stocks-browse">
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold text-text-1" data-testid="stocks-title">
          Stocks
        </h1>
        <p className="text-body-sm text-text-2">
          Search known stocks by symbol or name. Defaults: equity, active.
        </p>
      </header>

      <form
        role="search"
        aria-label="Stock search"
        onSubmit={(e) => e.preventDefault()}
        className="grid grid-cols-1 gap-3 rounded-card border border-border bg-surface-1 p-4 tablet:grid-cols-2"
      >
        <FormField label="Search by symbol or name" hint="For example: reliance or TCS">
          {(p) => (
            <input
              {...p}
              type="search"
              data-testid="stocks-q"
              value={form.q}
              maxLength={100}
              onChange={(e) => set({ q: e.target.value })}
              className={inputClass}
            />
          )}
        </FormField>
        <FormField label="Sector" hint="Exact name, for example: Information Technology">
          {(p) => (
            <input
              {...p}
              type="search"
              data-testid="stocks-sector"
              value={form.sector}
              maxLength={100}
              onChange={(e) => set({ sector: e.target.value })}
              className={inputClass}
            />
          )}
        </FormField>
        <FormField label="Kind">
          {(p) => (
            <select
              {...p}
              data-testid="stocks-kind"
              value={form.kind}
              onChange={(e) => set({ kind: e.target.value })}
              className={inputClass}
            >
              {STOCK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Status">
          {(p) => (
            <select
              {...p}
              data-testid="stocks-status"
              value={form.status}
              onChange={(e) => set({ status: e.target.value })}
              className={inputClass}
            >
              {STOCK_STATUSES.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </form>

      <Banner testId="stocks-unavailable-note">
        This list shows names, sectors and whether prices are imported. Price, P/E, scores and
        valuation are not listed here, to avoid one request per row. Use the{" "}
        <Link
          href="/screener"
          data-testid="stocks-go-screener"
          className="touch-target inline-flex items-center text-accent underline"
        >
          Screener
        </Link>{" "}
        to filter and sort on those, and tick stocks below to compare them.
      </Banner>

      <div className="flex flex-wrap items-center gap-2" data-testid="stocks-compare-bar">
        {picked.length >= MIN_COMPARE ? (
          <Link
            href={`/compare?symbols=${encodeURIComponent(picked.join(","))}`}
            data-testid="stocks-compare-go"
            className={`${BTN} no-underline`}
          >
            Compare {picked.length} selected
          </Link>
        ) : (
          <button
            type="button"
            data-testid="stocks-compare-go"
            disabled
            aria-describedby="stocks-compare-hint"
            className={BTN}
          >
            Compare selected
          </button>
        )}
        <span
          id="stocks-compare-hint"
          data-testid="stocks-compare-hint"
          className="text-caption text-text-2"
        >
          {picked.length} selected. Pick {MIN_COMPARE} to {MAX_COMPARE} stocks to compare
          {picked.length >= MAX_COMPARE ? " (the most is selected)" : ""}.
        </span>
        {picked.length > 0 ? (
          <button
            type="button"
            data-testid="stocks-compare-clear"
            onClick={() => setPicked([])}
            className={BTN}
          >
            Clear selection
          </button>
        ) : null}
      </div>

      <div aria-live="polite" data-testid="stocks-status-line" className="text-caption text-text-2">
        {q.isPending || typing
          ? "Searching"
          : failure && items.length === 0
            ? ""
            : `Showing ${items.length} stock${items.length === 1 ? "" : "s"}${q.hasNextPage ? " so far" : ""}`}
      </div>

      {q.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-10 w-full" label="Loading stocks" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : failure && items.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <Banner tone={failure.state === "error" ? "error" : "info"} testId="stocks-error">
            {failure.message}
          </Banner>
          <button
            type="button"
            data-testid="stocks-retry"
            onClick={() => void q.refetch()}
            className={BTN}
          >
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState message="No stocks match these filters. Clear a filter or change the search." />
        ) : (
          <EmptyState
            message="No stocks yet. Import instruments.csv to add stocks."
            action={
              <Link
                href="/imports"
                data-testid="stocks-go-imports"
                className={`${BTN} no-underline`}
              >
                Go to Imports
              </Link>
            }
          />
        )
      ) : (
        <ul aria-label="Stocks" data-testid="stocks-list" className="flex flex-col">
          {items.map((s) => (
            <Row
              key={s.id}
              s={s}
              selected={picked.includes(s.symbol)}
              canSelect={picked.length < MAX_COMPARE}
              onToggle={() => toggle(s.symbol)}
            />
          ))}
        </ul>
      )}

      {failure && items.length > 0 ? (
        <Banner tone="error" testId="stocks-more-error">
          {failure.message} The stocks above are still shown; use Load more to try again.
        </Banner>
      ) : null}

      {q.hasNextPage ? (
        <button
          type="button"
          data-testid="stocks-more"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
          className={`${BTN} self-start`}
        >
          {q.isFetchingNextPage ? "Loading" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
