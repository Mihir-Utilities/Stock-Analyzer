"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/Skeleton";
import { describeError } from "@/lib/dashboard/state";
import { DASH, formatDate, type Formatted } from "@/lib/format";
import {
  EMPTY_FILTERS,
  useDeleteMfTxn,
  useMfSchemeOptions,
  useMfTxns,
  type MfTxnFilters,
} from "@/lib/portfolio/mf-api";
import {
  describeMfError,
  MF_TXN_TYPES,
  typeLabel,
  uneditableReason,
} from "@/lib/portfolio/mf-form";
import {
  mfHoldingSchema,
  mfTxnSchema,
  readRows,
  type MfHolding,
  type MfTxn,
} from "@/lib/portfolio/mf-schemas";
import { inr, MF_STATEMENT_SOURCE, optionLabel, planLabel, qty } from "./text";
import { Cell } from "./ViewCards";
import { MfMappingsPanel } from "./MfMappingsPanel";
import { MfTxnForm } from "./MfTxnForm";

/** A text value, or a dash with its reason when it could not be read. */
function textOrDash(v: string | null | undefined, reason: string): Formatted {
  return v === null || v === undefined || v === ""
    ? { text: DASH, reason, direction: "flat" }
    : { text: v, reason: null, direction: "flat" };
}

const BUTTON =
  "h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50";
const FIELD =
  "h-9 touch-target min-w-0 max-w-full rounded-control border border-border bg-surface-1 px-2 text-body-sm text-text-1";

/** MF transactions: list with filters, add/edit/delete, the statement import entry (docs/06 6.7a). */
export function MfTxnSection({ schemes }: { schemes: ReadonlyArray<MfHolding> }) {
  const toast = useToast();
  const [filters, setFilters] = useState<MfTxnFilters>(EMPTY_FILTERS);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MfTxn | null>(null);
  const [deleting, setDeleting] = useState<MfTxn | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const focusBack = useRef<"add" | number | null>(null);
  const q = useMfTxns(filters);
  const del = useDeleteMfTxn();
  const addRef = useRef<HTMLButtonElement>(null);
  const focusAfterDelete = useRef(false);
  // The folio box is typed into: the list is asked only when typing pauses.
  const [folioText, setFolioText] = useState("");
  useEffect(() => {
    const t = setTimeout(
      () => setFilters((f) => (f.folio === folioText ? f : { ...f, folio: folioText })),
      350,
    );
    return () => clearTimeout(t);
  }, [folioText]);

  // Every scheme ever held, exited ones too, so an exited scheme's transactions stay reachable.
  const options = useMfSchemeOptions();
  const schemeOptions = useMemo(() => {
    const byCode = new Map<number, MfHolding>();
    for (const h of readRows(mfHoldingSchema, options.data?.data.items).rows) {
      byCode.set(h.scheme_code, h);
    }
    for (const h of schemes) byCode.set(h.scheme_code, h);
    return [...byCode.values()].sort((a, b) => a.scheme_name.localeCompare(b.scheme_name));
  }, [options.data, schemes]);

  // After a delete the row that had focus is gone: focus goes to the Add button.
  useEffect(() => {
    if (!focusAfterDelete.current || deleting !== null) return;
    addRef.current?.focus();
    focusAfterDelete.current = false;
  }, [deleting]);

  // Focus returns to the control that opened the form once it has closed.
  useEffect(() => {
    const target = focusBack.current;
    if (target === null || adding || editing) return;
    const id = target === "add" ? "pf-mf-txn-add" : `pf-mf-txn-edit-${target}`;
    const el =
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`) ??
      document.querySelector<HTMLElement>(`[data-testid="pf-mf-txn-add"]`);
    el?.focus();
    focusBack.current = null;
  }, [adding, editing]);

  const closeForm = (from: "add" | number, reason: "saved" | "cancelled") => {
    setAnnounce(
      reason === "saved"
        ? "Transaction updated."
        : from === "add"
          ? "Add transaction form closed."
          : "Edit cancelled, no changes saved.",
    );
    setAdding(false);
    setEditing(null);
    focusBack.current = from;
  };

  const parsed = useMemo(() => {
    const all = (q.data?.pages ?? []).flatMap((p) => p.data.items);
    return readRows(mfTxnSchema, all);
  }, [q.data]);

  const set = <K extends keyof MfTxnFilters>(k: K, v: MfTxnFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await del.mutateAsync(deleting.id);
      toast(
        `Transaction deleted: ${typeLabel(deleting.txn_type).toLowerCase()} in ${deleting.scheme_name}.`,
      );
      setDeleting(null);
      setDeleteError(null);
      focusAfterDelete.current = true;
    } catch (err) {
      setDeleteError(describeMfError(err).message);
      setDeleting(null);
    }
  };

  const loadMore = q.hasNextPage ? (
    <button
      type="button"
      data-testid="pf-mf-txn-more"
      disabled={q.isFetchingNextPage}
      onClick={() => void q.fetchNextPage()}
      className={`${BUTTON} mt-2`}
    >
      {q.isFetchingNextPage ? "Loading..." : "Load more"}
    </button>
  ) : null;

  let body;
  if (q.isPending) {
    body = <Skeleton className="h-24 w-full" label="Loading mutual fund transactions" />;
  } else if (q.isError) {
    const u = describeError(q.error, "Mutual fund transactions");
    body = (
      <div className="flex flex-col items-start gap-2">
        <Banner tone={u.state === "error" ? "error" : "info"}>{u.message}</Banner>
        <button
          type="button"
          data-testid="pf-mf-txn-retry"
          onClick={() => void q.refetch()}
          className={BUTTON}
        >
          Try again
        </button>
      </div>
    );
  } else if (parsed.rows.length === 0) {
    const filtered = Object.values(filters).some((v) => v !== "");
    body = (
      <div className="flex flex-col items-start gap-2">
        <p className="text-body-sm text-text-2" data-testid="pf-mf-txn-empty">
          {filtered
            ? "No transaction matches these filters."
            : "No mutual fund transactions yet. Import your broker's MF statement or add a transaction."}
        </p>
        {loadMore}
      </div>
    );
  } else {
    body = (
      <div
        className="relative overflow-x-auto"
        role="region"
        aria-label="Mutual fund transactions table"
        tabIndex={0}
      >
        {parsed.bad > 0 ? (
          <Banner tone="warn" testId="pf-mf-txn-bad-rows">
            {parsed.bad} rows could not be read and are left out of this list.
          </Banner>
        ) : null}
        <table className="w-full min-w-[56rem] text-body-sm" data-testid="pf-mf-txn-table">
          <caption className="sr-only">Mutual fund transactions, newest first</caption>
          <thead>
            <tr className="text-left text-caption text-text-2">
              {[
                "Date",
                "Scheme",
                "Folio",
                "Type",
                "Units",
                "NAV",
                "Amount",
                "Stamp duty",
                "Source",
                "",
              ].map((h, i) => (
                <th key={`${h}-${i}`} scope="col" className="p-2 font-medium">
                  {h || <span className="sr-only">Actions</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {parsed.rows.map((t) => (
              <tr
                key={t.id}
                data-testid={`pf-mf-txn-row-${t.id}`}
                className="border-t border-border align-top"
              >
                <td className="p-2">{formatDate(t.txn_date).text}</td>
                <td className="p-2">
                  {t.scheme_name}
                  <div className="text-caption text-text-2">
                    {planLabel(t.plan)}, {optionLabel(t.option)}
                  </div>
                  {t.isin ? (
                    <div
                      className="text-caption text-text-2"
                      data-testid={`pf-mf-txn-isin-${t.id}`}
                    >
                      ISIN {t.isin}
                    </div>
                  ) : null}
                  {t.note ? (
                    <div
                      className="text-caption text-text-2"
                      data-testid={`pf-mf-txn-note-${t.id}`}
                    >
                      Note: {t.note}
                    </div>
                  ) : null}
                  {uneditableReason(t) ? (
                    <div
                      className="text-caption text-text-2"
                      data-testid={`pf-mf-txn-locked-${t.id}`}
                    >
                      Cannot be edited: {uneditableReason(t)}
                    </div>
                  ) : null}
                </td>
                <td className="p-2">
                  <Cell f={textOrDash(t.folio, "the folio could not be read")} />
                </td>
                <td className="p-2">{typeLabel(t.txn_type)}</td>
                <td className="num p-2">{qty(t.units)}</td>
                <td className="num p-2">{inr(t.nav).text}</td>
                <td className="num p-2">{inr(t.amount).text}</td>
                <td className="num p-2">
                  <Cell f={inr(t.stamp_duty, { reason: "the stamp duty could not be read" })} />
                </td>
                <td className="p-2">
                  {t.source === "import" ? "statement import" : "your entry"}
                  {t.import_batch_id ? ` (batch ${t.import_batch_id})` : ""}
                </td>
                <td className="whitespace-nowrap p-2">
                  <button
                    type="button"
                    data-testid={`pf-mf-txn-edit-${t.id}`}
                    disabled={uneditableReason(t) !== null}
                    onClick={() => {
                      setAdding(false);
                      setEditing(t);
                    }}
                    className={BUTTON}
                  >
                    Edit
                    <span className="sr-only">{` ${typeLabel(t.txn_type)} on ${formatDate(t.txn_date).text}`}</span>
                  </button>{" "}
                  <button
                    type="button"
                    data-testid={`pf-mf-txn-delete-${t.id}`}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(t);
                    }}
                    className={`${BUTTON} border-down`}
                  >
                    Delete
                    <span className="sr-only">{` ${typeLabel(t.txn_type)} on ${formatDate(t.txn_date).text}`}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loadMore}
      </div>
    );
  }

  return (
    <Card
      title="Mutual fund transactions"
      source={MF_STATEMENT_SOURCE}
      asOf={null}
      testId="pf-mf-txn-card"
      actions={
        <>
          <Link
            href="/imports?kind=mf_statement"
            data-testid="pf-mf-import-open"
            className={`${BUTTON} inline-flex items-center`}
          >
            Import statement
          </Link>
          <button
            type="button"
            data-testid="pf-mf-txn-add"
            ref={addRef}
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
            className={`${BUTTON} border-accent font-medium`}
          >
            Add MF transaction
          </button>
        </>
      }
    >
      <div role="status" aria-live="polite" className="sr-only" data-testid="pf-mf-txn-announce">
        {announce}
      </div>
      <div className="flex flex-col gap-3">
        {deleteError ? (
          <Banner tone="error" testId="pf-mf-txn-delete-error">
            {deleteError}
          </Banner>
        ) : null}
        {adding ? <MfTxnForm editing={null} onDone={(r) => closeForm("add", r)} /> : null}
        {editing ? (
          <MfTxnForm key={editing.id} editing={editing} onDone={(r) => closeForm(editing.id, r)} />
        ) : null}
        <div
          className="flex flex-wrap items-end gap-2"
          role="group"
          aria-label="Filters"
          data-testid="pf-mf-txn-filters"
        >
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-caption text-text-2">
            Scheme
            <select
              data-testid="pf-mf-filter-scheme"
              className={FIELD}
              value={filters.schemeCode}
              onChange={(e) => set("schemeCode", e.target.value)}
            >
              <option value="">All schemes</option>
              {schemeOptions.map((s) => (
                <option key={s.scheme_code} value={String(s.scheme_code)}>
                  {s.scheme_name} ({planLabel(s.plan)}, {optionLabel(s.option)})
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-caption text-text-2">
            Folio
            <input
              data-testid="pf-mf-filter-folio"
              className={FIELD}
              value={folioText}
              onChange={(e) => setFolioText(e.target.value)}
            />
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-caption text-text-2">
            Type
            <select
              data-testid="pf-mf-filter-type"
              className={FIELD}
              value={filters.type}
              onChange={(e) => set("type", e.target.value)}
            >
              <option value="">All types</option>
              {MF_TXN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-caption text-text-2">
            From
            <input
              type="date"
              data-testid="pf-mf-filter-from"
              className={FIELD}
              value={filters.from}
              onChange={(e) => set("from", e.target.value)}
            />
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-caption text-text-2">
            To
            <input
              type="date"
              data-testid="pf-mf-filter-to"
              className={FIELD}
              value={filters.to}
              onChange={(e) => set("to", e.target.value)}
            />
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-caption text-text-2">
            Source
            <select
              data-testid="pf-mf-filter-source"
              className={FIELD}
              value={filters.source}
              onChange={(e) => set("source", e.target.value)}
            >
              <option value="">Any</option>
              <option value="manual">Your entries</option>
              <option value="import">Statement imports</option>
            </select>
          </label>
        </div>
        <div data-testid="pf-mf-txn-list">{body}</div>
        <MfMappingsPanel />
      </div>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this transaction?"
        message={
          deleting
            ? `Delete the ${typeLabel(deleting.txn_type).toLowerCase()} of ${qty(deleting.units)} units in ${deleting.scheme_name}, folio ${deleting.folio ?? DASH}. Every later redemption of this scheme and folio is re-checked; if one would then exceed the units held, nothing is deleted.`
            : ""
        }
        confirmLabel="Delete"
        danger
        busy={del.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </Card>
  );
}
