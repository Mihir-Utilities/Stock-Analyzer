"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner, ExperimentalBanner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { AsOfChip, SourceChip } from "@/components/ui/chips";
import { Gauge, type GaugeBand } from "@/components/ui/Gauge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate, formatFraction, formatInr, formatNumber } from "@/lib/format";
import { humanReason } from "@/lib/stock/derive";
import { toLoad } from "@/lib/stock/load";
import {
  bucketText,
  DEFAULT_DISCLAIMER,
  fanDataset,
  getPrediction,
  hiddenReasonText,
  horizonLabel,
  horizonList,
  predictionKey,
  STATE_TEXT,
  trackDataset,
  usableBand,
  cardsOf,
  type Horizon,
  type ModelCard,
  type PredictionData,
  type ScoreLabel,
  type TrackRecord,
} from "@/lib/stock/prediction";
import { ModelCardView, TrackRecordView } from "./ModelCardView";

const TREND_BANDS: GaugeBand[] = [
  { from: 0, to: 20, label: "Strong down", tone: "down" },
  { from: 21, to: 40, label: "Down", tone: "warn" },
  { from: 41, to: 60, label: "Sideways", tone: "info" },
  { from: 61, to: 80, label: "Up", tone: "up" },
  { from: 81, to: 100, label: "Strong up", tone: "up" },
];
const RISK_BANDS: GaugeBand[] = [
  { from: 0, to: 33, label: "Low", tone: "up" },
  { from: 33, to: 66, label: "Medium", tone: "warn" },
  { from: 66, to: 100, label: "High", tone: "down" },
];

function ScoreGauge({
  id,
  label,
  s,
  bands,
}: {
  id: string;
  label: string;
  s: ScoreLabel | null | undefined;
  bands: GaugeBand[];
}) {
  const v = typeof s?.score === "number" && Number.isFinite(s.score) ? s.score : null;
  return (
    <div className="flex flex-col items-center gap-1" data-testid={id}>
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

function HorizonCard({ h, refClose }: { h: Horizon; refClose: number | null }) {
  const band = usableBand(h);
  return (
    <section
      data-testid={`pred-horizon-${h.days}`}
      data-shown={band ? "true" : "false"}
      aria-labelledby={`pred-h-${h.days}`}
      className="flex flex-col gap-2 rounded-card border border-exp bg-surface-2 p-3"
    >
      <h3 id={`pred-h-${h.days}`} className="text-body font-semibold text-text-1">
        {horizonLabel(h.days)}
      </h3>
      {band ? (
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
                {formatFraction(h.p_up, { decimals: 1, reason: "not reported" }).text}
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
                    ? ` (from a reference close of ${formatInr(refClose).text})`
                    : ""}
                </li>
              ) : null}
            </ul>
          </details>
        </>
      ) : (
        <p data-testid={`pred-hidden-${h.days}`} className="text-body-sm text-text-1">
          <span className="font-medium">Forecast hidden. </span>
          {hiddenReasonText(h.hidden_reason)}
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

function Body({ d, symbol, stale }: { d: PredictionData; symbol: string; stale: boolean }) {
  const hs = horizonList(d);
  const fan = fanDataset(d);
  const cards = cardsOf(d);
  const asOf = formatDate(d.as_of, { reason: "no forecast date" });
  const honest = d.state !== "ok";
  const stateCopy = STATE_TEXT[d.state];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="pred-meta">
        <SourceChip source="experimental model on your imported prices" />
        <AsOfChip asOf={d.as_of ? asOf.text : null} stale={stale} />
        <span className="text-caption text-text-2" data-testid="pred-ref-close">
          Reference close (where the ranges start):{" "}
          {typeof d.ref_close === "number"
            ? formatInr(d.ref_close).text
            : formatInr(null, { reason: humanReason(d.ref_close_reason ?? "no_forecast") }).text}
        </span>
      </div>

      {honest ? (
        <div data-testid="pred-state" data-state={d.state} className="flex flex-col gap-1">
          <Banner tone="info" testId="pred-state-banner">
            {stateCopy ?? "No forecast is available for this stock right now."}
            {d.state_reason ? ` (${d.state_reason})` : ""}
          </Banner>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2" data-testid="pred-horizons">
        {hs.length === 0 ? (
          <p data-testid="pred-no-horizons" className="text-body-sm text-text-2">
            No forecast horizons were returned.
          </p>
        ) : (
          hs.map((h) => <HorizonCard key={h.days} h={h} refClose={d.ref_close ?? null} />)
        )}
      </div>

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
              because it is a change from the reference close.
            </p>
          }
        />
      ) : (
        <p data-testid="pred-no-fan" className="text-body-sm text-text-2">
          No range chart: every horizon is hidden, so there is nothing to draw.
        </p>
      )}

      <section aria-labelledby="pred-gauges-h" className="flex flex-col gap-2">
        <h3 id="pred-gauges-h" className="text-body font-semibold text-text-1">
          Trend and risk (rule-based, not machine learning)
        </h3>
        <div className="grid grid-cols-1 gap-4 tablet:grid-cols-2">
          <ScoreGauge id="pred-trend" label="Trend" s={d.trend} bands={TREND_BANDS} />
          <ScoreGauge
            id="pred-risk"
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
            No model card: no model has been trained. There is no track record either, because
            nothing has been predicted.
          </p>
        ) : (
          cards.map((c) => (
            <CardPair key={c.days ?? "all"} days={c.days} model={c.model} track={c.track} />
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
  model: ModelCard | null;
  track: TrackRecord | null;
}) {
  const trackChart = track ? trackDataset(track) : null;
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
  // The banner and the disclaimer are the first thing on the tab in every state, with no dismiss.
  const disclaimer =
    load.state === "ready" ? (load.data.disclaimer ?? DEFAULT_DISCLAIMER) : DEFAULT_DISCLAIMER;
  const head = (
    <div className="flex flex-col gap-2" data-testid="pred-head">
      <ExperimentalBanner />
      <p data-testid="pred-disclaimer" className="text-body-sm text-text-1">
        {disclaimer}
      </p>
    </div>
  );
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
    body = <Body d={load.data} symbol={symbol} stale={load.stale} />;
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
