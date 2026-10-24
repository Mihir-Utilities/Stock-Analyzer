/** Position of `value` in [low, high] as 0-100, or null when it cannot be computed. */
export function rangePosition(
  low: number | null,
  high: number | null,
  value: number | null,
): number | null {
  if (low === null || high === null || value === null) return null;
  if (![low, high, value].every(Number.isFinite) || high <= low) return null;
  return Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
}

/**
 * 52-week low/high with a marker and an optional percentile tick. Labels are pre-formatted by
 * format.ts. Unknown inputs show the reason, never a bar at 0.
 */
export function RangeBar({
  label = "52-week range",
  low,
  high,
  value,
  lowText,
  highText,
  valueText,
  percentile,
  percentileText,
  nullReason = "Range not available",
}: {
  label?: string;
  low: number | null;
  high: number | null;
  value: number | null;
  lowText: string | null;
  highText: string | null;
  valueText: string | null;
  /** 0-100. */
  percentile?: number | null;
  percentileText?: string;
  nullReason?: string;
}) {
  const pos = rangePosition(low, high, value);
  if (pos === null) {
    return (
      <div data-testid="range-bar-null" className="text-body-sm text-text-2">
        {label}: {"—"} {nullReason}
      </div>
    );
  }
  const pct =
    percentile !== undefined && percentile !== null && Number.isFinite(percentile)
      ? Math.min(100, Math.max(0, percentile))
      : null;
  return (
    <div data-testid="range-bar" className="flex flex-col gap-1">
      <div className="text-caption text-text-2">{label}</div>
      <div
        role="img"
        aria-label={`${label}: low ${lowText ?? ""}, high ${highText ?? ""}, current ${valueText ?? ""}`}
        className="relative h-2 rounded-chip bg-surface-3"
      >
        {pct !== null ? (
          <span
            data-testid="range-bar-percentile"
            title={percentileText}
            className="absolute -top-1 h-4 w-px bg-text-2"
            style={{ left: `${pct}%` }}
          />
        ) : null}
        <span
          data-testid="range-bar-marker"
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-chip border-2 border-surface-1 bg-accent"
          style={{ left: `${pos}%` }}
        />
      </div>
      <div className="num flex justify-between text-caption text-text-2">
        <span>Low {lowText}</span>
        <span className="text-text-1">{valueText}</span>
        <span>High {highText}</span>
      </div>
    </div>
  );
}
