"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/overlays";
import { fetchStockIndex, previewTrim, trimHistory } from "@/lib/imports/api";
import { describeError, fieldMessage } from "@/lib/imports/errors";
import { formatCount, formatMb } from "@/lib/imports/local-format";
import { DB_STATUS_KEY } from "./StorageMeter";

const TRACKED_FLAG = 2;
const MAX_SHOWN = 200;
const MAX_SYMBOLS = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Trim history (docs/03 section 4, decision D-C): choose stocks and a cutoff date, preview the
 * rows and MB freed, confirm in a dialog. Nothing is trimmed automatically anywhere else.
 */
export function TrimHistory() {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [before, setBefore] = useState("");
  const [local, setLocal] = useState<{ symbols?: string; before?: string }>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const qc = useQueryClient();

  const index = useQuery({
    queryKey: ["stocks", "index"],
    queryFn: fetchStockIndex,
    staleTime: 3_600_000,
  });

  const stocks = useMemo(
    () => (index.data ?? []).filter(([, , , flags]) => (flags & TRACKED_FLAG) !== 0),
    [index.data],
  );
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return stocks.filter(
      ([, s, n]) => !q || s.toLowerCase().includes(q) || n.toLowerCase().includes(q),
    );
  }, [stocks, filter]);

  const preview = useMutation({ mutationFn: () => previewTrim(selected, before) });
  const trim = useMutation({
    mutationFn: () => trimHistory(selected, before),
    onSuccess: () => {
      setConfirmOpen(false);
      preview.reset();
      void qc.invalidateQueries({ queryKey: DB_STATUS_KEY });
    },
    onError: () => setConfirmOpen(false),
  });

  const changed = () => {
    preview.reset();
    trim.reset();
  };
  const toggle = (symbol: string) => {
    setSelected((cur) =>
      cur.includes(symbol) ? cur.filter((s) => s !== symbol) : [...cur, symbol],
    );
    changed();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: { symbols?: string; before?: string } = {};
    if (selected.length === 0) errs.symbols = "Choose at least one stock.";
    if (selected.length > MAX_SYMBOLS) errs.symbols = `Choose at most ${MAX_SYMBOLS} stocks.`;
    if (!DATE_RE.test(before)) errs.before = "Enter the cutoff date.";
    setLocal(errs);
    if (errs.symbols || errs.before) return;
    trim.reset();
    preview.mutate();
  };

  const failure = preview.error ?? trim.error;
  const symbolsErr = local.symbols ?? (failure ? fieldMessage(failure, "symbols") : null);
  const beforeErr = local.before ?? (failure ? fieldMessage(failure, "before") : null);
  const generic = failure && !symbolsErr && !beforeErr ? describeError(failure) : null;
  const pv = preview.data;

  return (
    <Card title="Trim history" testId="trim-history">
      <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-3">
        <p className="text-body-sm text-text-2">
          Deletes daily prices older than the cutoff date for the stocks you choose, to free
          database space. Newer prices are kept. Nothing is trimmed automatically.
        </p>
        <FormField
          label="Find a stock"
          hint="Only stocks with imported or tracked prices are listed."
        >
          {(p) => (
            <input
              {...p}
              type="search"
              data-testid="trim-filter"
              className={inputClass}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </FormField>
        {index.isPending ? (
          <p className="text-body-sm text-text-2" data-testid="trim-loading">
            Loading the stock list.
          </p>
        ) : index.isError ? (
          <Banner tone="error" testId="trim-index-error">
            The stock list could not be loaded: {describeError(index.error)}{" "}
            <button type="button" className="underline" onClick={() => void index.refetch()}>
              Retry
            </button>
          </Banner>
        ) : stocks.length === 0 ? (
          <p className="text-body-sm text-text-2" data-testid="trim-empty">
            No stocks with prices yet. Import prices first.
          </p>
        ) : (
          <fieldset
            className="flex flex-col gap-1"
            aria-describedby={symbolsErr ? "trim-symbols-err" : undefined}
          >
            <legend className="text-caption font-medium text-text-1">
              Stocks ({formatCount(selected.length)} chosen)
            </legend>
            <div
              tabIndex={0}
              role="region"
              aria-label="Stock list"
              className="max-h-56 overflow-auto rounded-control border border-border p-2"
            >
              <ul className="flex flex-col gap-1">
                {visible.slice(0, MAX_SHOWN).map(([id, symbol, name]) => (
                  <li key={id}>
                    <label className="flex items-center gap-2 text-body-sm text-text-1">
                      <input
                        type="checkbox"
                        data-testid={`trim-stock-${symbol}`}
                        checked={selected.includes(symbol)}
                        onChange={() => toggle(symbol)}
                      />
                      <span className="font-medium">{symbol}</span>
                      <span className="truncate text-text-2">{name}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {visible.length === 0 ? (
                <p className="text-body-sm text-text-2">No stock matches the search.</p>
              ) : null}
              {visible.length > MAX_SHOWN ? (
                <p className="mt-1 text-caption text-text-2">
                  Showing the first {MAX_SHOWN} of {formatCount(visible.length)}. Narrow the search.
                </p>
              ) : null}
            </div>
            {symbolsErr ? (
              <p
                id="trim-symbols-err"
                role="alert"
                className="text-caption text-text-1"
                data-testid="trim-symbols-error"
              >
                <span className="font-medium text-down">Error: </span>
                {symbolsErr}
              </p>
            ) : null}
          </fieldset>
        )}
        <FormField label="Delete prices before" required error={beforeErr}>
          {(p) => (
            <input
              {...p}
              type="date"
              data-testid="trim-before"
              className={inputClass}
              value={before}
              onChange={(e) => {
                setBefore(e.target.value);
                changed();
              }}
            />
          )}
        </FormField>
        {generic ? (
          <Banner tone="error" testId="trim-error">
            {generic}
          </Banner>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            data-testid="trim-preview"
            disabled={preview.isPending}
            className="h-9 rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50"
          >
            {preview.isPending ? "Counting" : "Preview"}
          </button>
          {pv && pv.total_rows > 0 ? (
            <button
              type="button"
              data-testid="trim-open-confirm"
              onClick={() => setConfirmOpen(true)}
              className="h-9 rounded-control border border-down px-3 text-body-sm font-medium hover:bg-surface-3"
            >
              Trim history
            </button>
          ) : null}
        </div>
        {pv ? (
          <div role="status" data-testid="trim-preview-result" className="flex flex-col gap-2">
            <p className="text-body-sm text-text-1">
              {pv.total_rows === 0
                ? `No prices older than ${before} for the chosen stocks. Nothing to delete.`
                : `${formatCount(pv.total_rows)} rows would be deleted, freeing about ${formatMb(pv.estimated_mb_freed)} (estimate, about 130 bytes per row).`}
            </p>
            {pv.total_rows > 0 ? (
              <table className="w-full max-w-sm text-left text-body-sm">
                <caption className="sr-only">Rows to delete per stock</caption>
                <thead className="text-text-2">
                  <tr>
                    <th scope="col" className="px-2 py-1 font-medium">
                      Stock
                    </th>
                    <th scope="col" className="px-2 py-1 font-medium">
                      Rows
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pv.per_symbol.map((r) => (
                    <tr key={r.symbol} className="border-t border-border">
                      <td className="px-2 py-1">{r.symbol}</td>
                      <td className="px-2 py-1 tabular-nums">{formatCount(r.rows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ) : null}
        {trim.isSuccess ? (
          <Banner tone="info" testId="trim-done">
            {trim.data.deleted === 0
              ? "Nothing was deleted."
              : `Deleted ${formatCount(trim.data.deleted)} rows. Analytics are being recomputed.`}
          </Banner>
        ) : null}
      </form>
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete ${formatCount(pv?.total_rows ?? null)} rows?`}
        message={`Prices before ${before} are deleted for ${formatCount(selected.length)} stocks, freeing about ${formatMb(pv?.estimated_mb_freed ?? null)}. This cannot be undone; re-import the files to bring them back.`}
        confirmLabel="Trim history"
        danger
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => trim.mutate()}
      />
    </Card>
  );
}
