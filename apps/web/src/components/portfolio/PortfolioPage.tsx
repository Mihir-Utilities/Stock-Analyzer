"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { cx } from "@/components/ui/cx";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs, ToastProvider } from "@/components/ui/overlays";
import { describeError, asOfText } from "@/lib/dashboard/state";
import { usePortfolioView } from "@/lib/portfolio/mf-api";
import { readView, type ReadView, type ViewSummary } from "@/lib/portfolio/mf-schemas";
import { useViewParam, VIEW_LABEL, type PortfolioView } from "@/lib/portfolio/view";
import { WarningBanners } from "./SummarySection";
import { ViewCards } from "./ViewCards";
import { ViewSwitcher } from "./ViewSwitcher";
import {
  ALL_VIEW_SOURCE,
  inr,
  MANUAL_PRICE_NOTE,
  MF_VIEW_SOURCE,
  NO_MF_TXNS_COPY,
  PORTFOLIO_SOURCE,
} from "./text";

// Charts, the transaction forms, MF holdings and adjustments load on demand (250 kB gzip route
// budget, docs/06a section 10). Each section shows a skeleton while its chunk loads, and the imports
// start when the page mounts (not when the summary arrives), so the chunks load in parallel with the
// API call.
const loadCharts = () => import("./ChartsSection");
const loadMfCharts = () => import("./MfChartsSection");
const loadAdjustments = () => import("./AdjustmentsPanel");
const loadHoldings = () => import("./HoldingsSection");
const loadMfHoldings = () => import("./MfHoldingsSection");
const loadTxn = () => import("./TxnSection");
const loadMfTxn = () => import("./MfTxnSection");
const loadRisk = () => import("./RiskSection");
const sectionLoading = () => <Skeleton className="h-40 w-full" label="Loading section" />;
const ChartsSection = dynamic(() => loadCharts().then((m) => m.ChartsSection), {
  loading: sectionLoading,
});
const MfChartsSection = dynamic(() => loadMfCharts().then((m) => m.MfChartsSection), {
  loading: sectionLoading,
});
const DividendsCard = dynamic(() => loadAdjustments().then((m) => m.DividendsCard), {
  loading: sectionLoading,
});
const AdjustmentsPanel = dynamic(() => loadAdjustments().then((m) => m.AdjustmentsPanel), {
  loading: sectionLoading,
});
const HoldingsSection = dynamic(() => loadHoldings().then((m) => m.HoldingsSection), {
  loading: sectionLoading,
});
const MfHoldingsSection = dynamic(() => loadMfHoldings().then((m) => m.MfHoldingsSection), {
  loading: sectionLoading,
});
const TxnSection = dynamic(() => loadTxn().then((m) => m.TxnSection), {
  loading: sectionLoading,
});
const MfTxnSection = dynamic(() => loadMfTxn().then((m) => m.MfTxnSection), {
  loading: sectionLoading,
});
const RiskSection = dynamic(() => loadRisk().then((m) => m.RiskSection), {
  loading: sectionLoading,
});

/**
 * Portfolio risk (docs/06 6.7b) loads its chunk and its data only when it is near the viewport, so the
 * route stays inside its bundle budget and the summary is not slowed by the extra read. Where there is
 * no IntersectionObserver (tests) it mounts at once.
 */
function RiskGate({ view }: { view: PortfolioView }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near) return;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return (
    <div ref={ref} data-testid="pf-risk-gate">
      {near ? (
        <RiskSection view={view} />
      ) : (
        <Skeleton className="h-40 w-full" label="Portfolio risk loads when you scroll to it" />
      )}
    </div>
  );
}

/** Starts the lazy imports; a failed preload is harmless because dynamic() asks again. */
export function preloadSections(): Promise<unknown> {
  return Promise.all(
    [loadCharts, loadAdjustments, loadHoldings, loadTxn].map((load) =>
      load().catch(() => undefined),
    ),
  );
}

/** Hint card for the asset class that has no transactions yet (docs/06 6.7a empty states). */
function HintCard({ missing }: { missing: "equity" | "mf" }) {
  return (
    <Card
      title={missing === "mf" ? "Mutual funds" : "Stocks"}
      state="empty"
      message={
        missing === "mf"
          ? NO_MF_TXNS_COPY
          : "No stock transactions yet. Add a transaction below, or import your transactions."
      }
      testId="pf-empty-hints"
      actions={
        missing === "mf" ? (
          <Link
            href="/imports?kind=mf_statement"
            data-testid="pf-hint-import-mf"
            className="touch-target inline-flex items-center text-body-sm text-accent underline"
          >
            Import statement
          </Link>
        ) : (
          <Link
            href="/imports"
            data-testid="pf-hint-import-equity"
            className="touch-target inline-flex items-center text-body-sm text-accent underline"
          >
            Import transactions
          </Link>
        )
      }
    />
  );
}

function EmptyMf() {
  return (
    <Card
      title="Mutual funds"
      state="empty"
      message={NO_MF_TXNS_COPY}
      testId="pf-empty-mf"
      source={MF_VIEW_SOURCE}
      actions={
        <>
          <Link
            href="/imports?kind=mf_statement"
            data-testid="pf-empty-import-mf"
            className="touch-target inline-flex h-9 items-center rounded-control border border-accent px-3 text-body-sm"
          >
            Import statement
          </Link>
          <a
            href="#pf-mf-txn-card"
            data-testid="pf-empty-add-mf"
            className="touch-target inline-flex h-9 items-center rounded-control border border-border px-3 text-body-sm"
          >
            Add a transaction
          </a>
        </>
      }
    />
  );
}

function Totals({ label, row }: { label: string; row: ReadView["breakdown"][number] | undefined }) {
  if (!row) return null;
  return (
    <p className="text-caption text-text-2" data-testid={`pf-${label}-totals`}>
      Total: invested {inr(row.invested).text}, value{" "}
      {row.market_value ? inr(row.market_value).text : "unavailable"}, unrealized{" "}
      {inr(row.unrealized_pnl, { signed: true }).text}, realized{" "}
      {inr(row.realized_pnl, { signed: true }).text}.
    </p>
  );
}

function ViewBody({
  s,
  view,
  asOf,
  stale,
  warnings,
  stockExited,
  onStockExited,
  mfExited,
  onMfExited,
}: {
  s: ViewSummary;
  view: PortfolioView;
  asOf: string | null;
  stale: boolean;
  warnings: ReadonlyArray<{ code: string; message: string }>;
  stockExited: boolean;
  onStockExited: (v: boolean) => void;
  mfExited: boolean;
  onMfExited: (v: boolean) => void;
}) {
  const full = useMemo(() => readView(s, view), [s, view]);
  // One request flag decides what the server sends; each table then shows or hides its own exited rows.
  const read = useMemo(
    () => ({
      ...full,
      legacy: {
        ...full.legacy,
        holdings: full.legacy.holdings.filter((h) => stockExited || !h.exited),
      },
      mfHoldings: full.mfHoldings.filter((h) => mfExited || !h.exited),
    }),
    [full, stockExited, mfExited],
  );
  const present = s.asset_classes_present ?? null;
  const hasEq = present === null ? read.legacy.holdings.length > 0 : present.includes("equity");
  const hasMf = present === null ? read.mfHoldings.length > 0 : present.includes("mf");
  const staleNavDate =
    read.mfHoldings
      .filter((h) => h.nav_stale === true && h.nav_date)
      .map((h) => h.nav_date as string)
      .sort()[0] ?? null;

  const mfRow = read.breakdown.find((r) => r.asset_class === "mf");
  const eqRow = read.breakdown.find((r) => r.asset_class === "equity");
  const mfTotals =
    view === "mf"
      ? {
          invested: s.totals.invested,
          market_value: s.totals.market_value,
          market_value_reason: s.totals.market_value_reason,
          unrealized_pnl: s.totals.unrealized_pnl,
          realized_pnl: s.totals.realized_pnl,
          idcw_income: s.totals.idcw_income,
        }
      : {
          invested: mfRow?.invested,
          market_value: mfRow?.market_value,
          market_value_reason: mfRow?.market_value_reason,
          unrealized_pnl: mfRow?.unrealized_pnl,
          realized_pnl: mfRow?.realized_pnl,
          idcw_income: mfRow?.idcw_income,
        };

  // Nothing at all in this view: the card still shows its dashes; the empty copy comes from the sections.
  const nothingMf = view === "mf" && !hasMf && read.mfHoldings.length === 0;
  const showStocks = view !== "mf";
  const showMf = view !== "equity";
  // With nothing at all in All, the stock table shows the existing empty copy.
  const showStockSections = showStocks && (view === "equity" || hasEq || !hasMf);

  return (
    <>
      <WarningBanners warnings={warnings} />
      {nothingMf ? (
        <EmptyMf />
      ) : (
        <ViewCards
          s={s}
          read={read}
          view={view}
          asOf={asOf}
          stale={stale}
          staleNavDate={staleNavDate}
        />
      )}
      {view === "all" && !hasMf ? <HintCard missing="mf" /> : null}
      {view === "all" && !hasEq && hasMf ? <HintCard missing="equity" /> : null}
      {showStockSections ? (
        <>
          <HoldingsSection
            s={read.legacy}
            asOf={asOf}
            stale={stale}
            showExited={stockExited}
            onShowExited={onStockExited}
          />
          {view === "all" ? <Totals label="stocks" row={eqRow} /> : null}
        </>
      ) : null}
      {showMf && hasMf ? (
        <MfHoldingsSection
          rows={read.mfHoldings}
          totals={mfTotals}
          asOf={asOf}
          includeExited={mfExited}
          onIncludeExited={onMfExited}
          badRows={read.badRows}
        />
      ) : null}
      {showStockSections ? (
        <ChartsSection s={read.legacy} asOf={asOf} view={view === "all" ? "all" : "equity"} />
      ) : null}
      {showMf && hasMf ? (
        <MfChartsSection
          view={view}
          byClass={read.allocClass}
          byScheme={read.allocScheme}
          byCategory={read.allocCategory}
          partial={s.allocation_excludes_unpriced === true}
          asOf={asOf}
        />
      ) : null}
      {showStockSections ? <DividendsCard s={read.legacy} asOf={asOf} /> : null}
    </>
  );
}

function Body({ view }: { view: PortfolioView }) {
  const [stockExited, setStockExited] = useState(false);
  const [mfExited, setMfExited] = useState(false);
  // The server takes one flag; in All it asks for exited rows when either table wants them.
  const includeExited =
    view === "equity" ? stockExited : view === "mf" ? mfExited : stockExited || mfExited;
  const q = usePortfolioView(view, includeExited);

  let top;
  if (q.isPending) {
    top = <Card title="Summary" state="loading" testId="pf-summary" />;
  } else if (q.isError) {
    const u = describeError(q.error, "The portfolio summary");
    top = (
      <Card
        title="Summary"
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        source={
          view === "mf" ? MF_VIEW_SOURCE : view === "all" ? ALL_VIEW_SOURCE : PORTFOLIO_SOURCE
        }
        testId="pf-summary"
      />
    );
  } else {
    const env = q.data;
    const s = env.data;
    const asOf = asOfText(env.meta?.as_of ?? s.as_of);
    // While the next view loads the previous answer stays (no blank flash), dimmed, and it is
    // labelled with the view it is for, never with the one being loaded.
    const shownView = env.forView;
    top = (
      <div
        className={cx("flex flex-col gap-4", q.isPlaceholderData && "opacity-60")}
        data-testid="pf-view-body"
        data-view={shownView}
        aria-busy={q.isPlaceholderData}
      >
        <ViewBody
          s={s}
          view={shownView}
          asOf={asOf}
          stale={env.meta?.stale === true}
          warnings={env.warnings}
          stockExited={stockExited}
          onStockExited={setStockExited}
          mfExited={mfExited}
          onMfExited={setMfExited}
        />
      </div>
    );
  }
  const read = useMemo(() => (q.data ? readView(q.data.data) : null), [q.data]);
  const symbols = read ? read.legacy.holdings.map((h) => h.symbol) : [];
  const mfSchemas = read ? read.mfHoldings : [];
  const stockTxns = <TxnSection symbols={symbols} />;
  const mfTxns = <MfTxnSection schemes={mfSchemas} />;
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        data-testid="pf-updating"
        className={q.isPlaceholderData ? "text-body-sm text-text-2" : "sr-only"}
      >
        {q.isPlaceholderData ? `Updating ${VIEW_LABEL[view]}...` : ""}
      </div>
      {top}
      <RiskGate view={view} />
      {view === "all" ? (
        <Tabs
          label="Transactions"
          tabs={[
            { id: "txns-stock", label: "Stock transactions", content: stockTxns },
            { id: "txns-mf", label: "MF transactions", content: mfTxns },
          ]}
        />
      ) : view === "equity" ? (
        stockTxns
      ) : (
        mfTxns
      )}
      {view !== "mf" ? <AdjustmentsPanel /> : null}
    </>
  );
}

/** Portfolio screen (docs/06 sections 6.7 and 6.7a): All, Equity and Mutual funds views. */
export function PortfolioPage() {
  const [view, setView] = useViewParam();
  useEffect(() => {
    void preloadSections();
  }, []);
  return (
    <ToastProvider>
      <div className="flex flex-col gap-4" data-testid="portfolio-page">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-page font-semibold text-text-1">Portfolio</h1>
          <div className="flex flex-wrap items-center gap-3">
            <ViewSwitcher value={view} onChange={setView} />
            <Link
              href={view === "mf" ? "/imports?kind=mf_statement" : "/imports"}
              data-testid="portfolio-import-link"
              className="touch-target inline-flex items-center text-body-sm text-accent underline"
            >
              {view === "mf" ? "Import MF statement" : "Import transactions"}
            </Link>
          </div>
        </div>
        <p className="text-body-sm text-text-2" data-testid="pf-manual-note">
          {MANUAL_PRICE_NOTE} Values are estimates from your own records, not advice.
        </p>
        <Body view={view} />
      </div>
    </ToastProvider>
  );
}
