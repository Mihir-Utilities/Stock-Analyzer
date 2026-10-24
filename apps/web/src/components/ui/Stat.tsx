import type { ReactNode } from "react";
import { DeltaBadge } from "./DeltaBadge";
import { InfoPopover } from "./overlays";

export interface StatProps {
  label: string;
  /** Already formatted by format.ts; null means unknown and shows the reason instead. */
  value: string | null;
  unit?: string;
  delta?: { value: number | null; text: string | null };
  /** Formula or definition (from definitions.ts) shown in the info popover. */
  definition?: ReactNode;
  source?: string;
  asOf?: string | null;
  /** Shown when value is null. */
  nullReason?: string;
}

/** Label, tabular value, delta, unit, definition tooltip, source and as-of (docs/06a section 4). */
export function Stat({
  label,
  value,
  unit,
  delta,
  definition,
  source,
  asOf,
  nullReason,
}: StatProps) {
  const known = value !== null;
  return (
    <div data-testid="stat" className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1 text-caption text-text-2">
        <span>{label}</span>
        {definition ? <InfoPopover label={`About ${label}`}>{definition}</InfoPopover> : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        {known ? (
          <span data-testid="stat-value" className="num text-section font-semibold text-text-1">
            {value}
            {unit ? (
              <span className="ml-1 text-body-sm font-normal text-text-2">{unit}</span>
            ) : null}
          </span>
        ) : (
          <span data-testid="stat-null" className="text-body-sm text-text-2">
            {"—"} {nullReason ?? "Not available"}
          </span>
        )}
        {known && delta ? <DeltaBadge value={delta.value} text={delta.text} /> : null}
      </div>
      {source || asOf !== undefined ? (
        <div className="text-micro text-text-2">
          {source ? `Source: ${source}` : null}
          {source && asOf !== undefined ? " | " : null}
          {asOf !== undefined ? (asOf === null ? "As of: unknown" : `As of ${asOf}`) : null}
        </div>
      ) : null}
    </div>
  );
}
