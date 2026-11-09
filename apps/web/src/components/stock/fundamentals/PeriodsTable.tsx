"use client";

import { Fmt } from "@/components/imports/Fmt";
import { Sparkline } from "@/components/ui/Sparkline";
import { cx } from "@/components/ui/cx";
import { formatByUnit, unitWords, type ScalarRow, type SeriesRow } from "@/lib/stock/fundamentals";

const th = "whitespace-nowrap px-2 py-1 text-caption font-medium text-text-2";
const stickyCell = "sticky left-0 z-10 bg-surface-1";

/**
 * Periods as columns (latest right), one row per metric: right-aligned tabular numbers, sticky
 * first column, a sparkline, the source of the latest value and a per-period "Edit" entry point.
 * Selecting a row's name sends it to the chart pane. An unknown cell is a dash with its reason.
 */
export function PeriodsTable({
  rows,
  periods,
  labels,
  selectedKey,
  onSelect,
  onEdit,
  caption,
}: {
  rows: SeriesRow[];
  periods: string[];
  labels: string[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onEdit: (periodEnd: string) => void;
  caption: string;
}) {
  return (
    <div className="overflow-x-auto" data-testid="fnd-table-scroll">
      <table className="w-full min-w-max border-collapse text-body-sm" data-testid="fnd-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={cx(th, stickyCell, "text-left")}>
              Metric
            </th>
            {periods.map((p, i) => (
              <th key={p} scope="col" className={cx(th, "text-right")} data-testid={`fnd-col-${p}`}>
                <div className="flex flex-col items-end gap-0.5">
                  <span>{labels[i] ?? p}</span>
                  <button
                    type="button"
                    data-testid={`fnd-edit-${p}`}
                    aria-label={`Edit ${labels[i] ?? p}`}
                    onClick={() => onEdit(p)}
                    className="touch-target inline-flex h-9 items-center rounded-control px-2 text-caption text-accent underline hover:bg-surface-3"
                  >
                    Edit
                  </button>
                </div>
              </th>
            ))}
            <th scope="col" className={cx(th, "text-left")}>
              Trend
            </th>
            <th scope="col" className={cx(th, "text-left")}>
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              data-testid={`fnd-row-${r.key}`}
              data-selected={r.key === selectedKey}
              className="border-b border-border"
            >
              <th scope="row" className={cx("px-2 py-1 text-left font-normal", stickyCell)}>
                <button
                  type="button"
                  data-testid={`fnd-select-${r.key}`}
                  aria-pressed={r.key === selectedKey}
                  onClick={() => onSelect(r.key)}
                  className={cx(
                    "touch-target inline-flex flex-col py-1 items-start rounded-control border px-2 text-left hover:bg-surface-3",
                    r.key === selectedKey ? "border-accent" : "border-transparent",
                  )}
                >
                  <span className="text-text-1">{r.label}</span>
                  <span className="text-caption text-text-2">{unitWords(r.unit)}</span>
                </button>
              </th>
              {r.values.map((v, i) => (
                <td
                  key={periods[i] ?? i}
                  data-testid={`fnd-cell-${r.key}-${periods[i] ?? i}`}
                  className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-text-1"
                >
                  <Fmt f={formatByUnit(r.unit, v, r.reason)} />
                </td>
              ))}
              <td className="px-2 py-1">
                <Sparkline values={r.values} label={`${r.label}, ${periods.length} periods`} />
              </td>
              <td
                className="whitespace-nowrap px-2 py-1 text-caption text-text-2"
                data-testid={`fnd-source-${r.key}`}
              >
                {r.source ?? "computed from entered values"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ratios and valuation: one latest value per row (not a series), source is the worker snapshot. */
export function ScalarTable({
  rows,
  asOfText,
  caption,
}: {
  rows: ScalarRow[];
  asOfText: string;
  caption: string;
}) {
  return (
    <div className="overflow-x-auto" data-testid="fnd-scalar-scroll">
      <table className="w-full border-collapse text-body-sm" data-testid="fnd-scalar-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={cx(th, stickyCell, "text-left")}>
              Metric
            </th>
            <th scope="col" className={cx(th, "text-right")}>
              Latest
            </th>
            <th scope="col" className={cx(th, "text-left")}>
              Unit
            </th>
            <th scope="col" className={cx(th, "text-left")}>
              Source and as-of
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-testid={`fnd-scalar-${r.key}`} className="border-b border-border">
              <th scope="row" className={cx("px-2 py-1 text-left font-normal", stickyCell)}>
                {r.label}
              </th>
              <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-text-1">
                {typeof r.value === "string" ? (
                  r.value
                ) : (
                  <Fmt f={formatByUnit(r.unit, r.value, r.reason)} />
                )}
              </td>
              <td className="px-2 py-1 text-caption text-text-2">{unitWords(r.unit)}</td>
              <td className="px-2 py-1 text-caption text-text-2">{asOfText}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
