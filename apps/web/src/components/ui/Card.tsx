import type { ReactNode } from "react";
import { Banner } from "./banners";
import { AsOfChip, SourceChip } from "./chips";
import type { ViewState } from "./cx";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

export interface CardProps {
  title: string;
  /** Info popover content (definition/formula), rendered by the caller via InfoPopover. */
  info?: ReactNode;
  actions?: ReactNode;
  state?: ViewState;
  source?: string;
  asOf?: string | null;
  /** Staleness independent of `state`: a partial card can also be stale (both are shown). */
  stale?: boolean;
  /** Empty: one sentence. Error: message. Partial: what is missing. */
  message?: string;
  onRetry?: () => void;
  children?: ReactNode;
  testId?: string;
}

/**
 * Title row, body and footer chips. States: loading (skeleton), empty, partial (body + warning),
 * stale (body + amber as-of chip), error (message + retry). Source and as-of are always shown,
 * or the as-of chip says "unknown".
 */
export function Card({
  title,
  info,
  actions,
  state = "ready",
  source,
  asOf = null,
  stale = false,
  message,
  onRetry,
  children,
  testId = "card",
}: CardProps) {
  let body: ReactNode;
  if (state === "loading") {
    body = (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-6 w-1/3" label={`Loading ${title}`} />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (state === "empty") {
    body = <EmptyState message={message ?? "No data yet."} />;
  } else if (state === "error") {
    body = (
      <div className="flex flex-col items-start gap-2">
        <Banner tone="error">{message ?? "This card could not be loaded."}</Banner>
        {onRetry ? (
          <button
            type="button"
            data-testid="card-retry"
            onClick={onRetry}
            className="h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3"
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <>
        {state === "partial" ? (
          <div className="mb-2">
            <Banner tone="warn">{message ?? "Some data is missing."}</Banner>
          </div>
        ) : null}
        {children}
      </>
    );
  }
  const isStale = stale || state === "stale";
  return (
    <section
      data-testid={testId}
      data-state={state}
      aria-label={title}
      className="rounded-card border border-border bg-surface-1 p-4"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-lead font-semibold text-text-1">{title}</h3>
          {info}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {body}
      {state !== "loading" && (source || asOf !== null || isStale) ? (
        <footer className="mt-3 flex flex-wrap gap-2">
          {source ? <SourceChip source={source} /> : null}
          <AsOfChip asOf={asOf} stale={isStale} />
        </footer>
      ) : null}
    </section>
  );
}
