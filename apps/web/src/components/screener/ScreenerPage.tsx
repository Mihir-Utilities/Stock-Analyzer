"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { downloadCsv } from "@/components/ui/csv";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import { describeError } from "@/lib/dashboard/state";
import { fieldErrors } from "@/lib/imports/errors";
import { runScreen, screenerKeys } from "@/lib/screener/api";
import { screenerCsv } from "@/lib/screener/csv";
import { metricLabel } from "@/lib/screener/metrics";
import type { ScreenSpec } from "@/lib/screener/schemas";
import {
  buildQuery,
  displayMetrics,
  emptyDraft,
  specToDraft,
  toSavedSpec,
  type Draft,
  type DraftError,
  type QueryBody,
  type SavedSpec,
} from "@/lib/screener/spec";
import { FilterBuilder } from "./FilterBuilder";
import { BTN } from "./parts";
import { ResultsTable } from "./ResultsTable";
import { SavedScreens } from "./SavedScreens";

export const OWNER_DATA_NOTICE =
  "Fundamental filters only see stocks with owner-entered data. A stock without a value for a filtered metric is left out and counted below.";

function excludedText(excluded: Record<string, number>): string {
  const parts = Object.entries(excluded)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${metricLabel(k)} ${n}`);
  return parts.length === 0
    ? "No stock was left out for a missing value."
    : `Left out because they have no value for a filtered metric (stocks per metric): ${parts.join(", ")}.`;
}

/**
 * Server 422 `fields[]` (`filters[2].value`, `sort.metric`, `columns[1]`, `universe.kind`) as
 * draft errors: a filter path goes to the filter that was sent at that position, the rest to the
 * form-level message.
 */
export function placeServerErrors(
  fields: ReadonlyArray<{ field: string; message: string }>,
  sentIds: ReadonlyArray<number>,
): DraftError[] {
  return fields.map((f) => {
    const m = /^filters\[(\d+)\]\.?(\w*)$/.exec(f.field);
    const id = m ? (sentIds[Number(m[1])] ?? null) : null;
    const label = m && id !== null ? m[2] || "filter" : f.field;
    return { id, field: m?.[2] || f.field, message: `Server: ${label} ${f.message}.` };
  });
}

export function ScreenerPage() {
  const [draft, setDraftState] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<DraftError[]>([]);
  const [applied, setApplied] = useState<QueryBody | null>(null);
  const [loadNote, setLoadNote] = useState("");
  const [serverErrors, setServerErrors] = useState<DraftError[]>([]);
  /** Draft filter ids in the order of the body that was sent, to place a server 422 per filter. */
  const sentIds = useRef<number[]>([]);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusWanted = useRef(false);

  const setDraft = (fn: (d: Draft) => Draft) => {
    setDraftState(fn);
    setErrors([]);
    setServerErrors([]);
  };

  const key = useMemo(() => (applied ? JSON.stringify(applied) : ""), [applied]);
  const q = useInfiniteQuery({
    queryKey: screenerKeys.query(key),
    queryFn: ({ pageParam, signal }) => {
      if (!applied) throw new Error("no screen");
      return runScreen(applied, pageParam, signal);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: applied !== null,
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if ((q.isSuccess || q.isError) && focusWanted.current) {
      focusWanted.current = false;
      headingRef.current?.focus();
    }
  }, [q.isSuccess, q.isError, q.fetchStatus]);

  useEffect(() => {
    if (!q.isError) return;
    setServerErrors(placeServerErrors(fieldErrors(q.error), sentIds.current));
  }, [q.isError, q.error]);

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const first = q.data?.pages[0];
  const metrics = applied ? displayMetrics(applied) : [];
  const units = first?.units ?? {};
  const staleCount = items.filter((i) => i.stale).length;

  const run = () => {
    const built = buildQuery(draft);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    setServerErrors([]);
    setLoadNote("");
    focusWanted.current = true;
    sentIds.current = draft.filters.map((f) => f.id);
    if (JSON.stringify(built.body) === key) void q.refetch();
    else setApplied(built.body);
  };

  const buildSpec = (): SavedSpec | null => {
    const built = buildQuery(draft);
    if (!built.ok) {
      setErrors(built.errors);
      return null;
    }
    return toSavedSpec(built.body);
  };

  const load = (name: string, spec: ScreenSpec) => {
    const { draft: d, dropped } = specToDraft(spec, nextId);
    setDraftState(d);
    setErrors([]);
    setServerErrors([]);
    setLoadNote(
      dropped.length > 0
        ? `Loaded ${name}. Left out what this app does not support: ${dropped.join(", ")}.`
        : `Loaded ${name}. Press Run screen to see results.`,
    );
  };

  const serverFields = q.isError ? fieldErrors(q.error) : [];
  const failure = q.isError ? describeError(q.error, "The screen") : null;
  const moreFailed = q.isError && items.length > 0;
  // A 4xx on a later page (for example a cursor the server no longer accepts) cannot be fixed by
  // asking for the same page again: the owner starts the screen over.
  const moreRejected =
    moreFailed && q.error instanceof ApiError && q.error.status >= 400 && q.error.status < 500;

  const status = !applied
    ? ""
    : q.isPending
      ? "Running the screen"
      : q.isError && items.length === 0
        ? ""
        : `Showing ${items.length}${first?.total != null ? ` of ${first.total}` : ""} stock${items.length === 1 ? "" : "s"}${staleCount > 0 ? `, ${staleCount} with stale owner data` : ""}`;

  return (
    <div className="flex flex-col gap-4" data-testid="screener-page">
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold text-text-1" data-testid="screener-title">
          Screener
        </h1>
        <p className="text-body-sm text-text-2">
          Filter stocks on whitelisted metrics. Values come from the latest analytics run; each row
          shows when its owner data was last updated.
        </p>
      </header>

      <Banner testId="screener-owner-data-notice">{OWNER_DATA_NOTICE}</Banner>

      <Card title="Build a screen" testId="screener-builder">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
          className="flex flex-col gap-4"
        >
          <FilterBuilder
            draft={draft}
            setDraft={setDraft}
            errors={[...errors, ...serverErrors]}
            nextId={nextId}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              data-testid="screener-run"
              disabled={q.isFetching && !q.isFetchingNextPage && applied !== null}
              className={BTN}
            >
              {q.isFetching && !q.isFetchingNextPage && applied !== null ? "Running" : "Run screen"}
            </button>
            <button
              type="button"
              data-testid="screener-reset"
              onClick={() => {
                setDraftState(emptyDraft());
                setErrors([]);
                setServerErrors([]);
                setLoadNote("");
              }}
              className={BTN}
            >
              Reset
            </button>
          </div>
          <p
            aria-live="polite"
            data-testid="screener-load-note"
            className="text-caption text-text-2"
          >
            {loadNote}
          </p>
        </form>
      </Card>

      <SavedScreens buildSpec={buildSpec} onLoad={load} />

      <section aria-labelledby="screener-results-heading" className="flex flex-col gap-3">
        <h2
          id="screener-results-heading"
          ref={headingRef}
          tabIndex={-1}
          data-testid="screener-results-heading"
          className="text-lead font-semibold text-text-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Results
        </h2>
        <div aria-live="polite" data-testid="screener-status" className="text-caption text-text-2">
          {status}
        </div>

        {!applied ? (
          <EmptyState message="Build a screen above, or pick a preset, then press Run screen." />
        ) : q.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-10 w-full" label="Running the screen" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : q.isError && items.length === 0 ? (
          <div className="flex flex-col items-start gap-2" data-testid="screener-error">
            <Banner
              tone={failure?.state === "error" ? "error" : "info"}
              testId="screener-error-banner"
            >
              {q.error instanceof ApiError && q.error.status === 422
                ? "The server did not accept this screen."
                : failure?.message}
            </Banner>
            {serverFields.length > 0 ? (
              <ul
                className="list-disc pl-5 text-body-sm text-text-1"
                data-testid="screener-server-fields"
              >
                {serverFields.map((f) => (
                  <li key={`${f.field}${f.message}`}>
                    {f.field}: {f.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              data-testid="screener-retry"
              onClick={() => void q.refetch()}
              className={BTN}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {first && Object.keys(first.excluded).length > 0 ? (
              <p className="text-body-sm text-text-1" data-testid="screener-excluded">
                {excludedText(first.excluded)}
              </p>
            ) : null}
            {items.length === 0 ? (
              <EmptyState message="No stocks match this screen. Relax a filter or check the notice above about owner-entered data." />
            ) : (
              <>
                {staleCount > 0 ? (
                  <Banner tone="warn" testId="screener-stale-note">
                    {staleCount} of the {items.length} loaded stock
                    {items.length === 1 ? "" : "s"} {staleCount === 1 ? "has" : "have"} stale owner
                    data. The Stale label on a row says why.{" "}
                    <Link
                      href="/imports"
                      className="touch-target inline-flex items-center text-accent underline"
                      data-testid="screener-imports-link"
                    >
                      Go to Imports
                    </Link>
                  </Banner>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="screener-export"
                    onClick={() => downloadCsv(screenerCsv(items, metrics, units), "screener.csv")}
                    className={BTN}
                  >
                    Export loaded rows as CSV
                  </button>
                </div>
                <ResultsTable items={items} metrics={metrics} units={units} />
              </>
            )}
            {moreFailed ? (
              <Banner tone="error" testId="screener-more-error">
                {moreRejected
                  ? "The server did not accept the next page. The rows above are kept; press Run screen to start the screen again."
                  : "The last request failed. The rows above are kept; use Load more to try again."}
              </Banner>
            ) : null}
            {q.hasNextPage ? (
              <button
                type="button"
                data-testid="screener-more"
                disabled={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
                className={`${BTN} self-start`}
              >
                {q.isFetchingNextPage ? "Loading" : "Load more"}
              </button>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
