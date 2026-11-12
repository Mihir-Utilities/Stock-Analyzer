import { beforeAll } from "vitest";

// Pages split their heavy sections with next/dynamic (route budget, docs/06a section 10). The first
// import of a module in a worker is transformed on demand, which can exceed the default 1 s
// findBy* timeout. Tests that render such a page call one of these in `beforeAll`, so the modules
// are already loaded and the default async timeout stays in force (F15R-S8).

export async function preloadPortfolioSections(): Promise<void> {
  await Promise.all([
    import("@/components/portfolio/ChartsSection"),
    import("@/components/portfolio/AdjustmentsPanel"),
    import("@/components/portfolio/HoldingsSection"),
    import("@/components/portfolio/TxnSection"),
    import("@/components/portfolio/MfHoldingsSection"),
    import("@/components/portfolio/MfChartsSection"),
    import("@/components/portfolio/MfTxnSection"),
    import("@/components/portfolio/RiskSection"),
  ]);
}

export async function preloadStockTabs(): Promise<void> {
  await Promise.all([
    import("@/components/stock/chart/AnalysisTab"),
    import("@/components/stock/fundamentals/FundamentalsTab"),
    import("@/components/stock/data/DataTab"),
    import("@/components/stock/events/EventsTab"),
    import("@/components/stock/ownership/OwnershipTab"),
    import("@/components/stock/peers/PeersTab"),
  ]);
}

/** Vitest `beforeAll` timeout for the preloads above (cold transform of many modules). */
export const PRELOAD_TIMEOUT_MS = 60_000;

/** Call once at the top level of a test file: loads the lazy modules before its first test. */
export function preloadBeforeAll(kind: "portfolio" | "stock"): void {
  beforeAll(kind === "portfolio" ? preloadPortfolioSections : preloadStockTabs, PRELOAD_TIMEOUT_MS);
}
