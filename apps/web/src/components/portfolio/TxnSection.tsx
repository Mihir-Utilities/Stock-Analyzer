"use client";

import { useMemo, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/Skeleton";
import { describeError } from "@/lib/dashboard/state";
import { formatDate } from "@/lib/format";
import { useDeleteTxn, useTxns } from "@/lib/portfolio/api";
import { tradeAmount } from "@/lib/portfolio/decimal";
import type { Txn } from "@/lib/portfolio/schemas";
import { describeTxnError } from "@/lib/portfolio/txn-form";
import { inr, PORTFOLIO_SOURCE, qty } from "./text";
import { TxnForm } from "./TxnForm";

const BUTTON =
  "h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50";
const FIELD =
  "h-9 touch-target min-w-0 rounded-control border border-border bg-surface-1 px-2 text-body-sm text-text-1";

export function TxnSection({ symbols }: { symbols: ReadonlyArray<string> }) {
  const toast = useToast();
  const [symbolFilter, setSymbolFilter] = useState("");
  const [side, setSide] = useState<"all" | "buy" | "sell">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Txn | null>(null);
  const [deleting, setDeleting] = useState<Txn | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const q = useTxns(symbolFilter.trim().toUpperCase());
  const del = useDeleteTxn();

  const rows = useMemo(() => {
    const all = (q.data?.pages ?? []).flatMap((p) => p.data.items);
    return all.filter(
      (t) =>
        (side === "all" || t.side === side) &&
        (from === "" || t.trade_date >= from) &&
        (to === "" || t.trade_date <= to),
    );
  }, [q.data, side, from, to]);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await del.mutateAsync(deleting.id);
      toast(`Transaction deleted: ${deleting.side} ${deleting.symbol}.`);
      setDeleting(null);
      setDeleteError(null);
    } catch (err) {
      setDeleteError(describeTxnError(err).message);
      setDeleting(null);
    }
  };

  let body;
  if (q.isPending) {
    body = <Skeleton className="h-24 w-full" label="Loading transactions" />;
  } else if (q.isError) {
    const u = describeError(q.error, "Transactions");
    body = (
      <div className="flex flex-col items-start gap-2">
        <Banner tone={u.state === "error" ? "error" : "info"}>{u.message}</Banner>
        <button
          type="button"
          data-testid="txn-retry"
          onClick={() => void q.refetch()}
          className={BUTTON}
        >
          Try again
        </button>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <p className="text-body-sm text-text-2" data-testid="txn-empty">
        {q.data.pages[0]?.data.items.length
          ? "No transaction matches these filters."
          : "No transactions yet. Add one above."}
      </p>
    );
  } else {
    body = (
      <div className="overflow-x-auto" role="region" aria-label="Transactions table" tabIndex={0}>
        <table className="w-full min-w-[44rem] text-body-sm" data-testid="txn-table">
          <caption className="sr-only">Transactions, newest first</caption>
          <thead>
            <tr className="text-left text-caption text-text-2">
              <th scope="col" className="p-2">
                Date
              </th>
              <th scope="col" className="p-2">
                Symbol
              </th>
              <th scope="col" className="p-2">
                Side
              </th>
              <th scope="col" className="p-2 text-right">
                Qty
              </th>
              <th scope="col" className="p-2 text-right">
                Price (INR)
              </th>
              <th scope="col" className="p-2 text-right">
                Fees (INR)
              </th>
              <th scope="col" className="p-2 text-right">
                Amount (INR)
              </th>
              <th scope="col" className="p-2">
                Note
              </th>
              <th scope="col" className="p-2">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} data-testid={`txn-row-${t.id}`} className="border-t border-border">
                <td className="p-2">{formatDate(t.trade_date).text}</td>
                <td className="p-2">{t.symbol}</td>
                <td className="p-2">{t.side === "buy" ? "Buy" : "Sell"}</td>
                <td className="num p-2 text-right">{qty(t.qty)}</td>
                <td className="num p-2 text-right">{inr(t.price).text}</td>
                <td className="num p-2 text-right">{inr(t.fees).text}</td>
                <td className="num p-2 text-right">
                  {inr(tradeAmount(t.side, t.qty, t.price, t.fees)).text}
                </td>
                <td className="p-2">{t.note ?? ""}</td>
                <td className="p-2">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      data-testid={`txn-edit-${t.id}`}
                      aria-label={`Edit ${t.side} ${t.symbol} on ${formatDate(t.trade_date).text}`}
                      className={BUTTON}
                      onClick={() => {
                        setEditing(t);
                        setAdding(false);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      data-testid={`txn-delete-${t.id}`}
                      aria-label={`Delete ${t.side} ${t.symbol} on ${formatDate(t.trade_date).text}`}
                      className={BUTTON}
                      onClick={() => setDeleting(t)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.hasNextPage ? (
          <button
            type="button"
            data-testid="txn-load-more"
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
            className={`${BUTTON} mt-2`}
          >
            {q.isFetchingNextPage ? "Loading..." : "Load more"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <section aria-labelledby="pf-txns-h" className="flex flex-col gap-3" data-testid="pf-txns">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pf-txns-h" className="text-lead font-semibold">
          Transactions
        </h2>
        {!adding && !editing ? (
          <button
            type="button"
            data-testid="txn-add"
            onClick={() => setAdding(true)}
            className={BUTTON}
          >
            Add transaction
          </button>
        ) : null}
      </div>
      {adding ? <TxnForm editing={null} symbols={symbols} onDone={() => setAdding(false)} /> : null}
      {editing ? (
        <TxnForm
          key={editing.id}
          editing={editing}
          symbols={symbols}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {deleteError ? (
        <Banner tone="error" testId="txn-delete-error">
          {deleteError}
        </Banner>
      ) : null}
      <Card title="Transaction list" source={PORTFOLIO_SOURCE} asOf={null} testId="pf-txn-list">
        <div
          className="mb-3 flex flex-wrap items-end gap-3"
          role="group"
          aria-label="Transaction filters"
        >
          <label className="flex flex-col gap-1 text-caption text-text-2">
            Symbol
            <input
              data-testid="txn-filter-symbol"
              className={FIELD}
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-caption text-text-2">
            Side
            <select
              data-testid="txn-filter-side"
              className={FIELD}
              value={side}
              onChange={(e) =>
                setSide(
                  e.target.value === "buy" ? "buy" : e.target.value === "sell" ? "sell" : "all",
                )
              }
            >
              <option value="all">All</option>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-caption text-text-2">
            From
            <input
              type="date"
              data-testid="txn-filter-from"
              className={FIELD}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-caption text-text-2">
            To
            <input
              type="date"
              data-testid="txn-filter-to"
              className={FIELD}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        {body}
      </Card>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this transaction?"
        message={
          deleting
            ? `${deleting.side === "buy" ? "Buy" : "Sell"} ${qty(deleting.qty)} ${deleting.symbol} on ${formatDate(deleting.trade_date).text}. The holdings sequence for this stock is re-checked; the delete is refused if a later sell would exceed what you hold.`
            : ""
        }
        confirmLabel="Delete"
        danger
        busy={del.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}
