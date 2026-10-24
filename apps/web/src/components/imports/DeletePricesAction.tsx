"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/overlays";
import { deletePrices, previewDeletePrices } from "@/lib/imports/api";
import { describeError, fieldMessage, isApiError } from "@/lib/imports/errors";
import { formatCount } from "@/lib/imports/local-format";
import { DB_STATUS_KEY } from "./StorageMeter";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Delete prices between {from} and {to}" (docs/03 section 4, PRC-21): preview the row count,
 * confirm, delete. With a `symbol` prop it is the action of the stock Data tab (F08 mounts it
 * there, assumption F13a-6); without one it asks for the symbol (Storage tab).
 */
export function DeletePricesAction({ symbol: fixedSymbol }: { symbol?: string }) {
  const [typed, setTyped] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const qc = useQueryClient();
  const symbol = (fixedSymbol ?? typed).trim().toUpperCase();

  const preview = useMutation({
    mutationFn: () => previewDeletePrices(symbol, from, to),
    onSuccess: (d) => setRows(d.rows),
  });
  const del = useMutation({
    mutationFn: () => deletePrices(symbol, from, to),
    onSuccess: () => {
      setConfirmOpen(false);
      setRows(null);
      void qc.invalidateQueries({ queryKey: DB_STATUS_KEY });
      void qc.invalidateQueries({ queryKey: ["stocks"] });
    },
    onError: () => setConfirmOpen(false),
  });

  const reset = () => {
    setRows(null);
    preview.reset();
    del.reset();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!symbol) errs.symbol = "Enter the stock symbol.";
    if (!DATE_RE.test(from)) errs.from = "Enter the first date to delete.";
    if (!DATE_RE.test(to)) errs.to = "Enter the last date to delete.";
    if (!errs.from && !errs.to && from > to)
      errs.to = "The last date must not be before the first date.";
    setLocal(errs);
    if (Object.keys(errs).length > 0) return;
    del.reset();
    preview.mutate();
  };

  const notFound = isApiError(preview.error, "NOT_FOUND") || isApiError(del.error, "NOT_FOUND");
  const failure = preview.error ?? del.error;
  const fieldErr = (f: string) => local[f] ?? (failure ? fieldMessage(failure, f) : null);
  const generic =
    failure && !notFound && !["symbol", "from", "to"].some((f) => fieldMessage(failure, f))
      ? describeError(failure)
      : null;

  return (
    <Card title="Delete prices between two dates" testId="delete-prices">
      <form onSubmit={submit} noValidate className="flex max-w-lg flex-col gap-3">
        <p className="text-body-sm text-text-2">
          Removes imported daily prices of one stock, both dates included. You see the row count
          first, and analytics are recomputed afterwards.
        </p>
        {fixedSymbol ? (
          <p className="text-body-sm text-text-1">
            Stock: <span className="font-medium">{fixedSymbol}</span>
          </p>
        ) : (
          <FormField label="Symbol" required error={fieldErr("symbol")}>
            {(p) => (
              <input
                {...p}
                data-testid="delete-symbol"
                className={inputClass}
                autoComplete="off"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  reset();
                }}
              />
            )}
          </FormField>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="From" required error={fieldErr("from")}>
            {(p) => (
              <input
                {...p}
                type="date"
                data-testid="delete-from"
                className={inputClass}
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  reset();
                }}
              />
            )}
          </FormField>
          <FormField label="To" required error={fieldErr("to")}>
            {(p) => (
              <input
                {...p}
                type="date"
                data-testid="delete-to"
                className={inputClass}
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  reset();
                }}
              />
            )}
          </FormField>
        </div>
        {notFound ? (
          <Banner tone="error" testId="delete-not-found">
            This stock was not found. Use its current symbol, not an old one.
          </Banner>
        ) : null}
        {generic ? (
          <Banner tone="error" testId="delete-error">
            {generic}
          </Banner>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            data-testid="delete-preview"
            disabled={preview.isPending}
            className="h-9 rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50"
          >
            {preview.isPending ? "Counting" : "Preview rows"}
          </button>
          {rows !== null && rows > 0 ? (
            <button
              type="button"
              data-testid="delete-open-confirm"
              onClick={() => setConfirmOpen(true)}
              className="h-9 rounded-control border border-down px-3 text-body-sm font-medium hover:bg-surface-3"
            >
              Delete {formatCount(rows)} rows
            </button>
          ) : null}
        </div>
        {rows !== null ? (
          <p role="status" data-testid="delete-preview-result" className="text-body-sm text-text-1">
            {rows === 0
              ? `No rows of ${symbol} between ${from} and ${to}. Nothing to delete.`
              : `${formatCount(rows)} rows of ${symbol} between ${from} and ${to} would be deleted.`}
          </p>
        ) : null}
        {del.isSuccess ? (
          <Banner tone="info" testId="delete-done">
            Deleted {formatCount(del.data.deleted)} rows.
            {del.data.job_id !== null ? " Analytics are being recomputed." : ""}
          </Banner>
        ) : null}
      </form>
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete ${formatCount(rows)} rows of ${symbol}?`}
        message={`Prices from ${from} to ${to} are deleted. This cannot be undone; re-import the file to bring them back.`}
        confirmLabel="Delete prices"
        danger
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => del.mutate()}
      />
    </Card>
  );
}
