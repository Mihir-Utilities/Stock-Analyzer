"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import { fetchBatches, undoBatch } from "@/lib/imports/api";
import { KIND_NAMES, UNDO_WINDOW_DAYS, undoVerdict } from "@/lib/imports/batches";
import { describeError, isApiError } from "@/lib/imports/errors";
import type { Batch, UndoResult } from "@/lib/imports/schemas";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { DASH, formatCount, formatDate } from "@/lib/format";
import { Fmt } from "./Fmt";

/** Sentences for the undo warning codes (docs/03 section 14, B08-5). */
export const UNDO_WARNING_TEXT: Record<string, string> = {
  POST_IMPORT_NOT_QUEUED:
    "The undo is saved, but the analytics refresh was not queued. Any later import refreshes them.",
  UNDO_REMOVED_NOTHING:
    "No row carried this batch any more because a later import took the values over. The batch is marked undone and nothing was removed.",
  UNDO_REMOVES_EARLIER_IMPORT:
    "The same file was imported earlier and not undone, so this undo also removed values that existed before this batch.",
};

function kindName(kind: string): string {
  return KIND_NAMES[kind] ?? kind;
}

function dependentsText(error: unknown): string {
  const d = error instanceof ApiError ? error.details?.dependents : undefined;
  const n =
    typeof d === "object" && d !== null
      ? (d as Record<string, unknown>).portfolio_adjustment
      : undefined;
  const count = typeof n === "number" ? ` (${formatCount(n).text})` : "";
  return `A portfolio adjustment${count} uses a corporate action of this batch, so nothing was changed. Remove the adjustment first, then undo the batch.`;
}

const headingClass =
  "text-body font-semibold text-text-1 outline-none focus-visible:outline-2 focus-visible:outline-accent";

/** Batches tab: list of import batches with Undo for the kinds that allow it (IMP-14, IMP-44). */
export function BatchesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["import-batches"], queryFn: () => fetchBatches(50) });
  const [target, setTarget] = useState<Batch | null>(null);
  const [done, setDone] = useState<UndoResult | null>(null);
  const [failure, setFailure] = useState<{ batch: number; text: string; code: string } | null>(
    null,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const once = useSingleFlight();

  const undo = useMutation({
    mutationFn: (id: number) => undoBatch(id),
    onSuccess: (data) => {
      setTarget(null);
      setFailure(null);
      setDone(data);
      void qc.invalidateQueries({ queryKey: ["import-batches"] });
    },
    onError: (e, id) => {
      setTarget(null);
      setDone(null);
      setFailure({
        batch: id,
        code: e instanceof ApiError ? e.code : "",
        text: isApiError(e, "UNDO_HAS_DEPENDENTS") ? dependentsText(e) : describeError(e),
      });
      void qc.invalidateQueries({ queryKey: ["import-batches"] });
    },
  });

  // The Undo button and dialog are gone after the call: move focus to the result heading.
  useEffect(() => {
    if (done || failure) headingRef.current?.focus();
  }, [done, failure]);

  return (
    <Card title="Import batches" testId="batches">
      <div role="status" aria-live="polite" className="sr-only" data-testid="batches-announce">
        {done ? `Batch ${done.batch_id} undone, ${done.removed} rows removed.` : ""}
        {failure ? `Undo of batch ${failure.batch} failed.` : ""}
      </div>
      <p className="mb-3 text-body-sm text-text-2" data-testid="batches-note">
        Results, balance sheet, fundamentals, shareholding and corporate action batches can be
        undone for {UNDO_WINDOW_DAYS} days. An undo deletes the rows of the batch; values that the
        batch overwrote are not restored. Price, stock list, holiday, sector and manual-entry
        batches cannot be undone: import corrected data instead.
      </p>
      {done ? (
        <section
          data-testid="undo-result"
          aria-label="Undo result"
          className="mb-3 flex flex-col gap-2 rounded-card border border-border bg-surface-1 p-3"
        >
          <h3
            ref={headingRef}
            tabIndex={-1}
            data-testid="undo-result-heading"
            className={headingClass}
          >
            Batch {done.batch_id} undone
          </h3>
          <p className="text-body-sm text-text-1" data-testid="undo-removed">
            Rows removed: <Fmt f={formatCount(done.removed)} />
          </p>
          {done.warnings.map((w) => (
            <Banner key={w} tone="warn" testId={`undo-warning-${w}`}>
              {UNDO_WARNING_TEXT[w] ?? w}
              {w === "UNDO_REMOVES_EARLIER_IMPORT" && done.earlier_batch_ids.length > 0
                ? ` Earlier batches: ${done.earlier_batch_ids.join(", ")}.`
                : ""}
            </Banner>
          ))}
        </section>
      ) : null}
      {failure ? (
        <section
          data-testid="undo-failure"
          aria-label="Undo failed"
          className="mb-3 flex flex-col gap-2"
        >
          <h3 ref={headingRef} tabIndex={-1} className={headingClass}>
            Batch {failure.batch} was not undone
          </h3>
          <Banner tone="error" testId={`undo-error-${failure.code || "generic"}`}>
            {failure.text}
          </Banner>
        </section>
      ) : null}
      {q.isPending ? (
        <Skeleton label="Loading batches" className="h-24 w-full" />
      ) : q.isError ? (
        <div className="flex flex-col gap-2">
          <Banner tone="error" testId="batches-error">
            {describeError(q.error)}
          </Banner>
          <div>
            <button
              type="button"
              data-testid="batches-retry"
              onClick={() => void q.refetch()}
              className="touch-target h-9 rounded-control border border-border px-3 text-body-sm hover:bg-surface-3"
            >
              Retry
            </button>
          </div>
        </div>
      ) : q.data.length === 0 ? (
        <EmptyState message="No import batches yet. Batches appear here after the first import." />
      ) : (
        <div
          className="overflow-x-auto"
          role="region"
          aria-label="Import batches table"
          tabIndex={0}
        >
          <table className="w-full text-left text-body-sm" data-testid="batches-table">
            <caption className="sr-only">Import batches, newest first</caption>
            <thead>
              <tr className="text-caption text-text-2">
                {["Batch", "Kind", "Imported", "Rows", "Warnings", "Note", "Status"].map((h) => (
                  <th key={h} scope="col" className="py-1 pr-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.map((b) => {
                const v = undoVerdict(b);
                return (
                  <tr
                    key={b.id}
                    data-testid={`batch-row-${b.id}`}
                    className="border-t border-border"
                  >
                    <td className="py-2 pr-3 align-top">{b.id}</td>
                    <td className="py-2 pr-3 align-top">{kindName(b.kind)}</td>
                    <td className="py-2 pr-3 align-top">
                      <Fmt f={formatDate(b.created_at)} />
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <Fmt f={formatCount(b.row_count)} />
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <Fmt f={formatCount(b.warning_count)} />
                    </td>
                    <td className="py-2 pr-3 align-top">{b.note ?? DASH}</td>
                    <td className="py-2 align-top">
                      {b.undone_at !== null ? (
                        <span data-testid={`batch-undone-${b.id}`}>
                          Undone <Fmt f={formatDate(b.undone_at)} />
                        </span>
                      ) : v.undoable ? (
                        <button
                          type="button"
                          data-testid={`batch-undo-${b.id}`}
                          onClick={() => {
                            setDone(null);
                            setFailure(null);
                            setTarget(b);
                          }}
                          className="touch-target h-9 rounded-control border border-down px-3 text-body-sm hover:bg-surface-3"
                        >
                          Undo
                          <span className="sr-only">{` batch ${b.id}, ${kindName(b.kind)}`}</span>
                        </button>
                      ) : (
                        <span data-testid={`batch-no-undo-${b.id}`} className="text-text-2">
                          {v.reason}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={target !== null}
        title={target ? `Undo batch ${target.id}?` : "Undo batch?"}
        message={
          <>
            This deletes the {target ? kindName(target.kind).toLowerCase() : ""} rows saved by the
            batch and refreshes analytics. Values that this batch overwrote are <strong>not</strong>{" "}
            restored: re-import the earlier data if you need it back.
          </>
        }
        confirmLabel="Undo batch"
        danger
        busy={undo.isPending}
        onCancel={() => setTarget(null)}
        onConfirm={() => {
          if (target) once(() => undo.mutateAsync(target.id));
        }}
      />
    </Card>
  );
}
