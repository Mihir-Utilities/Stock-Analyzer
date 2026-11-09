"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Skeleton } from "@/components/ui/Skeleton";
import { Timeline, type TimelineItem } from "@/components/ui/Timeline";
import { formatDate } from "@/lib/format";
import { todayIst } from "@/lib/imports/entry-validate";
import { describeError } from "@/lib/imports/errors";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { repeatDecision, type PatchResult } from "@/lib/stock/action-patch";
import {
  actionDetail,
  actionTitle,
  FUTURE_EX_NOTE,
  humanize,
  isHttpUrl,
  sortActions,
  statusLabel,
  typeLabel,
} from "@/lib/stock/events-view";
import type { Load } from "@/lib/stock/load";
import type { EventsData, LinksData, StockProfile } from "@/lib/stock/schemas";
import { DetectedActionCard, decisionLines } from "./DetectedActionCard";

const linkClass = "touch-target inline-flex items-center text-body-sm text-accent underline";

interface Decision {
  key: string;
  result: PatchResult;
  verb: "confirmed" | "rejected";
}

/**
 * A saved decision. When the recalculation could not be queued (POST_IMPORT_NOT_QUEUED) the card is
 * already gone from the list, so the retry lives here: a repeat of the decision (ACT-35).
 */
function DecisionBanner({ symbol, decision }: { symbol: string; decision: Decision }) {
  const once = useSingleFlight();
  const [result, setResult] = useState(decision.result);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const warnings = result.warnings ?? [];
  const needsRetry = warnings.some((w) => w.code === "POST_IMPORT_NOT_QUEUED");
  const retry = () =>
    once(async () => {
      setBusy(true);
      setFailed(null);
      try {
        setResult(await repeatDecision(symbol, result.id, decision.verb));
      } catch (e) {
        setFailed(describeError(e));
      } finally {
        setBusy(false);
      }
    });
  return (
    <Banner tone={warnings.length > 0 ? "warn" : "info"} testId="decision-result">
      {decisionLines(result, decision.verb).join(" ")}
      {needsRetry ? (
        <>
          {" "}
          <button
            type="button"
            data-testid="decision-retry"
            disabled={busy}
            onClick={retry}
            className="touch-target inline-flex items-center underline disabled:opacity-60"
          >
            {busy ? "Retrying" : "Retry recalculation"}
          </button>
        </>
      ) : null}
      {failed ? <span data-testid="decision-retry-error"> {failed}</span> : null}
    </Banner>
  );
}

function ResearchLinks({ load }: { load: Load<LinksData> }) {
  if (load.state === "loading") return <Skeleton className="h-16 w-full" label="Loading links" />;
  if (load.state === "error") {
    return (
      <Card
        title="Research links"
        testId="links-error"
        state="error"
        message={load.message}
        onRetry={load.retry}
      />
    );
  }
  const links = load.state === "ready" ? load.data.links.filter((l) => isHttpUrl(l.url)) : [];
  return (
    <Card title="Research links" testId="research-links" source="config/research_links.json">
      {links.length === 0 ? (
        <EmptyState message="No research links are configured for this stock." />
      ) : (
        <ul className="flex flex-col">
          {links.map((l) => (
            <li key={l.url}>
              <ExternalLink
                href={l.url}
                data-testid="research-link"
                className="touch-target inline-flex items-center text-body-sm text-accent underline"
              >
                {l.label}
              </ExternalLink>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-caption text-text-2">
        These links open other websites in a new tab. The app never fetches them.
      </p>
    </Card>
  );
}

/**
 * Events tab (docs/06 6.4): corporate actions (confirmed, detected, rejected), the owner calendar,
 * and research links. Detected actions get the Confirm / Reject flow wired to B07's PATCH route.
 * Adding or editing an action by hand stays in the Import center (F13b).
 */
export function EventsTab({
  profile,
  eventsLoad,
  linksLoad,
}: {
  profile: StockProfile;
  eventsLoad: Load<EventsData>;
  linksLoad: Load<LinksData>;
}) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const live = useRef<HTMLDivElement>(null);
  const symbol = profile.symbol;

  // A decided card leaves the list once the events reload: move focus to the saved message so a
  // keyboard or screen-reader user is not left on a removed control.
  useEffect(() => {
    if (decisions.length > 0) live.current?.focus();
  }, [decisions.length]);

  const add = (result: PatchResult, verb: "confirmed" | "rejected") =>
    setDecisions((d) => [{ key: `${result.id}-${d.length}`, result, verb }, ...d]);

  const addLink = (
    <Link href="/imports" data-testid="events-add-link" className={linkClass}>
      Add or edit an event: manual form or CSV import
    </Link>
  );

  let body: React.ReactNode;
  let standalone: React.ReactNode = null;
  if (eventsLoad.state === "loading") {
    body = (
      <div data-testid="events-loading" aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-1/3" label="Loading events" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (eventsLoad.state === "error") {
    standalone = (
      <Card
        title="Events"
        testId="events-error"
        state="error"
        message={`${eventsLoad.message}${eventsLoad.requestId ? ` (request ${eventsLoad.requestId})` : ""}`}
        onRetry={eventsLoad.retry}
      />
    );
  } else if (eventsLoad.state === "unavailable") {
    standalone = (
      <Card title="Events" testId="events-unavailable" state="empty" message={eventsLoad.reason} />
    );
  } else {
    const ev = eventsLoad.data;
    const actions = sortActions(ev.actions);
    const detected = actions.filter((a) => a.status === "detected");
    const today = todayIst();
    const items: TimelineItem[] = actions.map((a) => ({
      id: String(a.id),
      date: formatDate(a.ex_date).text,
      kind: `${typeLabel(a.type)}, ${statusLabel(a.status).toLowerCase()}`,
      title: actionTitle(a),
      detail: `${actionDetail(a)}${a.ex_date > today && a.status === "confirmed" ? `. ${FUTURE_EX_NOTE}` : ""}`,
    }));
    const cal: TimelineItem[] = ev.calendar.map((c, i) => ({
      id: `${c.event_date}-${i}`,
      date: formatDate(c.event_date).text,
      kind: humanize(c.type),
      title: c.details ?? humanize(c.type),
      detail: `Source: ${c.source ?? "not stated"}`,
    }));
    body = (
      <div className="flex flex-col gap-4">
        {ev.reason === "no_data_entered" && actions.length === 0 && cal.length === 0 ? (
          <Banner tone="info" testId="events-no-data">
            No events entered for {symbol}.{" "}
            {ev.entry_hint ?? "Add events via Import or the manual form"}.
          </Banner>
        ) : null}
        {detected.length > 0 ? (
          <section aria-labelledby="ev-detected-h" className="flex flex-col gap-3">
            <h3 id="ev-detected-h" className="text-body font-semibold text-text-1">
              Needs your decision
            </h3>
            {detected.map((a) => (
              <DetectedActionCard
                key={a.id}
                symbol={symbol}
                action={a}
                allActions={ev.actions}
                onDone={add}
              />
            ))}
          </section>
        ) : null}
        <section aria-labelledby="ev-actions-h" className="flex flex-col gap-2">
          <h3 id="ev-actions-h" className="text-body font-semibold text-text-1">
            Corporate actions
          </h3>
          <Timeline items={items} emptyMessage="No corporate actions in the last 5 years." />
        </section>
        <section aria-labelledby="ev-cal-h" className="flex flex-col gap-2">
          <h3 id="ev-cal-h" className="text-body font-semibold text-text-1">
            Coming up and results (your calendar, next 90 days)
          </h3>
          <Timeline items={cal} emptyMessage="No calendar events in the next 90 days." />
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="events-tab">
      <div
        ref={live}
        tabIndex={-1}
        aria-live="polite"
        data-testid="decision-live"
        className="flex flex-col gap-2 outline-none"
      >
        {decisions.map((d) => (
          <DecisionBanner key={d.key} symbol={symbol} decision={d} />
        ))}
      </div>
      {standalone ?? (
        <Card title="Events" testId="events-card" actions={addLink}>
          {body}
        </Card>
      )}
      <ResearchLinks load={linksLoad} />
    </div>
  );
}
