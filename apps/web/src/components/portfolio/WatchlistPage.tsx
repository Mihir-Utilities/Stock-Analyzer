"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, ToastProvider, useToast } from "@/components/ui/overlays";
import { FormField, inputClass } from "@/components/ui/FormField";
import { describeError, asOfText } from "@/lib/dashboard/state";
import { formatInr, formatNumber, formatPercent } from "@/lib/format";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { useAddWatch, usePatchWatch, useRemoveWatch, useWatchlistFull } from "@/lib/portfolio/api";
import type { WatchFundRow, WatchStockRow } from "@/lib/portfolio/schemas";
import { describeTxnError } from "@/lib/portfolio/txn-form";
import { MANUAL_PRICE_NOTE, reasonText } from "./text";

const BUTTON =
  "h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50";

function NoteEditor({ id, note, label }: { id: number; note: string; label: string }) {
  const patch = usePatchWatch();
  const toast = useToast();
  const [value, setValue] = useState(note);
  const [err, setErr] = useState<string | null>(null);
  const single = useSingleFlight();
  const dirty = value !== note;
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        single(async () => {
          try {
            await patch.mutateAsync({ id, note: value });
            setErr(null);
            toast(`Note saved for ${label}.`);
          } catch (e2) {
            setErr(describeTxnError(e2).message);
          }
        });
      }}
    >
      <div className="flex items-center gap-2">
        <input
          aria-label={`Note for ${label}`}
          data-testid={`watch-note-${id}`}
          className={inputClass}
          maxLength={500}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="submit"
          data-testid={`watch-note-save-${id}`}
          disabled={!dirty || patch.isPending}
          aria-label={`Save note for ${label}`}
          className={BUTTON}
        >
          Save
        </button>
      </div>
      {err ? (
        <span role="alert" className="text-caption text-text-1">
          Error: {err}
        </span>
      ) : null}
    </form>
  );
}

function StockRows({
  rows,
  onRemove,
}: {
  rows: WatchStockRow[];
  onRemove: (r: { id: number; label: string }) => void;
}) {
  return (
    <ul className="flex flex-col" aria-label="Watched stocks" data-testid="watch-stocks">
      {rows.map((r) => {
        const ch = formatPercent(r.change_pct ?? null, {
          signed: true,
          ...(reasonText(r.change_reason) ? { reason: reasonText(r.change_reason) as string } : {}),
        });
        return (
          <li
            key={r.id}
            className="flex flex-col gap-2 border-t border-border py-3"
            data-testid={`watch-stock-${r.symbol}`}
          >
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <Link
                href={`/stocks/${encodeURIComponent(r.symbol)}`}
                className="touch-target inline-flex items-center font-medium text-accent underline"
              >
                {r.symbol}
              </Link>
              <span className="text-body-sm text-text-2">{r.name}</span>
              <span className="num text-body-sm">
                Close {formatInr(r.ltp ?? null, { reason: "no valid close imported" }).text}
                {r.price_stale ? " (stale)" : ""} as of {asOfText(r.ltp_as_of) ?? "unknown"}
              </span>
              <span className="num text-body-sm" title={ch.reason ?? undefined}>
                Day change {ch.text}
                {ch.reason ? ` (${ch.reason})` : ""}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <NoteEditor id={r.id} note={r.note ?? ""} label={r.symbol} />
              <button
                type="button"
                data-testid={`watch-remove-${r.symbol}`}
                aria-label={`Remove ${r.symbol} from the watchlist`}
                className={BUTTON}
                onClick={() => onRemove({ id: r.id, label: r.symbol })}
              >
                Remove
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function FundRows({
  rows,
  onRemove,
}: {
  rows: WatchFundRow[];
  onRemove: (r: { id: number; label: string }) => void;
}) {
  return (
    <ul className="flex flex-col" aria-label="Watched funds" data-testid="watch-funds">
      {rows.map((r) => (
        <li
          key={r.id}
          className="flex flex-col gap-2 border-t border-border py-3"
          data-testid={`watch-fund-${r.code}`}
        >
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-medium">{r.name}</span>
            <span className="num text-body-sm">
              NAV {formatNumber(r.nav ?? null, { decimals: 4, reason: "no NAV stored" }).text} as of{" "}
              {asOfText(r.nav_date) ?? "unknown"}
            </span>
            <span className="num text-body-sm">
              Day change{" "}
              {
                formatPercent(r.change_pct ?? null, {
                  signed: true,
                  reason: reasonText(r.change_reason) ?? "no earlier NAV",
                }).text
              }
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <NoteEditor id={r.id} note={r.note ?? ""} label={r.name} />
            <button
              type="button"
              data-testid={`watch-remove-fund-${r.code}`}
              aria-label={`Remove ${r.name} from the watchlist`}
              className={BUTTON}
              onClick={() => onRemove({ id: r.id, label: r.name })}
            >
              Remove
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AddForm() {
  const add = useAddWatch();
  const toast = useToast();
  const single = useSingleFlight();
  const [symbol, setSymbol] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    single(async () => {
      const sym = symbol.trim().toUpperCase();
      if (sym === "") {
        setErr("Enter the exchange symbol, for example TCS.");
        return;
      }
      try {
        await add.mutateAsync({ symbol: sym, note });
        toast(`${sym} added to the watchlist.`);
        setSymbol("");
        setNote("");
        setErr(null);
      } catch (e2) {
        setErr(describeTxnError(e2).message);
      }
    });
  };
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      data-testid="watch-add-form"
      aria-label="Add a stock to the watchlist"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Symbol" required error={err}>
          {(p) => (
            <input
              {...p}
              data-testid="watch-symbol"
              className={inputClass}
              autoComplete="off"
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value.toUpperCase());
                setErr(null);
              }}
            />
          )}
        </FormField>
        <FormField label="Note">
          {(p) => (
            <input
              {...p}
              data-testid="watch-add-note"
              className={inputClass}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </FormField>
      </div>
      <div>
        <button
          type="submit"
          data-testid="watch-add"
          disabled={add.isPending}
          className={`${BUTTON} border-accent font-medium`}
        >
          Add to watchlist
        </button>
      </div>
    </form>
  );
}

function Body() {
  const q = useWatchlistFull();
  const remove = useRemoveWatch();
  const toast = useToast();
  const [target, setTarget] = useState<{ id: number; label: string } | null>(null);
  const [removeErr, setRemoveErr] = useState<string | null>(null);

  let list;
  if (q.isPending) list = <Card title="Watchlist" state="loading" testId="watch-card" />;
  else if (q.isError) {
    const u = describeError(q.error, "The watchlist");
    list = (
      <Card
        title="Watchlist"
        state={u.state}
        message={u.message}
        onRetry={() => void q.refetch()}
        testId="watch-card"
      />
    );
  } else {
    const { stocks, funds } = q.data.data;
    const empty = stocks.length === 0 && funds.length === 0;
    list = (
      <Card
        title="Watchlist"
        state={empty ? "empty" : "ready"}
        message="Nothing on your watchlist yet. Add a stock below."
        source="Your imported prices and NAV files"
        asOf={asOfText(q.data.meta?.as_of ?? null)}
        testId="watch-card"
      >
        {stocks.length > 0 ? <StockRows rows={stocks} onRemove={setTarget} /> : null}
        {funds.length > 0 ? (
          <>
            <h2 className="mt-3 text-body font-semibold">Funds</h2>
            <FundRows rows={funds} onRemove={setTarget} />
          </>
        ) : null}
      </Card>
    );
  }
  return (
    <>
      {removeErr ? (
        <Banner tone="error" testId="watch-remove-error">
          {removeErr}
        </Banner>
      ) : null}
      {list}
      <AddForm />
      <ConfirmDialog
        open={target !== null}
        title="Remove from the watchlist?"
        message={`${target?.label ?? ""} stays in your imported data; only the watchlist entry is removed.`}
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onConfirm={() => {
          if (!target) return;
          remove.mutate(target.id, {
            onSuccess: () => {
              toast(`${target.label} removed.`);
              setTarget(null);
              setRemoveErr(null);
            },
            onError: (e) => {
              setRemoveErr(describeTxnError(e).message);
              setTarget(null);
            },
          });
        }}
        onCancel={() => setTarget(null)}
      />
    </>
  );
}

/** Watchlist screen: stocks and funds with the latest close or NAV (manual price mode). */
export function WatchlistPage() {
  return (
    <ToastProvider>
      <div className="flex flex-col gap-4" data-testid="watchlist-page">
        <h1 className="text-page font-semibold text-text-1">Watchlist</h1>
        <p className="text-body-sm text-text-2">{MANUAL_PRICE_NOTE}</p>
        <Body />
      </div>
    </ToastProvider>
  );
}
