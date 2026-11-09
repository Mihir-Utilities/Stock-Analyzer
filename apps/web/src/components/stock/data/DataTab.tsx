"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { DeletePricesAction } from "@/components/imports/DeletePricesAction";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatDate } from "@/lib/format";
import { describeError } from "@/lib/imports/errors";
import { getChartPrices } from "@/lib/stock/chart-api";
import {
  ADJUSTMENT_CHECK_INFO,
  ADJUSTMENT_MIX_WARNING,
  adjustmentConflictText,
  adjustmentKey,
  adjustmentSentence,
  getPricesAdjustment,
} from "@/lib/stock/data-tab";
import { toLoad } from "@/lib/stock/load";
import type { PricesData, StockProfile } from "@/lib/stock/schemas";

const linkClass = "touch-target inline-flex items-center text-body-sm text-accent underline";

function Row({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-t border-border py-1 text-body-sm">
      <dt className="text-text-2">{label}</dt>
      <dd data-testid={testId} className="num text-text-1">
        {children}
      </dd>
    </div>
  );
}

const NOT_SERVED = "not reported by the API";

/**
 * Data tab (docs/06 6.4): coverage and freshness, price history depth, the adjustment setting and
 * the ADJUSTMENT_CONFLICT warning, and the manual "delete prices" action. Sources used, suspect
 * row counts and per-stock import batches are not served by the API, so each says so (F08-3).
 */
export function DataTab({
  profile,
  warnings,
}: {
  profile: StockProfile;
  warnings: ReadonlyArray<{ code: string; message: string }>;
}) {
  const symbol = profile.symbol;
  const pricesQ = useQuery({
    queryKey: ["stocks", symbol, "data-depth"],
    queryFn: () => getChartPrices(symbol, "MAX", true),
    staleTime: STALE_TIME.prices,
    enabled: !profile.flags.no_prices,
  });
  const adjQ = useQuery({
    queryKey: adjustmentKey,
    queryFn: getPricesAdjustment,
    staleTime: STALE_TIME.profile,
  });
  const prices = toLoad<PricesData>(pricesQ);
  const f = profile.freshness;
  const conflicts = warnings.filter((w) => w.code === "ADJUSTMENT_CONFLICT");
  const depth = prices.state === "ready" ? prices.data.depth : undefined;
  const noPricesWhy = "no prices imported for this stock";
  const depthWhy = profile.flags.no_prices
    ? noPricesWhy
    : prices.state === "loading"
      ? "loading"
      : "history depth unavailable";

  return (
    <div className="flex flex-col gap-4" data-testid="data-tab">
      {conflicts.map((w, i) => (
        <Banner key={i} tone="warn" testId="adjustment-conflict">
          {adjustmentConflictText(w.message)}
        </Banner>
      ))}
      <Card title="Data coverage and freshness" testId="data-coverage" source="Your imported files">
        <dl>
          <Row label="Prices as of" testId="data-prices-as-of">
            {formatDate(f.prices_as_of, { reason: noPricesWhy }).text}
          </Row>
          <Row label="Fundamentals as of" testId="data-fundamentals-as-of">
            {formatDate(f.fundamentals_as_of, { reason: "no results entered" }).text}
          </Row>
          <Row label="Shareholding as of (latest quarter end)" testId="data-shareholding-as-of">
            {formatDate(f.shareholding_as_of, { reason: "no shareholding entered" }).text}
          </Row>
          <Row label="Price history rows" testId="data-bars">
            {profile.flags.no_prices
              ? formatCount(null, { reason: noPricesWhy }).text
              : prices.state === "loading"
                ? "Loading"
                : formatCount(depth?.bars ?? null, { reason: "history depth unavailable" }).text}
          </Row>
          <Row label="First price date" testId="data-first-bar">
            {formatDate(depth?.first_bar ?? null, { reason: depthWhy }).text}
          </Row>
          <Row label="Last price date" testId="data-last-bar">
            {formatDate(depth?.last_bar ?? null, { reason: depthWhy }).text}
          </Row>
          <Row label="Price sources used" testId="data-sources">
            {NOT_SERVED}
          </Row>
          <Row label="Suspect price rows" testId="data-suspect">
            {NOT_SERVED}
          </Row>
        </dl>
        {profile.flags.limited_history ? (
          <p className="mt-2 text-caption text-text-2" data-testid="data-limited">
            Limited history: the imported prices start later than expected.
          </p>
        ) : null}
        {prices.state === "error" ? (
          <Banner tone="warn" testId="data-depth-error">
            History depth could not be loaded: {prices.message}{" "}
            <button
              type="button"
              data-testid="data-depth-retry"
              onClick={prices.retry}
              className="touch-target underline"
            >
              Retry
            </button>
          </Banner>
        ) : null}
        <p className="mt-2 text-caption text-text-2" data-testid="data-batches">
          Import batches: the batch list does not say which stocks a batch touched, so it cannot be
          filtered for {symbol}.{" "}
          <Link href="/imports" data-testid="data-batches-link" className={linkClass}>
            Open the Import center to review or undo batches
          </Link>
        </p>
      </Card>
      <Card
        title="Price adjustment"
        testId="data-adjustment"
        source="Setting you chose in the import wizard"
      >
        {adjQ.isPending ? (
          <Skeleton className="h-10 w-full" label="Loading setting" />
        ) : adjQ.isError ? (
          <Banner tone="warn" testId="data-adjustment-error">
            The adjustment setting could not be loaded: {describeError(adjQ.error)}
          </Banner>
        ) : (
          <p className="text-body-sm text-text-1" data-testid="adjustment-state">
            {adjustmentSentence(adjQ.data.value)}
            {adjQ.data.set_at ? ` Set ${formatDate(adjQ.data.set_at).text}.` : ""}
          </p>
        )}
        <p className="mt-2 text-caption text-text-2" data-testid="adjustment-mix">
          {ADJUSTMENT_MIX_WARNING}
        </p>
        <p className="mt-2 text-caption text-text-2" data-testid="adjustment-check-info">
          {ADJUSTMENT_CHECK_INFO}
        </p>
      </Card>
      {profile.price_mode !== "broker" ? <DeletePricesAction symbol={symbol} /> : null}
    </div>
  );
}
