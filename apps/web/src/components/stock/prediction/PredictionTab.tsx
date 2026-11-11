"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { AsOfChip, SourceChip } from "@/components/ui/chips";
import { Gauge, type GaugeBand } from "@/components/ui/Gauge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate, formatFraction, formatInr, formatNumber } from "@/lib/format";
import { humanReason } from "@/lib/stock/derive";
import { RISK_BANDS, TREND_BANDS } from "@/lib/stock/gauge-bands";
import { toLoad } from "@/lib/stock/load";
import {
  bucketText,
  fanDataset,
  getPrediction,
  hiddenReasonText,
  HORIZON_UNREADABLE_COPY,
  horizonLabel,
  horizonList,
  horizonStatus,
  isUnreadable,
  noCardText,
  predictionKey,
  stateText,
  trackDataset,
  UNREADABLE_COPY,
  usableBand,
  cardsOf,
  type Horizon,
  type ModelCard,
  type PredictionData,
  type ScoreLabel,
  type TrackRecord,
  type Unreadable,
} from "@/lib/stock/prediction";
import { ModelCardView, Provenance, TrackRecordView } from "./ModelCardView";
import { PredictionHead } from "./PredictionHead";

function ScoreGauge({
  testId,
  label,
  s,
  bands,
}: {
  testId: string;
  label: string;
  s: ScoreLabel | null | Unreadable;
  bands: GaugeBand[];
}) {
  if (isUnreadable(s)) {
    return (
      <p data-testid={`${testId}-unreadable`} className="text-body-sm text-text-1">
        {label}: {UNREADABLE_COPY}.
      </p>
    );
  }
  const v = typeof s?.score === "number" && Number.isFinite(s.score) ? s.score : null;
  return (
    <div className="flex flex-col items-center gap-1" data-testid={testId}>
      <Gauge
        label={label}
        value={v}
        valueText={formatNumber(v, { decimals: 0 }).text}
        bands={bands}
        nullReason={humanReason(s?.reason ?? "not_computed")}
      />
    </div>
  );
}

function HorizonCard({
  h,
  index,
  refClose,
  symbol,
}: {
  h: Horizon;
  index: number;
  refClose: number | null;
  symbol: string;
}) {
  const status = horizonStatus(h);
  const band = usableBand(h);
  const near = status === "hidden" && h.hidden_reason === "near_corporate_action";
  return (
    <section
      data-testid={`pred-horizon-${h.days}`}
      data-shown={status === "shown" ? "true" : "false"}
      aria-labelledby={`pred-h-${index}`}
      className="flex flex-col gap-2 rounded-card border border-exp bg-surface-2 p-3"
    >
      <h3 id={`pred-h-${index}`} className="text-body font-semibold text-text-1">
        {horizonLabel(h.days)}
      </h3>
      {status === "shown" && band ? (
        <>
          <p data-testid={`pred-bucket-${h.days}`} className="text-lead text-text-1">
            {bucketText(h.bucket)}
          </p>
          <p className="text-caption text-text-2">
            An experimental probability, not a price. Hover the chart for the range.
          </p>
          <details data-testid={`pred-numbers-${h.days}`} className="text-body-sm text-text-2">
            <summary
              data-testid={`pred-numbers-toggle-${h.days}`}
              className="touch-target cursor-pointer text-accent"
            >
              Show the numbers
            </summary>
            <ul className="mt-1 list-disc pl-5">
              <li>
                Probability the close is higher after {h.days} trading days:{" "}
                {
                  formatFraction(isUnreadable(h.p_up) ? null : h.p_up, {
                    decimals: 1,
                    reason: "not reported",
                  }).text
                }
              </li>
              <li>
                80% range of the change:{" "}
                {formatFraction(band.q10, { decimals: 1, signed: true }).text} to{" "}
                {formatFraction(band.q90, { decimals: 1, signed: true }).text}
              </li>
              {band.priceQ10 !== null && band.priceQ90 !== null ? (
                <li>
                  As a price range: {formatInr(band.priceQ10).text} to{" "}
                  {formatInr(band.priceQ90).text}
                  {refClose !== null
                    ? `(from a reference close of ${formatInr(refClose).text})`
                    : ""}
                </li>
              ) : null}
            </ul>
          </details>
        </>
      ) : status === "unreadable" ? (
        <p data-testid={`pred-unreadable-${h.days}`} className="text-body-sm text-text-1">
          <span className="font-medium">Forecast not shown. </span>
          {HORIZON_UNREADABLE_COPY}
        </p>
      ) : (
        <p data-testid={`pred-hidden-${h.days}`} className="text-body-sm text-text-1">
          <span className="font-medium">Forecast hidden. </span>
          {hiddenReasonText(h.hidden_reason)}
          {near ? (
            <>
              {" "}
              <Link
                href={`/stocks/${encodeURIComponent(symbol)}?tab=events`}
                data-testid={`pred-events-link-${h.days}`}
                className="touch-target inline-flex items-center text-accent underline"
              >
                Review corporate actions on the Events tab
              </Link>
            </>
          ) : null}
        </p>
      )}
    </section>
  );
}

function HowToRead() {
  return (
    <section aria-labelledby="pred-how-h" data-testid="pred-how" className="flex flex-col gap-1">
      <h3 id="pred-how-h" className="text-body font-semibold text-text-1">
        How to read this
      </h3>
      <ul className="list-disc pl-5 text-body-sm text-text-2">
        <li>
          Each horizon says which way the model leans and how wide the likely range is. It never
          gives one price: the range is where 8 out of 10 outcomes are expected to fall.
        </li>
        <li>
          A forecast is shown only when the model beat a simple baseline in walk-forward testing and
          its live record still holds up. Otherwise the reason is shown and no numbers.
        </li>
        <li>
          The track record compares past forecasts with what really happened. A hit rate near
          chance, or coverage far from 80%, means the model is not to be trusted.
        </li>
        <li>
          Trend and risk are rule-based scores, not machine learning. Risk is relative to the stocks
          tracked here. The model learns only from the stocks you imported, so it ignores delisted
          companies (survivorship bias).
        </li>
      </ul>
    </section>
  );
}

function Body({
  d,
  symbol,
  stale,
  asOfFallback,
  asOfReason,
  warnings,
}: {
  d: PredictionData;
  symbol: string;
  stale: boolean;
  asOfFallback: string | null;
  asOfReason: string | null;
  warnings: ReadonlyArray<{ code: string; message: string }>;
}) {
  const hs = horizonList(d);
  const anyRange = hs.some((h) => usableBand(h) !== null);
  // The response timestamp (meta.as_of) stands in only for a forecast that exists.
  const asOfRaw = d.as_of ?? (anyRange ? asOfFallback : null);
  const fan = fanDataset(d, asOfRaw);
  const cards = cardsOf(d);
  const asOf = formatDate(asOfRaw, { reason: "no forecast date" });
  const honest = d.state !== "ok";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="pred-meta">
        <SourceChip source="experimental model on your imported prices" />
        <AsOfChip asOf={asOfRaw ? asOf.text : null} stale={stale} />
        {!asOfRaw && asOfReason ? (
          <span className="text-caption text-text-2" data-testid="pred-asof-reason">
            No as-of date: {humanReason(asOfReason)}
          </span>
        ) : null}
        <span className="text-caption text-text-2" data-testid="pred-ref-close">
          {anyRange
            ? "Reference close (where the ranges start): "
            : "Reference close (no range is shown, so nothing starts from it): "}
          {typeof d.ref_close === "number"
            ? formatInr(d.ref_close).text
            : formatInr(null, { reason: humanReason(d.ref_close_reason ?? "no_forecast") }).text}
        </span>
      </div>

      {warnings.map((w, i) => (
        <Banner key={`${w.code}-${i}`} tone="warn" testId={`pred-warning-${i}`}>
          {w.message}
        </Banner>
      ))}

      {honest ? (
        <div
          data-testid="pred-state"
          data-state={d.state ?? "unreadable"}
          className="flex flex-col gap-1"
        >
          <Banner tone="info" testId="pred-state-banner">
            {stateText(d.state)}
            {d.state_reason ? ` (${d.state_reason})` : ""}
          </Banner>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2" data-testid="pred-horizons">
        {isUnreadable(d.horizons) ? (
          <p data-testid="pred-horizons-unreadable" className="text-body-sm text-text-1">
            {UNREADABLE_COPY}: the forecast horizons could not be read, so no forecast is shown.
          </p>
        ) : hs.length === 0 && d.unreadable_horizons === 0 ? (
          <p data-testid="pred-no-horizons" className="text-body-sm text-text-2">
            No forecast horizons were returned.
          </p>
        ) : (
          hs.map((h, i) => (
            <HorizonCard
              key={`${h.days}-${i}`}
              h={h}
              index={i}
              refClose={d.ref_close ?? null}
              symbol={symbol}
            />
          ))
        )}
      </div>
      {d.unreadable_horizons > 0 ? (
        <p data-testid="pred-horizons-skipped" className="text-body-sm text-text-1">
          {d.unreadable_horizons} horizon entr{d.unreadable_horizons === 1 ? "y" : "ies"} could not
          be read and {d.unreadable_horizons === 1 ? "is" : "are"} not shown.
        </p>
      ) : null}

      {fan ? (
        <ChartFrame
          title="Likely range of the change (80%)"
          testId="pred-fan"
          dataset={fan}
          state={stale ? "stale" : "ready"}
          height={260}
          filename="prediction-range"
          info={
            <p>
              Dashed lines in the experimental colour. The outer lines bound the range where 8 of 10
              outcomes are expected; the middle line is the median change. It starts at 0 today
              because it is a change from the reference close. The horizontal axis lists the shown
              horizons as equal steps, not to scale, and hidden horizons are left off.
            </p>
          }
        />
      ) : (
        <p data-testid="pred-no-fan" className="text-body-sm text-text-2">
          No range chart: no horizon has a forecast to draw.
        </p>
      )}

      <section aria-labelledby="pred-gauges-h" className="flex flex-col gap-2">
        <h3 id="pred-gauges-h" className="text-body font-semibold text-text-1">
          Trend and risk (rule-based, not machine learning)
        </h3>
        <Provenance
          source="rule-based scores from your imported prices (analysis snapshot)"
          asOf={null}
        />
        <div className="grid grid-cols-1 gap-4 tablet:grid-cols-2">
          <ScoreGauge testId="pred-trend" label="Trend" s={d.trend} bands={TREND_BANDS} />
          <ScoreGauge
            testId="pred-risk"
            label="Risk (relative to stocks tracked here)"
            s={d.risk}
            bands={RISK_BANDS}
          />
        </div>
      </section>

      <section aria-labelledby="pred-model-h" className="flex flex-col gap-3">
        <h3 id="pred-model-h" className="text-body font-semibold text-text-1">
          Model card and live track record
        </h3>
        {cards.length === 0 ? (
          <p data-testid="pred-no-model" className="text-body-sm text-text-2">
            {noCardText(d.state)}
          </p>
        ) : (
          cards.map((c, i) => (
            <CardPair
              key={`${c.days ?? "all"}-${i}`}
              days={c.days}
              model={c.model}
              track={c.track}
            />
          ))
        )}
      </section>

      <HowToRead />
      <p className="text-caption text-text-2">
        <Link
          href={`/stocks/${encodeURIComponent(symbol)}?tab=events`}
          data-testid="pred-events-link"
          className="touch-target inline-flex items-center text-accent underline"
        >
          Review corporate actions on the Events tab
        </Link>
      </p>
    </div>
  );
}

function CardPair({
  days,
  model,
  track,
}: {
  days: number | null;
  model: ModelCard | null | Unreadable;
  track: TrackRecord | null | Unreadable;
}) {
  const trackChart = track && !isUnreadable(track) ? trackDataset(track) : null;
  return (
    <div
      data-testid={days === null ? "pred-cards" : `pred-cards-${days}`}
      className="flex flex-col gap-3 rounded-card border border-border p-3"
    >
      <h4 className="text-body-sm font-semibold text-text-1">
        {days === null ? "Model" : `${days}-day model`}
      </h4>
      <ModelCardView model={model} />
      <TrackRecordView track={track} />
      {trackChart ? (
        <ChartFrame
          title="Live track record"
          testId={days === null ? "pred-track-chart" : `pred-track-chart-${days}`}
          dataset={trackChart}
          state="ready"
          height={200}
          filename="prediction-track-record"
        />
      ) : null}
    </div>
  );
}

export function PredictionTab({ symbol }: { symbol: string }) {
  const q = useQuery({
    queryKey: predictionKey(symbol),
    queryFn: () => getPrediction(symbol),
    staleTime: STALE_TIME.analysis,
  });
  const load = toLoad<PredictionData>(q);
  const warnings = q.data?.warnings ?? [];
  const asOfReason = q.data?.meta?.as_of_reason ?? null;
  // The banner and the disclaimer are the first thing on the tab in every state, with no dismiss.
  const head = <PredictionHead disclaimer={load.state === "ready" ? load.data.disclaimer : null} />;
  let body;
  if (load.state === "loading") {
    body = (
      <div data-testid="pred-loading" aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-1/3" label="Loading prediction" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  } else if (load.state === "error") {
    body = (
      <Card
        title="Prediction"
        testId="pred-error"
        state="error"
        message={`${load.message}${load.requestId ? ` (request ${load.requestId})` : ""}`}
        onRetry={load.retry}
      />
    );
  } else if (load.state === "unavailable") {
    body = (
      <Card title="Prediction" testId="pred-unavailable" state="empty" message={load.reason} />
    );
  } else {
    // Stale: meta.stale, or a horizon hidden because its price data is too old.
    const stale =
      load.stale || horizonList(load.data).some((h) => h.hidden_reason === "stale_data");
    body = (
      <Body
        d={load.data}
        symbol={symbol}
        stale={stale}
        asOfFallback={load.asOf}
        asOfReason={asOfReason}
        warnings={warnings}
      />
    );
  }
  return (
    <Card title="Prediction (Experimental)" testId="pred-card">
      <div className="flex flex-col gap-4">
        {head}
        {body}
      </div>
    </Card>
  );
}
