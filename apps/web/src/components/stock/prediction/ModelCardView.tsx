import {
  formatCount,
  formatDate,
  formatDateTime,
  formatFraction,
  formatNumber,
} from "@/lib/format";
import { AsOfChip, SourceChip } from "@/components/ui/chips";
import {
  isUnreadable,
  UNREADABLE_COPY,
  type ModelCard,
  type TrackRecord,
  type Unreadable,
} from "@/lib/stock/prediction";

/** Source and as-of of one block (every block names both, or says the as-of is not served). */
export function Provenance({ source, asOf }: { source: string; asOf: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="pred-provenance">
      <SourceChip source={source} />
      <AsOfChip asOf={asOf ?? "not served"} />
    </div>
  );
}

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
export function ModelCardView({ model }: { model: ModelCard | null | Unreadable }) {
  if (isUnreadable(model)) {
    return (
      <p data-testid="model-card-unreadable" className="text-body-sm text-text-1">
        {UNREADABLE_COPY}: the model card could not be read, so nothing is claimed about the model.
      </p>
    );
  }
  if (!model) {
    return (
      <p data-testid="model-card-empty" className="text-body-sm text-text-2">
        No model card is served for this horizon.
      </p>
    );
  }
  const why = (w: string) => ({ reason: w });
  return (
    <div data-testid="model-card" className="flex flex-col gap-1">
      <Provenance
        source="model run (out-of-fold validation)"
        asOf={model.trained_at ? formatDateTime(model.trained_at).text : null}
      />
      <dl className="m-0">
        <Row label="Version" testId="model-version">
          {model.version?.trim() || "not reported"}
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
        Scores are the average over the walk-forward test periods the model had not seen. The
        calibration plot and the AUC of each test period are not shown yet: that is an open decision
        for the owner (F09-1 in docs/OPEN_QUESTIONS.md). The model trains only on stocks you track,
        so delisted stocks are missing (survivorship bias).
      </p>
    </div>
  );
}

/** Live record of the active model (docs/05 10.7): never a rate without a count. */
export function TrackRecordView({ track }: { track: TrackRecord | null | Unreadable }) {
  if (isUnreadable(track)) {
    return (
      <p data-testid="track-unreadable" className="text-body-sm text-text-1">
        {UNREADABLE_COPY}: the live track record could not be read, so no count or rate is shown.
      </p>
    );
  }
  if (!track) {
    return (
      <p data-testid="track-empty" className="text-body-sm text-text-2">
        No live track record is served for this horizon.
      </p>
    );
  }
  const provenance = (
    <Provenance source="live predictions resolved against later closes" asOf={null} />
  );
  if (track.resolved <= 0) {
    return (
      <div className="flex flex-col gap-1">
        {provenance}
        <p data-testid="track-none" className="text-body-sm text-text-2">
          No resolved predictions yet
          {track.since ? ` (tracking since ${formatDate(track.since).text})` : ""}. A forecast
          resolves when its horizon has passed.
          {track.reason ? ` Reason: ${track.reason.replaceAll("_", " ")}.` : ""}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {provenance}
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
    </div>
  );
}
