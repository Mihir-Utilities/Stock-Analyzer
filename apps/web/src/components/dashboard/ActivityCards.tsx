"use client";

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Timeline, type TimelineItem } from "@/components/ui/Timeline";
import { useAlertEvents, useUpcomingEvents, useWatchlist } from "@/lib/dashboard/queries";
import { asOfText, describeError, istDate } from "@/lib/dashboard/state";
import { formatDate, formatDateTime } from "@/lib/format";

export const EVENTS_SOURCE = "Events you entered";
export const ALERTS_SOURCE = "Your alerts";
/** Calendar calls are one per symbol; the dashboard looks at the first ten watchlist stocks. */
export const EVENT_SYMBOLS_MAX = 10;
const EVENTS_SHOWN = 8;

/** Owner-entered upcoming events for watchlist stocks (docs/06 section 6.2). */
export function UpcomingEventsCard() {
  const title = "Upcoming events";
  const watch = useWatchlist();
  const symbols = watch.data?.data.stocks.slice(0, EVENT_SYMBOLS_MAX).map((s) => s.symbol) ?? [];
  const events = useUpcomingEvents(symbols);

  if (watch.isPending) return <Card title={title} state="loading" testId="dash-events" />;
  if (watch.isError) {
    const u = describeError(watch.error, "Upcoming events");
    return (
      <Card
        title={title}
        state={u.state}
        message={u.message}
        onRetry={() => void watch.refetch()}
        source={EVENTS_SOURCE}
        testId="dash-events"
      />
    );
  }
  if (symbols.length === 0) {
    return (
      <Card
        title={title}
        state="empty"
        message="No upcoming events: your watchlist is empty."
        source={EVENTS_SOURCE}
        testId="dash-events"
      />
    );
  }
  if (events.some((e) => e.isPending)) {
    return <Card title={title} state="loading" testId="dash-events" />;
  }
  const failed = events.filter((e) => e.isError);
  const today = istDate(new Date());
  const items: Array<TimelineItem & { sortKey: string }> = [];
  events.forEach((e, i) => {
    const symbol = symbols[i] ?? "";
    for (const c of e.data?.data.calendar ?? []) {
      if (c.event_date < today) continue;
      items.push({
        id: `${symbol}-${c.event_date}-${c.type}`,
        sortKey: `${c.event_date}-${symbol}`,
        date: formatDate(c.event_date).text,
        kind: c.type,
        title: symbol,
        detail: typeof c.details === "string" ? c.details : undefined,
      });
    }
  });
  items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  if (failed.length === events.length) {
    const u = describeError(failed[0]?.error, "Upcoming events");
    return (
      <Card
        title={title}
        state={u.state}
        message={u.message}
        onRetry={() => failed.forEach((f) => void f.refetch())}
        source={EVENTS_SOURCE}
        testId="dash-events"
      />
    );
  }
  if (items.length === 0 && failed.length === 0) {
    return (
      <Card
        title={title}
        state="empty"
        message="No upcoming events in the next 90 days. Event dates come from entries you add, so none are shown until you enter them."
        source={EVENTS_SOURCE}
        testId="dash-events"
      />
    );
  }
  return (
    <Card
      title={title}
      state={failed.length > 0 ? "partial" : "ready"}
      message={`${failed.length} of ${events.length} stocks could not be checked for events.`}
      source={EVENTS_SOURCE}
      asOf={asOfText(today)}
      testId="dash-events"
    >
      <Timeline items={items.slice(0, EVENTS_SHOWN)} emptyMessage="No upcoming events." />
    </Card>
  );
}

function targetLabel(t: { symbol?: string | null; name?: string | null; code?: number | null }) {
  return t.symbol ?? t.name ?? (t.code === null || t.code === undefined ? "target" : `${t.code}`);
}

/** The five most recent alert events with their delivery status (text, not colour alone). */
export function AlertsCard() {
  const q = useAlertEvents();
  const title = "Alerts activity";
  const link = (
    <Link
      href="/alerts"
      data-testid="alerts-link"
      className="inline-flex h-9 touch-target items-center rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3"
    >
      All alerts
    </Link>
  );
  if (q.isPending) return <Card title={title} state="loading" testId="dash-alerts" />;
  if (q.isError) {
    const u = describeError(q.error, "Alert activity");
    return (
      <Card
        title={title}
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        source={ALERTS_SOURCE}
        testId="dash-alerts"
      />
    );
  }
  const items = q.data.data.items;
  if (items.length === 0) {
    return (
      <Card
        title={title}
        state="empty"
        message="No alert has fired yet."
        source={ALERTS_SOURCE}
        actions={link}
        testId="dash-alerts"
      />
    );
  }
  return (
    <Card
      title={title}
      source={ALERTS_SOURCE}
      asOf={asOfText(items[0]?.fired_at)}
      actions={link}
      testId="dash-alerts"
    >
      <ul data-testid="alert-strip" className="flex flex-col gap-2">
        {items.map((e) => (
          <li
            key={e.id}
            data-testid="alert-event"
            className="flex flex-wrap items-baseline gap-x-2 text-body-sm"
          >
            <span className="font-medium text-text-1">{targetLabel(e.target)}</span>
            <span className="text-text-2">{e.kind}</span>
            <time className="num text-caption text-text-2">{formatDateTime(e.fired_at).text}</time>
            <span className="rounded-chip border border-border px-2 text-micro text-text-2">
              Delivery: {e.delivery_status}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
