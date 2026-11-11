"use client";

import { useRef, type KeyboardEvent } from "react";
import { cx } from "@/components/ui/cx";
import { VIEWS, VIEW_LABEL, type PortfolioView } from "@/lib/portfolio/view";

/**
 * All | Equity | Mutual funds (docs/06 6.7a). Radio-group semantics: one tab stop, arrow keys move
 * and select, Home/End jump; the active segment is announced through `aria-checked`.
 */
export function ViewSwitcher({
  value,
  onChange,
  groupTestId = "pf-view-switcher",
  segmentPrefix = "pf-view",
}: {
  value: PortfolioView;
  onChange: (v: PortfolioView) => void;
  groupTestId?: string;
  segmentPrefix?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (i: number) => {
    const next = VIEWS[(i + VIEWS.length) % VIEWS.length];
    if (next === undefined) return;
    onChange(next);
    refs.current[(i + VIEWS.length) % VIEWS.length]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = VIEWS.indexOf(value);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(i + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(VIEWS.length - 1);
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label="Portfolio view"
      data-testid={groupTestId}
      data-view={value}
      onKeyDown={onKey}
      className="inline-flex rounded-control border border-border bg-surface-2 p-0.5"
    >
      {VIEWS.map((v, i) => (
        <button
          key={v}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={v === value}
          tabIndex={v === value ? 0 : -1}
          data-testid={`${segmentPrefix}-${v}`}
          onClick={() => onChange(v)}
          className={cx(
            "h-9 touch-target rounded-control px-3 text-body-sm",
            v === value
              ? "bg-surface-1 font-medium text-text-1 shadow-sm"
              : "text-text-2 hover:text-text-1",
          )}
        >
          {VIEW_LABEL[v]}
        </button>
      ))}
    </div>
  );
}
