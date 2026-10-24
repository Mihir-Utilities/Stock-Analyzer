"use client";

import { Card } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { useMarketOverview } from "@/lib/dashboard/queries";
import type { MarketOverview } from "@/lib/dashboard/schemas";
import { asOfText, describeError } from "@/lib/dashboard/state";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";

type Quote = NonNullable<MarketOverview["vix"]>;

export const INDEX_SOURCE = "Index rows you imported (NIFTY50, INDIAVIX in prices.csv)";
/** BRK-16: shown whenever the index or VIX series is not served. */
export const NO_INDEX_REASON =
  "No index data. Import NIFTY50 and INDIAVIX rows with Import prices to see them here.";

function findQuote(data: MarketOverview, code: string): Quote | null {
  if (code === "INDIAVIX" && data.vix) return data.vix;
  return data.indices?.find((i) => i.code === code) ?? null;
}

function IndexStat({ label, quote }: { label: string; quote: Quote | null }) {
  const value = quote?.value ?? null;
  const change = formatPercent(quote?.change_pct ?? null, { signed: true });
  return (
    <Stat
      label={label}
      value={value === null ? null : formatNumber(value).text}
      delta={value === null ? undefined : { value: quote?.change_pct ?? null, text: change.text }}
      nullReason={NO_INDEX_REASON}
      source={INDEX_SOURCE}
      asOf={asOfText(quote?.as_of)}
    />
  );
}

/** Nifty 50 and India VIX tiles; only shown when served, else the reason (docs/06 section 6.2). */
export function IndexTilesCard() {
  const q = useMarketOverview();
  const title = "Indices";
  if (q.isPending) return <Card title={title} state="loading" testId="dash-indices" />;
  if (q.isError) {
    const u = describeError(q.error, "Index data");
    return (
      <Card
        title={title}
        state={u.state}
        message={u.state === "empty" ? `${u.message} ${NO_INDEX_REASON}` : u.message}
        onRetry={() => void q.refetch()}
        source={INDEX_SOURCE}
        testId="dash-indices"
      />
    );
  }
  const nifty = findQuote(q.data.data, "NIFTY50");
  const vix = findQuote(q.data.data, "INDIAVIX");
  if (!nifty && !vix) {
    return (
      <Card
        title={title}
        state="empty"
        message={NO_INDEX_REASON}
        source={INDEX_SOURCE}
        testId="dash-indices"
      />
    );
  }
  const stale = q.data.meta?.stale === true;
  return (
    <Card
      title={title}
      state={stale ? "stale" : !nifty || !vix ? "partial" : "ready"}
      message={
        !nifty || !vix ? "One of the two series is missing; the reason is shown on it." : undefined
      }
      source={INDEX_SOURCE}
      asOf={asOfText(nifty?.as_of ?? vix?.as_of)}
      testId="dash-indices"
    >
      <div className="grid grid-cols-2 gap-4">
        <IndexStat label="Nifty 50" quote={nifty} />
        <IndexStat label="India VIX" quote={vix} />
      </div>
    </Card>
  );
}

/** Open or closed now and the next open (market hours and the holiday list, from the API). */
export function MarketStatusCard() {
  const q = useMarketOverview();
  const title = "Market status";
  const source = "Trading hours and holiday list";
  if (q.isPending) return <Card title={title} state="loading" testId="dash-market-status" />;
  const status = q.isError ? null : (q.data.data.market_status ?? null);
  if (q.isError || !status || status.is_open === null || status.is_open === undefined) {
    const u = q.isError ? describeError(q.error, "Market status") : null;
    return (
      <Card
        title={title}
        state={u?.state ?? "empty"}
        message={u?.message ?? "Market status is not available: the server did not report it."}
        onRetry={() => void q.refetch()}
        source={source}
        testId="dash-market-status"
      />
    );
  }
  const holiday =
    typeof status.holiday === "string" ? status.holiday : (status.holiday?.name ?? null);
  const next = formatDateTime(status.next_open ?? null);
  return (
    <Card
      title={title}
      source={source}
      asOf={asOfText(q.data.meta?.as_of)}
      testId="dash-market-status"
    >
      <div className="flex flex-col gap-1">
        <span data-testid="market-open-text" className="text-section font-semibold text-text-1">
          {status.is_open ? "Market open" : "Market closed"}
        </span>
        {holiday ? <span className="text-body-sm text-text-2">Holiday: {holiday}</span> : null}
        {!status.is_open ? (
          <span className="text-body-sm text-text-2">
            Next open: {next.reason === null ? next.text : `unknown (${next.reason})`}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
