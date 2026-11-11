import {
  formatCount,
  formatDate,
  formatDateTime,
  formatFraction,
  formatNumber,
} from "@/lib/format";
import type { ModelCard, TrackRecord } from "@/lib/stock/prediction";

function Row({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-t border-border py-1 first:border-t-0">
      <dt className="text-body-sm text-text-2">{label}</dt>
      <dd data-testid={testId} className="num text-body-sm text-text-1">
        {children}
      </dd>
    </div>
  );
}

function brierVerdict(model: number | null | undefined, base: number | null | undefined): string {
  if (typeof model !== "number" || typeof base !== "number") return "";
  if (model < base) return " (better than the baseline; lower is better)";
  if (model > base) return " (worse than the baseline; lower is better)";
  return " (same as the baseline)";
}

/** Out-of-sample numbers of one run (docs/05 10.5). Numbers live here and in tooltips only. */
export function ModelCardView({ model }: { model: ModelCard | null }) {
  if (!model) {
    return (
      <p data-testid="model-card-empty" className="text-body-sm text-text-2">
        No model card for this horizon: no model has been trained for it.
      </p>
    );
  }
  const why = (w: string) => ({ reason: w });
  return (
    <div data-testid="model-card" className="flex flex-col gap-1">
      <dl className="m-0">
        <Row label="Version" testId="model-version">
          {model.version || "not reported"}
        </Row>
        <Row label="Trained" testId="model-trained">
          {formatDateTime(model.trained_at, why("training time not reported")).text}
        </Row>
        <Row label="Out-of-sample AUC (0.5 is a coin toss)" testId="model-auc">
          {formatNumber(model.oos_auc, { decimals: 3, ...why("not reported") }).text}
        </Row>
        <Row label="Out-of-sample Brier score" testId="model-brier">
          {formatNumber(model.oos_brier, { decimals: 4, ...why("not reported") }).text}
          {brierVerdict(model.oos_brier, model.baseline_brier)}
        </Row>
        <Row label="Baseline Brier score (constant base rate)" testId="model-baseline">
          {formatNumber(model.baseline_brier, { decimals: 4, ...why("not reported") }).text}
        </Row>
        <Row label="Walk-forward folds" testId="model-folds">
          {formatCount(model.folds, why("not reported")).text}
        </Row>
        <Row label="Accuracy checks" testId="model-guardrail">
          {model.guardrail_pass
            ? "Passed (the forecast may be shown)"
            : "Not passed (the forecast is hidden)"}
        </Row>
      </dl>
      <p data-testid="model-limits" className="text-caption text-text-2">
        Scores are the average over the last 8 test periods the model had not seen. The calibration
        plot and the AUC for each period are not served by the API yet. The model trains only on
        stocks you track, so delisted stocks are missing (survivorship bias).
      </p>
    </div>
  );
}

/** Live record of the active model (docs/05 10.7): never a rate without a count. */
export function TrackRecordView({ track }: { track: TrackRecord | null }) {
  if (!track) {
    return (
      <p data-testid="track-empty" className="text-body-sm text-text-2">
        No live track record: nothing has been predicted and resolved yet.
      </p>
    );
  }
  if (track.resolved <= 0) {
    return (
      <p data-testid="track-none" className="text-body-sm text-text-2">
        No resolved predictions yet
        {track.since ? ` (tracking since ${formatDate(track.since).text})` : ""}. A forecast
        resolves when its horizon has passed.
        {track.reason ? ` Reason: ${track.reason.replaceAll("_", " ")}.` : ""}
      </p>
    );
  }
  return (
    <dl data-testid="track-record" className="m-0">
      <Row label="Resolved predictions" testId="track-resolved">
        {formatCount(track.resolved).text}
      </Row>
      <Row label="Direction hit rate" testId="track-hit">
        {
          formatFraction(track.direction_hit_rate, {
            decimals: 1,
            reason: "no resolved predictions",
          }).text
        }
      </Row>
      <Row label="80% band coverage (target 80%)" testId="track-coverage">
        {
          formatFraction(track.band_coverage_80, {
            decimals: 1,
            reason: "no resolved predictions",
          }).text
        }
      </Row>
      <Row label="Tracking since" testId="track-since">
        {formatDate(track.since, { reason: "not reported" }).text}
      </Row>
    </dl>
  );
}
