import { ExperimentalBanner } from "@/components/ui/banners";

/** Shown when the API sends no (or a blank) disclaimer; the banner is never hidden. */
export const DEFAULT_DISCLAIMER =
  "Experimental. Not investment advice. Statistical models often fail out of sample.";

/**
 * The experimental banner and the disclaimer. Not lazy: StockPage renders it while the Prediction
 * chunk loads, so the tab is never shown without them. A blank disclaimer falls back to the constant.
 */
export function PredictionHead({ disclaimer }: { disclaimer?: string | null }) {
  const text = (disclaimer ?? "").trim() || DEFAULT_DISCLAIMER;
  return (
    <div className="flex flex-col gap-2" data-testid="pred-head">
      <ExperimentalBanner />
      <p data-testid="pred-disclaimer" className="text-body-sm text-text-1">
        {text}
      </p>
    </div>
  );
}
