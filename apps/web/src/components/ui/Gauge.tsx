import { cx } from "./cx";

export interface GaugeBand {
  from: number;
  to: number;
  label: string;
  tone: "up" | "warn" | "down" | "info";
}

const R = 60;
const CX = 80;
const CY = 76;

function polar(value: number): { x: number; y: number } {
  const a = Math.PI * (1 - value / 100);
  return { x: CX + R * Math.cos(a), y: CY - R * Math.sin(a) };
}

function arc(from: number, to: number): string {
  const s = polar(from);
  const e = polar(to);
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 0 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

const strokeClass = {
  up: "stroke-up",
  warn: "stroke-warn",
  down: "stroke-down",
  info: "stroke-info",
} as const;

/**
 * Semi-circle 0-100 with labelled bands. The active band's label and the number are printed, so
 * colour is not the only signal. `value` null shows the reason, never 0.
 */
export function Gauge({
  label,
  value,
  valueText,
  bands,
  nullReason = "Not available",
}: {
  label: string;
  value: number | null;
  /** Value already formatted by format.ts. */
  valueText: string | null;
  bands: GaugeBand[];
  nullReason?: string;
}) {
  const known = value !== null && Number.isFinite(value);
  const clamped = known ? Math.min(100, Math.max(0, value)) : 0;
  const active = known ? bands.find((b) => clamped >= b.from && clamped <= b.to) : undefined;
  const needle = polar(clamped);
  return (
    <figure data-testid="gauge" className="m-0 flex flex-col items-center">
      <svg
        viewBox="0 0 160 90"
        role="img"
        aria-label={
          known
            ? `${label}: ${valueText ?? ""}${active ? `, ${active.label}` : ""}`
            : `${label}: ${nullReason}`
        }
        className="w-40"
      >
        {bands.map((b) => (
          <path
            key={b.label}
            d={arc(b.from, b.to)}
            fill="none"
            strokeWidth={10}
            className={cx(strokeClass[b.tone], known && b !== active && "opacity-40")}
          />
        ))}
        {known ? (
          <>
            <line
              x1={CX}
              y1={CY}
              x2={needle.x}
              y2={needle.y}
              strokeWidth={2}
              className="stroke-text-1"
            />
            <circle cx={CX} cy={CY} r={3} className="fill-text-1" />
          </>
        ) : null}
      </svg>
      <figcaption className="text-center">
        <div className="text-caption text-text-2">{label}</div>
        {known ? (
          <div data-testid="gauge-value" className="num text-lead font-semibold text-text-1">
            {valueText}
            {active ? (
              <span data-testid="gauge-band" className="ml-2 text-body-sm font-normal text-text-2">
                {active.label}
              </span>
            ) : null}
          </div>
        ) : (
          <div data-testid="gauge-null" className="text-body-sm text-text-2">
            {"—"} {nullReason}
          </div>
        )}
        <ul className="mt-1 flex flex-wrap justify-center gap-x-3 text-micro text-text-2">
          {bands.map((b) => (
            <li key={b.label}>
              {b.label} {b.from}-{b.to}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
