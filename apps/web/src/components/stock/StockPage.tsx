"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs, ToastProvider, useToast } from "@/components/ui/overlays";
import { STALE_TIME } from "@/components/shell/Providers";
import { ApiError } from "@/lib/api/client";
import { getEvents, getIndicators, getPrices, getProfile, stockKeys } from "@/lib/stock/api";
import { toLoad } from "@/lib/stock/load";
import {
  isRedirect,
  type EventsData,
  type IndicatorsData,
  type PricesData,
} from "@/lib/stock/schemas";
import { mergeWarnings, StockBanners } from "./StockBanners";
import { StockHeader } from "./StockHeader";
import { OverviewTab } from "./OverviewTab";
import { AnalysisTab } from "./chart/AnalysisTab";
import { ChartTab } from "./chart/ChartTab";

export const TAB_IDS = [
  "overview",
  "chart",
  "analysis",
  "fundamentals",
  "ownership",
  "peers",
  "prediction",
  "events",
  "data",
] as const;
export type TabId = (typeof TAB_IDS)[number];

const TAB_LABELS: Record<TabId, string> = {
  overview: "Overview",
  chart: "Chart",
  analysis: "Analysis",
  fundamentals: "Fundamentals",
  ownership: "Ownership",
  peers: "Peers",
  prediction: "Prediction",
  events: "Events",
  data: "Data",
};

export function parseTab(v: string | null): TabId {
  return (TAB_IDS as readonly string[]).includes(v ?? "") ? (v as TabId) : "overview";
}

function NotBuilt({ tab }: { tab: string }) {
  return (
    <EmptyState
      message={`The ${tab} tab is not built yet. The Overview tab shows the figures available today.`}
    />
  );
}

function NotFound({ symbol }: { symbol: string }) {
  return (
    <div data-testid="stock-not-found">
      <EmptyState
        message={`No stock with the symbol ${symbol}. Press / to search by company name or exchange symbol.`}
        action={
          <Link
            href="/stocks"
            className="touch-target inline-flex items-center text-body-sm text-accent underline"
          >
            Browse stocks
          </Link>
        }
      />
    </div>
  );
}

function Inner({ symbol }: { symbol: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  const tab = parseTab(params.get("tab"));

  const profileQ = useQuery({
    queryKey: stockKeys.profile(symbol),
    queryFn: () => getProfile(symbol),
    staleTime: STALE_TIME.profile,
    refetchInterval: (q) => {
      const d = q.state.data?.data;
      const b = d && !isRedirect(d) ? d.backfill : null;
      return b && (b.status === "queued" || b.status === "running") ? 5_000 : false;
    },
  });
  const profile = profileQ.data && !isRedirect(profileQ.data.data) ? profileQ.data.data : null;
  const redirect =
    profileQ.data && isRedirect(profileQ.data.data) ? profileQ.data.data.redirect_symbol : null;
  const hasPrices = profile !== null && !profile.flags.no_prices;

  useEffect(() => {
    if (redirect) {
      toast(`${symbol} is now listed as ${redirect}.`);
      router.replace(
        `/stocks/${encodeURIComponent(redirect)}${params.get("tab") ? `?tab=${tab}` : ""}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirect]);

  const pricesQ = useQuery({
    queryKey: stockKeys.prices(symbol, "1Y"),
    queryFn: () => getPrices(symbol, "1Y"),
    staleTime: STALE_TIME.prices,
    enabled: hasPrices,
  });
  const indicatorsQ = useQuery({
    queryKey: stockKeys.indicators(symbol),
    queryFn: () => getIndicators(symbol),
    staleTime: STALE_TIME.analysis,
    enabled: hasPrices,
  });
  const eventsQ = useQuery({
    queryKey: stockKeys.events(symbol),
    queryFn: () => getEvents(symbol),
    staleTime: STALE_TIME.shareholding,
    enabled: profile !== null,
  });

  if (profileQ.isPending || redirect) {
    return (
      <div className="flex flex-col gap-3" data-testid="stock-loading" aria-busy="true">
        <Skeleton className="h-10 w-1/2" label="Loading stock" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (profileQ.isError) {
    const e = profileQ.error;
    if (e instanceof ApiError && e.status === 404) return <NotFound symbol={symbol} />;
    return (
      <Card
        title={symbol}
        testId="stock-error"
        state="error"
        message={`${e instanceof ApiError ? e.message : "The stock could not be loaded."}${e instanceof ApiError && e.requestId ? ` (request ${e.requestId})` : ""}`}
        onRetry={() => void profileQ.refetch()}
      />
    );
  }
  if (!profile) return <NotFound symbol={symbol} />;

  const pricesLoad = hasPrices
    ? toLoad<PricesData>(pricesQ)
    : ({ state: "unavailable", reason: "no prices imported for this stock" } as const);
  const indicatorsLoad = hasPrices
    ? toLoad<IndicatorsData>(indicatorsQ)
    : ({ state: "unavailable", reason: "no prices imported for this stock" } as const);
  const eventsLoad = toLoad<EventsData>(eventsQ);
  const bars = pricesLoad.state === "ready" ? pricesLoad.data.bars : null;
  const indicators = indicatorsLoad.state === "ready" ? indicatorsLoad.data : null;
  const warnings = mergeWarnings([
    profileQ.data?.warnings ?? [],
    pricesQ.data?.warnings ?? [],
    indicatorsQ.data?.warnings ?? [],
    eventsQ.data?.warnings ?? [],
  ]);
  const backfill = profile.backfill;

  const setTab = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", id);
    router.replace(`/stocks/${encodeURIComponent(symbol)}?${next.toString()}`, { scroll: false });
  };

  const noPricesEmpty = (
    <div data-testid="no-prices">
      <EmptyState
        message={profile.hint ?? `Import prices.csv for ${profile.symbol}.`}
        action={
          <Link
            href="/imports"
            data-testid="no-prices-import"
            className="touch-target inline-flex items-center text-body-sm text-accent underline"
          >
            Import prices
          </Link>
        }
      />
    </div>
  );
  const overview = profile.flags.no_prices ? (
    noPricesEmpty
  ) : (
    <OverviewTab
      profile={profile}
      bars={bars}
      pricesLoad={pricesLoad}
      indicatorsLoad={indicatorsLoad}
      eventsLoad={eventsLoad}
    />
  );
  const tabContent = (id: TabId) => {
    if (id === "overview") return overview;
    if (id === "chart" || id === "analysis") {
      if (profile.flags.no_prices) return noPricesEmpty;
      return id === "chart" ? (
        <ChartTab profile={profile} indicatorsLoad={indicatorsLoad} pageWarnings={warnings} />
      ) : (
        <AnalysisTab indicatorsLoad={indicatorsLoad} />
      );
    }
    return <NotBuilt tab={TAB_LABELS[id]} />;
  };

  return (
    <div className="flex flex-col gap-4" data-testid="stock-page">
      <StockHeader
        profile={profile}
        bars={bars}
        indicators={indicators}
        onRefreshed={() => void qc.invalidateQueries({ queryKey: ["stocks", symbol] })}
      />
      {backfill && (backfill.status === "queued" || backfill.status === "running") ? (
        <Card title="Loading price history" testId="backfill-card">
          <Banner tone="info" testId="backfill-banner">
            Price history is being loaded ({backfill.status}). This page refreshes by itself.
          </Banner>
        </Card>
      ) : null}
      <StockBanners
        profile={profile}
        warnings={warnings}
        bars={bars}
        confirmedMarkers={pricesLoad.state === "ready" ? pricesLoad.data.actions : []}
        eventActions={eventsLoad.state === "ready" ? eventsLoad.data.actions : null}
      />
      <Tabs
        label="Stock sections"
        value={tab}
        onChange={setTab}
        tabs={TAB_IDS.map((id) => ({
          id,
          label: TAB_LABELS[id],
          content: tabContent(id),
        }))}
      />
    </div>
  );
}

export function StockPage({ symbol }: { symbol: string }) {
  return (
    <ToastProvider>
      <Inner symbol={symbol} />
    </ToastProvider>
  );
}
