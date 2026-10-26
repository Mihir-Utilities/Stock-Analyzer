"use client";

import { useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { FormField, inputClass } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/overlays";
import { describeError, istDate } from "@/lib/dashboard/state";
import { formatDate } from "@/lib/format";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { useAdjustments, useCreateAdjustment } from "@/lib/portfolio/api";
import { isPlainDecimal, toDec } from "@/lib/portfolio/decimal";
import type { Adjustment, PortfolioSummary } from "@/lib/portfolio/schemas";
import { describeTxnError } from "@/lib/portfolio/txn-form";
import { inr, PORTFOLIO_SOURCE } from "./text";

const SOURCE_LABEL: Record<string, { text: string; tone: "neutral" | "warn" }> = {
  override: { text: "Your override", tone: "neutral" },
  confirmed_action: { text: "Confirmed action, applied", tone: "neutral" },
  review_needed: { text: "Review needed: confirmed but not applied", tone: "warn" },
  detected_unconfirmed: { text: "Unconfirmed: detected, not applied", tone: "warn" },
};

const TYPE_LABEL: Record<string, string> = {
  split: "Split",
  bonus: "Bonus",
  split_or_bonus: "Split or bonus",
  merger: "Merger",
  rights: "Rights",
  demerger: "Demerger",
};

function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t.replace(/_/g, " ");
}

function AdjRow({ a }: { a: Adjustment }) {
  const src = SOURCE_LABEL[a.source] ?? {
    text: a.source.replace(/_/g, " "),
    tone: "neutral" as const,
  };
  return (
    <li
      className="flex flex-wrap items-center gap-2 border-t border-border py-2 text-body-sm"
      data-testid={`adj-row-${a.symbol}-${a.date}`}
      data-source={a.source}
    >
      <span className="font-medium">{a.symbol}</span>
      <span>{typeLabel(a.type)}</span>
      <span>{formatDate(a.date).text}</span>
      <span className="num">
        {a.multiplier ? `quantity x ${a.multiplier}` : "no ratio on file"}
      </span>
      <span
        data-testid="adj-badge"
        className={`inline-flex items-center rounded-chip border bg-surface-2 px-2 py-0.5 text-micro text-text-1 ${src.tone === "warn" ? "border-warn" : "border-border"}`}
      >
        {src.text}
      </span>
      {a.note ? <span className="text-text-2">{a.note}</span> : null}
    </li>
  );
}

/** Applied and pending adjustments, plus the owner override form (docs/06 section 6.7). */
export function AdjustmentsPanel() {
  const q = useAdjustments();
  const create = useCreateAdjustment();
  const toast = useToast();
  const single = useSingleFlight();
  const [symbol, setSymbol] = useState("");
  const [date, setDate] = useState("");
  const [mult, setMult] = useState("");
  const [note, setNote] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [serverErr, setServerErr] = useState<string | null>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    single(async () => {
      const next: Record<string, string> = {};
      const sym = symbol.trim().toUpperCase();
      if (sym === "") next["symbol"] = "Enter the symbol.";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) next["date"] = "Choose the ex-date.";
      else if (date > istDate(new Date())) next["date"] = "The ex-date cannot be in the future.";
      const m = mult.trim();
      if (!isPlainDecimal(m, 8)) next["mult"] = "Enter a number with up to 8 decimals, e.g. 5.";
      else if (!(toDec(m)?.gt(0) ?? false) || (toDec(m)?.gt(1_000_000) ?? false)) {
        next["mult"] = "The multiplier must be above 0 and at most 1,000,000.";
      }
      setErrs(next);
      setServerErr(null);
      if (Object.keys(next).length > 0) return;
      try {
        await create.mutateAsync({
          symbol: sym,
          effective_date: date,
          qty_multiplier: m,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        toast(`Override saved for ${sym} on ${formatDate(date).text}.`);
        setSymbol("");
        setDate("");
        setMult("");
        setNote("");
      } catch (err) {
        const v = describeTxnError(err);
        setServerErr(v.message);
        const f: Record<string, string> = {};
        if (v.fields.symbol) f["symbol"] = v.fields.symbol;
        setErrs(f);
      }
    });
  };

  let list;
  if (q.isPending) list = <p className="text-body-sm text-text-2">Loading adjustments...</p>;
  else if (q.isError) {
    const u = describeError(q.error, "Adjustments");
    list = <Banner tone={u.state === "error" ? "error" : "info"}>{u.message}</Banner>;
  } else if (q.data.data.items.length === 0) {
    list = (
      <p className="text-body-sm text-text-2" data-testid="adj-empty">
        No corporate-action adjustments apply to your holdings.
      </p>
    );
  } else {
    list = (
      <ul data-testid="adj-list" aria-label="Adjustments">
        {q.data.data.items.map((a) => (
          <AdjRow key={`${a.symbol}-${a.date}-${a.source}-${a.id ?? "x"}`} a={a} />
        ))}
      </ul>
    );
  }

  const pending = (q.data?.data.items ?? []).filter(
    (a) => a.source === "review_needed" || a.source === "detected_unconfirmed",
  );

  return (
    <Card title="Adjustments" source={PORTFOLIO_SOURCE} asOf={null} testId="pf-adjustments">
      <div className="flex flex-col gap-3">
        <p className="text-caption text-text-2">
          Confirmed splits and bonuses with a ratio are applied to quantities automatically.
          Everything else is never applied on its own: it is listed as review needed until you enter
          an override. An override replaces every action on that ex-date.
        </p>
        {pending.length > 0 ? (
          <Banner tone="warn" testId="adj-review-banner">
            <strong>Review needed:</strong>{" "}
            {pending
              .map((p) => `${p.symbol} ${typeLabel(p.type)} ${formatDate(p.date).text}`)
              .join("; ")}
            . These are not applied to your quantities until you enter an override.
          </Banner>
        ) : null}
        {list}
        <form
          onSubmit={onSubmit}
          noValidate
          data-testid="adj-form"
          aria-label="Override a quantity multiplier"
          className="flex flex-col gap-3 border-t border-border pt-3"
        >
          <h3 className="text-body font-semibold">Override a quantity multiplier</h3>
          {serverErr ? (
            <Banner tone="error" testId="adj-error">
              {serverErr}
            </Banner>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label="Symbol" required error={errs["symbol"] ?? null}>
              {(p) => (
                <input
                  {...p}
                  data-testid="adj-symbol"
                  className={inputClass}
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                />
              )}
            </FormField>
            <FormField label="Ex-date" required error={errs["date"] ?? null}>
              {(p) => (
                <input
                  {...p}
                  type="date"
                  data-testid="adj-date"
                  className={inputClass}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label="Quantity multiplier"
              required
              error={errs["mult"] ?? null}
              hint="A 10 to 2 split is 5; a 1:1 bonus is 2"
            >
              {(p) => (
                <input
                  {...p}
                  inputMode="decimal"
                  data-testid="adj-mult"
                  className={inputClass}
                  value={mult}
                  onChange={(e) => setMult(e.target.value)}
                />
              )}
            </FormField>
          </div>
          <FormField label="Note">
            {(p) => (
              <input
                {...p}
                data-testid="adj-note"
                className={inputClass}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </FormField>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              data-testid="adj-save"
              disabled={create.isPending}
              className="h-9 touch-target rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
            >
              Save override
            </button>
            <button
              type="button"
              data-testid="adj-remove"
              disabled
              aria-describedby="adj-remove-why"
              className="h-9 touch-target rounded-control border border-border px-3 text-body-sm opacity-60"
            >
              Remove an override
            </button>
            <span id="adj-remove-why" className="text-caption text-text-2">
              Removing an override is not available yet; it will be added later. A wrong override
              can be replaced only after that.
            </span>
          </div>
        </form>
      </div>
    </Card>
  );
}

/** Estimated dividends from owner-entered dividend actions; excluded from XIRR. */
export function DividendsCard({ s, asOf }: { s: PortfolioSummary; asOf: string | null }) {
  const d = s.estimated_dividends;
  const items = d.items ?? [];
  return (
    <Card
      title="Estimated dividends"
      state={d.amount === null || d.amount === undefined ? "empty" : "ready"}
      message="No dividend actions entered for your holdings, so no estimate is shown."
      source="Dividend actions you entered, times quantity held"
      asOf={asOf}
      testId="pf-dividends"
    >
      <p className="num text-section font-semibold" data-testid="pf-dividends-amount">
        {inr(d.amount).text} <span className="text-body-sm font-normal text-text-2">estimated</span>
      </p>
      <p className="text-caption text-text-2">
        {d.label ?? "Estimate"}. Dividends are not included in XIRR or in P&amp;L.
      </p>
      {items.length > 0 ? (
        <ul className="mt-2 text-body-sm" aria-label="Dividend items">
          {items.map((i) => (
            <li key={`${i.symbol}-${i.ex_date}`}>
              {i.symbol}, ex-date {formatDate(i.ex_date).text}: {inr(i.amount_per_share).text} per
              share x {i.qty} shares = {inr(i.amount).text}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
