"use client";

import dynamic from "next/dynamic";
import { Card } from "@/components/ui/Card";
import { AlertsCard, UpcomingEventsCard } from "./ActivityCards";
import { HealthStrip } from "./HealthStrip";
import { IndexTilesCard, MarketStatusCard } from "./MarketCards";
import { PortfolioCard } from "./PortfolioCard";
import { MoversCard, WatchlistHeatCard } from "./WatchlistCards";

// The tile loads on demand; its own loading card shows meanwhile (docs/06a section 10).
const SeasonalityCard = dynamic(() => import("./SeasonalityCard").then((m) => m.SeasonalityCard), {
  loading: () => (
    <Card title="This month, across the years" state="loading" testId="dash-seasonality" />
  ),
});

/** Dashboard layout (docs/06 section 6.2). Every card owns its loading/empty/error states. */
export function DashboardView() {
  return (
    <div className="flex flex-col gap-4">
      <h1 data-testid="dashboard-title" className="text-page font-semibold text-text-1">
        Dashboard
      </h1>
      <h2 className="sr-only">Overview</h2>
      <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <IndexTilesCard />
        <MarketStatusCard />
        <AlertsCard />
        <WatchlistHeatCard />
        <MoversCard />
        <div className="min-w-0 md:col-span-2">
          <SeasonalityCard />
        </div>
        <UpcomingEventsCard />
      </div>
      <PortfolioCard />
      <HealthStrip />
    </div>
  );
}
