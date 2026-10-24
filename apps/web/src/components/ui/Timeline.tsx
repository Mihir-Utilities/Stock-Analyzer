import { EmptyState } from "./EmptyState";

export interface TimelineItem {
  id: string;
  /** Date text already formatted by format.ts. */
  date: string;
  /** Kind label, e.g. "Split" or "Dividend"; printed so the marker is not the only signal. */
  kind: string;
  title: string;
  detail?: string;
}

/** Corporate actions / events list with markers. */
export function Timeline({
  items,
  emptyMessage = "No events.",
}: {
  items: TimelineItem[];
  emptyMessage?: string;
}) {
  if (items.length === 0) return <EmptyState message={emptyMessage} />;
  return (
    <ol data-testid="timeline" className="relative flex flex-col gap-3 border-l border-border pl-4">
      {items.map((it) => (
        <li key={it.id} data-testid="timeline-item" className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[21px] top-1.5 size-2.5 rounded-chip border-2 border-surface-1 bg-accent"
          />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <time className="num text-caption text-text-2">{it.date}</time>
            <span className="rounded-chip border border-border px-2 text-micro text-text-2">
              {it.kind}
            </span>
          </div>
          <div className="text-body-sm text-text-1">{it.title}</div>
          {it.detail ? <div className="text-caption text-text-2">{it.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
