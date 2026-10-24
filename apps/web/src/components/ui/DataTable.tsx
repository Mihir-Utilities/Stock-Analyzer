"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnPinningState,
  type ColumnSizingState,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Rows3 } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Banner } from "./banners";
import { AsOfChip, SourceChip } from "./chips";
import { cx } from "./cx";
import { downloadCsv, toCsv } from "./csv";
import { EmptyState } from "./EmptyState";
import { heatColor } from "./Heatmap";
import { Skeleton } from "./Skeleton";
import { Sparkline } from "./Sparkline";

export type CellKind = "text" | "num" | "sparkline" | "databar" | "heat";

export interface DataColumn<T> {
  id: string;
  header: string;
  /** Raw value used for sorting and CSV. null = unknown (shows the reason, sorts last). */
  value: (row: T) => string | number | null;
  /** Formatted text from format.ts; defaults to formatNumber for numbers. */
  display?: (row: T) => string | null;
  kind?: CellKind;
  /** Series for `sparkline` cells. */
  spark?: (row: T) => ReadonlyArray<number | null>;
  /** Scale for `databar` (0..max) and `heat` (-max..max). */
  max?: number;
  nullReason?: string;
  width?: number;
  /** Pinned columns stick on the left; the first column is pinned by default. */
  pinned?: boolean;
}

export type TableState = "ready" | "loading" | "empty" | "error";

const VIRTUALIZE_ABOVE = 100;
const BODY_HEIGHT = 480;
const ROW_HEIGHT = { compact: 36, touch: 44 } as const;
type Density = keyof typeof ROW_HEIGHT;

interface Props<T> {
  label: string;
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  state?: TableState;
  /** Empty or error message. */
  message?: string;
  onRetry?: () => void;
  /** Partial / stale notes and provenance. */
  partialNote?: string;
  source?: string;
  asOf?: string | null;
  stale?: boolean;
  csvFilename?: string;
  defaultDensity?: Density;
  /** Initial viewport height in px (tests); the scroll box measures itself in a browser. */
  viewportHeight?: number;
}

function cellText<T>(col: DataColumn<T>, row: T): string | null {
  const raw = col.value(row);
  if (raw === null || (typeof raw === "number" && !Number.isFinite(raw))) return null;
  const shown = col.display
    ? col.display(row)
    : typeof raw === "number"
      ? formatNumber(raw).text
      : String(raw);
  return shown;
}

/**
 * TanStack Table based grid: sticky header and pinned first column, sortable, resizable (mouse or
 * Arrow keys on the handle), density toggle, virtualized above 100 rows, sparkline/databar/heat
 * cells, CSV export with spreadsheet-injection protection, loading/empty/error states and
 * roving keyboard navigation (arrows, Home/End).
 */
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  state = "ready",
  message,
  onRetry,
  partialNote,
  source,
  asOf,
  stale = false,
  csvFilename = "table.csv",
  defaultDensity = "compact",
  viewportHeight = BODY_HEIGHT,
}: Props<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [sizing, setSizing] = useState<ColumnSizingState>({});
  const [density, setDensity] = useState<Density>(defaultDensity);
  const [active, setActive] = useState({ r: 0, c: 0 });
  const [focusTick, setFocusTick] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  const pinning = useMemo<ColumnPinningState>(() => {
    const explicit = columns.filter((c) => c.pinned).map((c) => c.id);
    const first = columns[0];
    return { left: explicit.length > 0 ? explicit : first ? [first.id] : [] };
  }, [columns]);

  const defs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((col) => ({
        id: col.id,
        header: col.header,
        size: col.width ?? 120,
        minSize: 48,
        accessorFn: (row: T) => col.value(row) ?? undefined,
        sortUndefined: "last",
        cell: (ctx) => <Cell col={col} row={ctx.row.original} />,
      })),
    [columns],
  );

  // TanStack Table returns unmemoizable functions; the compiler skips this component, which is fine.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns: defs,
    getRowId: (row) => rowKey(row),
    state: { sorting, columnSizing: sizing, columnPinning: pinning },
    onSortingChange: setSorting,
    onColumnSizingChange: setSizing,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const body = table.getRowModel().rows;
  const rowHeight = ROW_HEIGHT[density];
  const virtual = body.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: body.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    initialRect: { width: 800, height: viewportHeight },
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const items = virtual ? virtualizer.getVirtualItems() : null;
  const visible = items ? items.map((v) => body[v.index]).flatMap((r) => (r ? [r] : [])) : body;
  const topPad = items && items[0] ? items[0].start : 0;
  const lastItem = items ? items[items.length - 1] : undefined;
  const bottomPad = items && lastItem ? virtualizer.getTotalSize() - lastItem.end : 0;
  const colCount = columns.length;

  useEffect(() => {
    if (focusTick === 0) return;
    const el = scroller.current?.querySelector<HTMLElement>(
      `[data-r="${active.r}"][data-c="${active.c}"]`,
    );
    el?.focus();
    // Only when a key press asked for focus to move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const r = Number(target.dataset["r"]);
      const c = Number(target.dataset["c"]);
      if (Number.isNaN(r) || Number.isNaN(c)) return;
      let nr = r;
      let nc = c;
      if (e.key === "ArrowDown") nr = Math.min(body.length - 1, r + 1);
      else if (e.key === "ArrowUp") nr = Math.max(0, r - 1);
      else if (e.key === "ArrowRight") nc = Math.min(colCount - 1, c + 1);
      else if (e.key === "ArrowLeft") nc = Math.max(0, c - 1);
      else if (e.key === "Home") nc = 0;
      else if (e.key === "End") nc = colCount - 1;
      else return;
      e.preventDefault();
      setActive({ r: nr, c: nc });
      if (virtual) virtualizer.scrollToIndex(nr);
      requestAnimationFrame(() => setFocusTick((t) => t + 1));
    },
    [body.length, colCount, virtual, virtualizer],
  );

  const exportCsv = () => {
    const data = body.map((row) => columns.map((col) => col.value(row.original)));
    downloadCsv(
      toCsv(
        columns.map((c) => c.header),
        data,
      ),
      csvFilename,
    );
  };

  if (state === "loading") {
    return (
      <div data-testid="data-table-loading" aria-busy="true" className="flex flex-col gap-1">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" label={`Loading ${label}`} />
        ))}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div data-testid="data-table-error" className="flex flex-col items-start gap-2">
        <Banner tone="error">{message ?? "The table could not be loaded."}</Banner>
        {onRetry ? (
          <button
            type="button"
            data-testid="data-table-retry"
            onClick={onRetry}
            className="h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3"
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (state === "empty" || rows.length === 0) {
    return <EmptyState message={message ?? "No rows to show."} />;
  }

  const pinnedLeft = (id: string) => pinning.left?.includes(id) ?? false;
  const stick = (id: string, header: boolean): React.CSSProperties | undefined => {
    if (!pinnedLeft(id)) return undefined;
    return {
      position: "sticky",
      left: table.getColumn(id)?.getStart("left") ?? 0,
      zIndex: header ? 3 : 1,
    };
  };

  return (
    <div data-testid="data-table" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-text-2" data-testid="data-table-count">
            {rows.length} rows
          </span>
          {source ? <SourceChip source={source} /> : null}
          {asOf !== undefined ? <AsOfChip asOf={asOf} stale={stale} /> : null}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="data-table-density"
            aria-pressed={density === "touch"}
            onClick={() => setDensity((d) => (d === "compact" ? "touch" : "compact"))}
            className="inline-flex h-9 touch-target items-center gap-1 rounded-control border border-border px-3 text-body-sm hover:bg-surface-3"
          >
            <Rows3 size={16} strokeWidth={1.75} aria-hidden="true" />
            {density === "compact" ? "Compact" : "Touch"}
          </button>
          <button
            type="button"
            data-testid="data-table-export"
            onClick={exportCsv}
            className="inline-flex h-9 touch-target items-center gap-1 rounded-control border border-border px-3 text-body-sm hover:bg-surface-3"
          >
            <Download size={16} strokeWidth={1.75} aria-hidden="true" />
            Export CSV
          </button>
        </div>
      </div>
      {partialNote ? <Banner tone="warn">{partialNote}</Banner> : null}
      <div
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label={`${label} (scrollable)`}
        className="overflow-auto rounded-card border border-border"
        style={{ maxHeight: virtual ? viewportHeight : undefined }}
      >
        <table
          role="grid"
          aria-label={label}
          aria-rowcount={body.length + 1}
          className="border-separate border-spacing-0 text-body-sm"
          style={{ width: table.getTotalSize(), tableLayout: "fixed" }}
          onKeyDown={onKeyDown}
        >
          <thead>
            <tr role="row">
              {table.getHeaderGroups()[0]?.headers.map((h, ci) => {
                const sorted = h.column.getIsSorted();
                return (
                  <th
                    key={h.id}
                    role="columnheader"
                    scope="col"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                    }
                    className="sticky top-0 border-b border-border bg-surface-2 p-0 text-left font-medium text-text-1 z-[2]"
                    style={{ width: h.getSize(), height: rowHeight, ...stick(h.column.id, true) }}
                  >
                    <div className="relative flex h-full items-center">
                      <button
                        type="button"
                        data-testid={`sort-${h.column.id}`}
                        data-r={-1}
                        data-c={ci}
                        onClick={h.column.getToggleSortingHandler()}
                        className="touch-target flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left"
                      >
                        <span className="truncate" title={String(h.column.columnDef.header)}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                        </span>
                        {sorted === "asc" ? (
                          <ArrowUp size={12} aria-hidden="true" />
                        ) : sorted === "desc" ? (
                          <ArrowDown size={12} aria-hidden="true" />
                        ) : (
                          <ArrowUpDown size={12} className="text-text-2" aria-hidden="true" />
                        )}
                      </button>
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-valuenow={h.getSize()}
                        aria-valuemin={48}
                        aria-valuemax={800}
                        aria-label={`Resize ${h.column.columnDef.header as string}`}
                        data-testid={`resize-${h.column.id}`}
                        tabIndex={0}
                        onMouseDown={h.getResizeHandler()}
                        onTouchStart={h.getResizeHandler()}
                        onKeyDown={(e) => {
                          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                          e.preventDefault();
                          e.stopPropagation();
                          const delta = e.key === "ArrowRight" ? 10 : -10;
                          setSizing((s) => ({
                            ...s,
                            [h.column.id]: Math.max(48, h.getSize() + delta),
                          }));
                        }}
                        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-border hover:bg-accent"
                      />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 ? (
              <tr aria-hidden="true" style={{ height: topPad }}>
                <td colSpan={colCount} />
              </tr>
            ) : null}
            {visible.map((row) => {
              const ri = body.indexOf(row);
              return (
                <tr
                  key={row.id}
                  role="row"
                  aria-rowindex={ri + 2}
                  data-testid="data-row"
                  style={{ height: rowHeight }}
                >
                  {row.getVisibleCells().map((cell, ci) => (
                    <td
                      key={cell.id}
                      role="gridcell"
                      data-r={ri}
                      data-c={ci}
                      tabIndex={active.r === ri && active.c === ci ? 0 : -1}
                      onFocus={() => setActive({ r: ri, c: ci })}
                      className={cx(
                        "overflow-hidden border-b border-border bg-surface-1 px-2 text-text-1",
                        columns[ci]?.kind && columns[ci]?.kind !== "text" && "num",
                      )}
                      style={{ width: cell.column.getSize(), ...stick(cell.column.id, false) }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {bottomPad > 0 ? (
              <tr aria-hidden="true" style={{ height: bottomPad }}>
                <td colSpan={colCount} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell<T>({ col, row }: { col: DataColumn<T>; row: T }) {
  const text = cellText(col, row);
  const reason = col.nullReason ?? "No data";
  if (col.kind === "sparkline") {
    return <Sparkline values={col.spark ? col.spark(row) : []} label={`${col.header} trend`} />;
  }
  if (text === null) {
    return (
      <span data-testid="null-cell" className="text-text-2" title={reason}>
        {"—"} <span className="text-caption">{reason}</span>
      </span>
    );
  }
  const raw = col.value(row);
  if (col.kind === "databar" && typeof raw === "number" && col.max && col.max > 0) {
    const pct = Math.min(100, Math.max(0, (raw / col.max) * 100));
    return (
      <div className="relative flex h-6 items-center" title={text}>
        <span
          aria-hidden="true"
          data-testid="databar"
          className="absolute inset-y-1 left-0 rounded-control bg-accent-weak"
          style={{ width: `${pct}%` }}
        />
        <span className="relative">{text}</span>
      </div>
    );
  }
  if (col.kind === "heat" && typeof raw === "number" && col.max) {
    return (
      <span
        data-testid="heat-value"
        className="block rounded-control px-1 text-center"
        style={{ backgroundColor: heatColor(raw, col.max) }}
      >
        {text}
      </span>
    );
  }
  return (
    <span className={cx("block truncate", col.kind === "num" && "text-right")} title={text}>
      {text}
    </span>
  );
}
