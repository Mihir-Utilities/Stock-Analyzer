"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { MetricValue, StampView, BTN } from "@/components/screener/parts";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { inputClass } from "@/components/ui/FormField";
import { ApiError } from "@/lib/api/client";
import { describeError } from "@/lib/dashboard/state";
import { formatPercent } from "@/lib/format";
import { getPeers, screenerKeys } from "@/lib/screener/api";
import { COMPARE_SYMBOL } from "@/lib/screener/compare";
import { formatMetric, reasonWords } from "@/lib/screener/display";
import { metricHeader } from "@/lib/screener/metrics";
import { PEER_METRICS, type PeerRow, type PeersResult } from "@/lib/screener/schemas";
import type { StockProfile } from "@/lib/stock/schemas";

export const PEERS_NEEDS_SECTOR =
  "Import sector data to see peers. Peers are chosen from the sector and industry you import for each stock.";
export const MAX_PEER_OVERRIDES = 10;

const th = "whitespace-nowrap px-2 py-1 text-caption font-medium text-text-2";

function basisText(d: PeersResult): string {
  return d.basis === "industry"
    ? `Peers from the same industry${d.industry ? ` (${d.industry})` : ""}.`
    : `Peers from the same sector${d.sector ? ` (${d.sector})` : ""}: fewer than 4 stocks share the industry, so the pool was widened.`;
}

function bandText(band: string): string {
  const [lo, hi] = band.split("-");
  return lo && hi
    ? `Market cap between ${lo} and ${hi} times this stock's.`
    : `Market cap band ${band}.`;
}

function PeerLine({
  p,
  units,
  isSelf,
  onRemove,
}: {
  p: PeerRow;
  units: Record<string, string>;
  isSelf: boolean;
  onRemove?: () => void;
}) {
  return (
    <tr
      data-testid={`peers-row-${p.symbol}`}
      data-origin={p.origin}
      data-stale={p.stale}
      className={`border-b border-border align-top ${isSelf ? "bg-surface-2" : p.stale ? "border-l-4 border-l-warn" : ""}`}
    >
      <th scope="row" className="px-2 py-1 text-left font-normal">
        <div className="flex flex-col gap-0.5">
          {isSelf ? (
            <span className="font-medium text-text-1">{p.symbol}</span>
          ) : (
            <Link
              href={`/stocks/${encodeURIComponent(p.symbol)}?tab=peers`}
              data-testid={`peers-link-${p.symbol}`}
              className="touch-target inline-flex items-center font-medium text-accent underline"
            >
              {p.symbol}
            </Link>
          )}
          <span className="text-caption text-text-2">{p.name}</span>
          <span className="text-micro text-text-2" data-testid={`peers-origin-${p.symbol}`}>
            {isSelf
              ? "This stock"
              : p.origin === "added"
                ? "Added by you (this view only)"
                : "Chosen automatically"}
          </span>
        </div>
      </th>
      {PEER_METRICS.map((m) => {
        const rank = p.percentile_rank?.[m] ?? null;
        return (
          <td
            key={m}
            data-testid={`peers-cell-${p.symbol}-${m}`}
            className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-text-1"
          >
            <MetricValue f={formatMetric(m, p[m], p.value_reasons?.[m], units[m])} />
            {rank !== null ? (
              <span
                className="block text-micro text-text-2"
                data-testid={`peers-rank-${p.symbol}-${m}`}
              >
                Rank {formatPercent(rank, { decimals: 0 }).text}
              </span>
            ) : null}
          </td>
        );
      })}
      <td className="px-2 py-1">
        <StampView stamp={p} testId={`peers-stamp-${p.symbol}`} />
      </td>
      <td className="px-2 py-1">
        {onRemove ? (
          <button
            type="button"
            data-testid={`peers-remove-${p.symbol}`}
            aria-label={`Remove ${p.symbol} from this view`}
            onClick={onRemove}
            className={BTN}
          >
            Remove
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function reasonOf(e: unknown): string | null {
  if (e instanceof ApiError && e.code === "DATA_UNAVAILABLE") {
    const r = e.details?.["reason"];
    return typeof r === "string" ? r : null;
  }
  return null;
}

/**
 * Peers tab (docs/06 6.4; `GET /stocks/{symbol}/peers`, B13). Reasons the server gives
 * (`no_sector_data`, `no_market_cap`) are shown as they are; nothing is estimated here.
 * Add and remove are temporary for this view and are not saved.
 */
export function PeersTab({ profile }: { profile: StockProfile }) {
  const symbol = profile.symbol;
  const [added, setAdded] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: screenerKeys.peers(symbol, added.join(","), removed.join(",")),
    queryFn: () => getPeers(symbol, { add: added, remove: removed }),
    staleTime: STALE_TIME.analysis,
    retry: false,
  });

  const submitAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const s = text.trim().toUpperCase();
    if (!COMPARE_SYMBOL.test(s)) {
      setAddError("Enter one symbol: letters, digits and & . _ - only.");
    } else if (s === symbol.toUpperCase() || added.includes(s)) {
      setAddError("That symbol is already in this view.");
    } else if (added.length >= MAX_PEER_OVERRIDES) {
      setAddError(`You can add at most ${MAX_PEER_OVERRIDES} peers.`);
    } else {
      setAddError(null);
      setAdded([...added, s]);
      setRemoved(removed.filter((r) => r !== s));
      setText("");
    }
  };

  if (q.isPending) {
    return <Card title="Peers" state="loading" testId="peers-card" />;
  }
  if (q.isError) {
    const reason = reasonOf(q.error);
    if (reason === "no_sector_data") {
      return (
        <Card title="Peers" testId="peers-card">
          <div data-testid="peers-unavailable" data-reason={reason}>
            <EmptyState
              message={PEERS_NEEDS_SECTOR}
              action={
                <Link
                  href="/imports"
                  data-testid="peers-import-link"
                  className="touch-target inline-flex items-center text-body-sm text-accent underline"
                >
                  Import sector data
                </Link>
              }
            />
          </div>
        </Card>
      );
    }
    if (reason === "no_market_cap") {
      return (
        <Card title="Peers" testId="peers-card">
          <div data-testid="peers-unavailable" data-reason={reason}>
            <EmptyState
              message={`Peers need a market cap for this stock: ${reasonWords(reason)}. Peers are the stocks of a similar size, so none can be chosen without it.`}
            />
          </div>
        </Card>
      );
    }
    const hasOverrides = added.length > 0 || removed.length > 0;
    return (
      <div className="flex flex-col gap-2">
        <Card
          title="Peers"
          state={
            q.error instanceof ApiError && q.error.code === "NOT_IMPLEMENTED" ? "empty" : "error"
          }
          message={
            q.error instanceof ApiError && q.error.status === 422
              ? `These peers could not be used: ${q.error.message}. Reset the peers and try again.`
              : describeError(q.error, "Peers").message
          }
          onRetry={() => void q.refetch()}
          testId="peers-card"
        />
        {hasOverrides ? (
          <button
            type="button"
            data-testid="peers-reset"
            onClick={() => {
              setAdded([]);
              setRemoved([]);
            }}
            className={`${BTN} self-start`}
          >
            Reset peers
          </button>
        ) : null}
      </div>
    );
  }

  const d = q.data;
  if ("redirect_symbol" in d) {
    return (
      <Card title="Peers" testId="peers-card">
        <p className="text-body-sm text-text-1" data-testid="peers-redirect">
          {symbol} is now listed as{" "}
          <Link
            href={`/stocks/${encodeURIComponent(d.redirect_symbol)}?tab=peers`}
            className="touch-target inline-flex items-center text-accent underline"
          >
            {d.redirect_symbol}
          </Link>
          .
        </p>
      </Card>
    );
  }

  const anyStale = [d.self, ...d.peers].some((p) => p.stale);
  return (
    <Card
      title="Peers"
      source="Analytics run (screener row)"
      asOf={d.self.as_of ?? null}
      stale={anyStale}
      testId="peers-card"
    >
      <div className="flex flex-col gap-3" data-testid="peers-panel">
        <div className="flex flex-col gap-1 text-body-sm text-text-1">
          <p data-testid="peers-sector">
            Sector: {d.sector ?? "not on file"}; industry: {d.industry ?? "not on file"}.
          </p>
          <p data-testid="peers-basis">{basisText(d)}</p>
          <p data-testid="peers-band">{bandText(d.market_cap_band)}</p>
        </div>
        {d.note ? (
          <Banner tone="info" testId="peers-note">
            {d.note.charAt(0).toUpperCase() + d.note.slice(1)}: fewer than 4 peers matched, so
            percentile ranks rest on a small group.
          </Banner>
        ) : null}
        {anyStale ? (
          <Banner tone="warn" testId="peers-stale">
            Some of these stocks have stale owner data. The label on a row says why.
          </Banner>
        ) : null}
        {d.peers.length === 0 ? (
          <p className="text-body-sm text-text-2" data-testid="peers-empty">
            No comparable peers were found for this stock.
          </p>
        ) : null}

        <div
          className="relative overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label="Peers table, scrollable"
          data-testid="peers-table-scroll"
        >
          <table
            className="w-full min-w-max border-collapse text-body-sm"
            data-testid="peers-table"
          >
            <caption className="sr-only">Peers and this stock</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={`${th} text-left`}>
                  Stock
                </th>
                {PEER_METRICS.map((m) => (
                  <th key={m} scope="col" className={`${th} text-right`}>
                    {metricHeader(m, d.units)}
                  </th>
                ))}
                <th scope="col" className={`${th} text-left`}>
                  Last updated
                </th>
                <th scope="col" className={`${th} text-left`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <PeerLine p={d.self} units={d.units} isSelf />
              {d.peers.map((p) => (
                <PeerLine
                  key={p.symbol}
                  p={p}
                  units={d.units}
                  isSelf={false}
                  onRemove={() =>
                    p.origin === "added"
                      ? setAdded(added.filter((a) => a !== p.symbol))
                      : setRemoved([...removed, p.symbol])
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-caption text-text-2" data-testid="peers-method">
          Rank is a percent from 0 to 100 among the peers and this stock: {d.percentile_method}. A
          higher rank means a higher value, not always a better one.
        </p>

        <form onSubmit={submitAdd} noValidate className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-caption font-medium text-text-1">
            Add a peer for this view
            <input
              type="text"
              data-testid="peers-add-symbol"
              value={text}
              maxLength={20}
              aria-invalid={addError !== null}
              aria-describedby="peers-add-hint"
              onChange={(e) => setText(e.target.value)}
              className={inputClass}
            />
          </label>
          <button type="submit" data-testid="peers-add" className={BTN}>
            Add peer
          </button>
          {added.length > 0 || removed.length > 0 ? (
            <button
              type="button"
              data-testid="peers-reset"
              onClick={() => {
                setAdded([]);
                setRemoved([]);
              }}
              className={BTN}
            >
              Reset peers
            </button>
          ) : null}
        </form>
        <p id="peers-add-hint" className="text-caption text-text-2" aria-live="polite">
          {addError ? (
            <span data-testid="peers-add-error">
              <span className="font-medium text-down">Error: </span>
              {addError}
            </span>
          ) : (
            "Changes apply to this view only and are not saved."
          )}
        </p>
      </div>
    </Card>
  );
}
