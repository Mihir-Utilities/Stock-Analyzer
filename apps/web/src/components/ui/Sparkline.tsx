import { cx } from "./cx";

/** Points of the polyline (finite values only; nulls leave a gap by being skipped). */
export function sparklinePoints(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  pad = 3,
): Array<{ x: number; y: number }> {
  const finite = values.flatMap((v, i) => (v !== null && Number.isFinite(v) ? [{ v, i }] : []));
  if (finite.length < 2) return [];
  const min = Math.min(...finite.map((p) => p.v));
  const max = Math.max(...finite.map((p) => p.v));
  const span = max - min || 1;
  const last = Math.max(values.length - 1, 1);
  return finite.map(({ v, i }) => ({
    x: pad + (i / last) * (width - 2 * pad),
    y: max === min ? height / 2 : height - pad - ((v - min) / span) * (height - 2 * pad),
  }));
}

/**
 * Tiny line/area with a last-point dot. Fewer than 2 finite values renders "n/a" (never a flat
 * zero line). `label` is the accessible description, e.g. "Close, last 30 sessions".
 */
export function Sparkline({
  values,
  label,
  width = 96,
  height = 28,
  area = false,
  className,
}: {
  values: ReadonlyArray<number | null>;
  label: string;
  width?: number;
  height?: number;
  area?: boolean;
  className?: string;
}) {
  const pts = sparklinePoints(values, width, height);
  if (pts.length < 2) {
    return (
      <span data-testid="sparkline-empty" className="text-caption text-text-2" title={label}>
        n/a
      </span>
    );
  }
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return null;
  return (
    <svg
      data-testid="sparkline"
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cx("inline-block align-middle", className)}
    >
      {area ? (
        <polygon
          points={`${first.x},${height} ${line} ${last.x},${height}`}
          className="fill-accent-weak"
        />
      ) : null}
      <polyline points={line} fill="none" strokeWidth={1.5} className="stroke-accent" />
      <circle cx={last.x} cy={last.y} r={2.5} className="fill-accent" />
    </svg>
  );
}
