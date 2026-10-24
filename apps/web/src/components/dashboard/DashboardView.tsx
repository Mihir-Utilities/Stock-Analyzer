"use client";

import { AlertsCard, UpcomingEventsCard } from "./ActivityCards";
import { HealthStrip } from "./HealthStrip";
import { IndexTilesCard, MarketStatusCard } from "./MarketCards";
import { PortfolioCard } from "./PortfolioCard";
import { MoversCard, WatchlistHeatCard } from "./WatchlistCards";

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
        <UpcomingEventsCard />
      </div>
      <PortfolioCard />
      <HealthStrip />
    </div>
  );
}
