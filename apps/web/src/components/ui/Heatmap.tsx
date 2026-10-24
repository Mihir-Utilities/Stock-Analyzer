import { EmptyState } from "./EmptyState";

export interface HeatCell {
  /** Numeric value (sign decides the diverging side); null = unknown. */
  value: number | null;
  /** Formatted value printed in the cell (second encoding next to colour). */
  text: string | null;
}

// Cells print their value in --text-1, so the strongest tint is capped at 50% of --up/--down over
// --surface-2 to keep the text at 4.5:1 or better in both themes (checked by axe in Playwright).
const MAX_TINT = 50;

/** Diverging colour: --down to neutral (--surface-2) to --up, intensity = |value| / maxAbs. */
export function heatColor(value: number | null, maxAbs: number): string | undefined {
  if (value === null || !Number.isFinite(value) || !(maxAbs > 0)) return undefined;
  const pct = Math.round(Math.min(1, Math.abs(value) / maxAbs) * MAX_TINT);
  const side = value >= 0 ? "var(--up)" : "var(--down)";
  return `color-mix(in srgb, ${side} ${pct}%, var(--surface-2))`;
}

const LEGEND_GRADIENT = `linear-gradient(to right, color-mix(in srgb, var(--down) ${MAX_TINT}%, var(--surface-2)), var(--surface-2), color-mix(in srgb, var(--up) ${MAX_TINT}%, var(--surface-2)))`;

/**
 * Month x year (or any rows x columns) matrix with a diverging scale and legend. Every cell
 * prints its value; unknown cells print "n/a" with the reason as a tooltip.
 */
export function Heatmap({
  label,
  rows,
  columns,
  cells,
  maxAbs,
  legend,
  nullReason = "No data",
}: {
  label: string;
  rows: string[];
  columns: string[];
  cells: HeatCell[][];
  maxAbs: number;
  /** Legend end labels, formatted by the caller, e.g. { negative: "-10%", positive: "+10%" }. */
  legend: { negative: string; positive: string };
  nullReason?: string;
}) {
  if (rows.length === 0 || columns.length === 0) {
    return <EmptyState message="Not enough history for this view." />;
  }
  return (
    <div data-testid="heatmap" className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table aria-label={label} className="border-separate border-spacing-0.5 text-caption">
          <thead>
            <tr>
              <td />
              {columns.map((c) => (
                <th key={c} scope="col" className="px-2 py-1 font-medium text-text-2">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r}>
                <th scope="row" className="px-2 py-1 text-left font-medium text-text-2">
                  {r}
                </th>
                {columns.map((c, ci) => {
                  const cell = cells[ri]?.[ci];
                  const known =
                    cell !== undefined &&
                    cell.value !== null &&
                    Number.isFinite(cell.value) &&
                    cell.text !== null;
                  return (
                    <td
                      key={c}
                      data-testid="heat-cell"
                      title={known ? undefined : nullReason}
                      className="num min-w-12 rounded-control px-2 py-1 text-center text-text-1"
                      style={{ backgroundColor: known ? heatColor(cell.value, maxAbs) : undefined }}
                    >
                      {known ? cell.text : "n/a"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        data-testid="heat-legend"
        className="flex items-center gap-2 text-micro text-text-2"
        aria-label={`Scale from ${legend.negative} to ${legend.positive}`}
      >
        <span>{legend.negative}</span>
        <span
          aria-hidden="true"
          className="h-2 w-32 rounded-chip"
          style={{ background: LEGEND_GRADIENT }}
        />
        <span>{legend.positive}</span>
      </div>
    </div>
  );
}
