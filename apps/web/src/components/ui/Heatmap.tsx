import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";

export interface HeatCell {
  /** Numeric value (sign decides the diverging side); null = unknown. */
  value: number | null;
  /** Formatted value printed in the cell (second encoding next to colour). */
  text: string | null;
  /** Visible text next to the value (`MTD`, `YTD`, `partial`): the second encoding of a state. */
  marker?: string;
  /** Tooltip of the marker (also read by assistive tech through a visually hidden sentence). */
  markerTitle?: string;
  /** Outlined cell (the running month). */
  outlined?: boolean;
  /** Why an unknown cell is empty; when set the cell is empty (not "n/a") and the reason is readable. */
  reason?: string | null;
}

/** A summary cell of a footer row (plain number text; the tint is only used by Average and Median). */
export interface FooterCell {
  text: string;
  reason: string | null;
  tint: number | null;
  /** Small sample marker (fewer years than the minimum). */
  small: boolean;
}

export interface FooterRow {
  key: string;
  label: string;
  cells: FooterCell[];
  trailing?: FooterCell;
}

/** A separated last column with its own colour scale (for example the Year column). */
export interface TrailingColumn {
  testId: string;
  header: string;
  headerTitle?: string;
  headerExtra?: ReactNode;
  cells: HeatCell[];
  maxAbs: number;
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

// The first column is pinned left and a trailing column pinned right inside the scroll region
// (docs/06 6.4a); the opaque surface keeps scrolled cells from showing through.
const PIN_LEFT = "sticky left-0 z-10 bg-surface-1";
const PIN_RIGHT = "sticky right-0 z-10 border-l-2 border-border bg-surface-1";

function cellKnown(cell: HeatCell | undefined): cell is HeatCell & { value: number; text: string } {
  return (
    cell !== undefined && cell.value !== null && Number.isFinite(cell.value) && cell.text !== null
  );
}

function Marker({ cell }: { cell: HeatCell }) {
  if (!cell.marker) return null;
  return (
    <span className="ml-1 text-micro text-text-1" title={cell.markerTitle}>
      {cell.marker}
      {cell.markerTitle ? <span className="sr-only">{`: ${cell.markerTitle}`}</span> : null}
    </span>
  );
}

function GridCell({
  cell,
  maxAbs,
  nullReason,
  pinned = false,
}: {
  cell: HeatCell | undefined;
  maxAbs: number;
  nullReason: string;
  pinned?: boolean;
}) {
  const known = cellKnown(cell);
  const outline = cell?.outlined ? " ring-2 ring-inset ring-text-1" : "";
  const base = `num min-w-12 rounded-control px-2 py-1 text-center text-text-1${outline}`;
  if (!known && cell?.reason) {
    // Empty by a documented reason: nothing is drawn, the reason is readable text for screen
    // readers and a tooltip, and the grid footnote lists it for touch.
    return (
      <td
        data-testid="heat-cell"
        data-empty="true"
        title={cell.reason}
        className={`${base} ${pinned ? PIN_RIGHT : ""}`}
      >
        <span className="sr-only">{`No value: ${cell.reason}`}</span>
        <Marker cell={cell} />
      </td>
    );
  }
  return (
    <td
      data-testid="heat-cell"
      title={known ? undefined : nullReason}
      className={`${base} ${pinned ? PIN_RIGHT : ""}`}
      style={{ backgroundColor: known ? heatColor(cell.value, maxAbs) : undefined }}
    >
      {known ? cell.text : "n/a"}
      {cell ? <Marker cell={cell} /> : null}
    </td>
  );
}

function FooterTd({
  cell,
  scale,
  pinned = false,
}: {
  cell: FooterCell;
  scale: number;
  pinned?: boolean;
}) {
  return (
    <td
      data-testid="heat-summary-cell"
      title={cell.reason ?? (cell.small ? "Small sample: fewer years than the minimum" : undefined)}
      className={`num min-w-12 rounded-control px-2 py-1 text-center text-text-1 ${pinned ? PIN_RIGHT : ""}`}
      style={{ backgroundColor: cell.tint !== null ? heatColor(cell.tint, scale) : undefined }}
    >
      {cell.text}
      {cell.small && cell.reason === null ? (
        <span className="text-micro text-text-2">
          {" †"}
          <span className="sr-only"> small sample</span>
        </span>
      ) : null}
      {cell.reason !== null ? <span className="sr-only">{`: ${cell.reason}`}</span> : null}
    </td>
  );
}

/**
 * Month x year (or any rows x columns) matrix with a diverging scale and legend. Every cell
 * prints its value; unknown cells print "n/a" with the reason as a tooltip. Optional (INV, docs/06a
 * section 5): a separated trailing column with its own scale, footer summary rows and per-cell
 * markers (MTD, YTD, partial) printed as text.
 */
export function Heatmap({
  label,
  rows,
  columns,
  cells,
  maxAbs,
  legend,
  nullReason = "No data",
  trailing,
  footerRows,
  footerTestId,
}: {
  label: string;
  rows: string[];
  columns: string[];
  cells: HeatCell[][];
  maxAbs: number;
  /** Legend end labels, formatted by the caller, e.g. { negative: "-10%", positive: "+10%" }. */
  legend: { negative: string; positive: string };
  nullReason?: string;
  trailing?: TrailingColumn;
  footerRows?: FooterRow[];
  footerTestId?: string;
}) {
  if (rows.length === 0 || columns.length === 0) {
    return <EmptyState message="Not enough history for this view." />;
  }
  const rowTh = `px-2 py-1 text-left font-medium text-text-2 ${trailing ? PIN_LEFT : ""}`;
  return (
    <div data-testid="heatmap" className="flex flex-col gap-2">
      <div
        className="relative overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label={`${label}, scrollable`}
      >
        <table aria-label={label} className="border-separate border-spacing-0.5 text-caption">
          <thead>
            <tr>
              <td className={trailing ? PIN_LEFT : undefined} />
              {columns.map((c) => (
                <th key={c} scope="col" className="px-2 py-1 font-medium text-text-2">
                  {c}
                </th>
              ))}
              {trailing ? (
                <th
                  scope="col"
                  data-testid={trailing.testId}
                  title={trailing.headerTitle}
                  className={`${PIN_RIGHT} px-2 py-1 font-medium text-text-1`}
                >
                  <span className="inline-flex items-center gap-1">
                    {trailing.header}
                    {trailing.headerExtra}
                  </span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r}>
                <th scope="row" className={rowTh}>
                  {r}
                </th>
                {columns.map((c, ci) => (
                  <GridCell
                    key={c}
                    cell={cells[ri]?.[ci]}
                    maxAbs={maxAbs}
                    nullReason={nullReason}
                  />
                ))}
                {trailing ? (
                  <GridCell
                    cell={trailing.cells[ri]}
                    maxAbs={trailing.maxAbs}
                    nullReason={nullReason}
                    pinned
                  />
                ) : null}
              </tr>
            ))}
          </tbody>
          {footerRows && footerRows.length > 0 ? (
            <tfoot data-testid={footerTestId ?? "heat-summary"}>
              {footerRows.map((f, fi) => (
                <tr key={f.key} data-testid={`heat-summary-row-${f.key}`}>
                  <th
                    scope="row"
                    className={`${rowTh} ${fi === 0 ? "border-t border-border" : ""} text-text-1`}
                  >
                    {f.label}
                  </th>
                  {f.cells.map((c, i) => (
                    <FooterTd key={columns[i] ?? i} cell={c} scale={maxAbs} />
                  ))}
                  {trailing ? (
                    f.trailing ? (
                      <FooterTd cell={f.trailing} scale={trailing.maxAbs} pinned />
                    ) : (
                      <td className={PIN_RIGHT} />
                    )
                  ) : null}
                </tr>
              ))}
            </tfoot>
          ) : null}
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
