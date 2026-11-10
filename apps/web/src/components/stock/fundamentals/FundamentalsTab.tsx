"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ResultsForm } from "@/components/imports/ResultsForm";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { DepthChip } from "@/components/ui/chips";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import { formatCount, formatDate } from "@/lib/format";
import {
  asOfText,
  fundamentalsFullKey,
  getFundamentalsFull,
  GROUPS,
  hasAnyValue,
  formatDerivedAsOf,
  scalarRows,
  seriesRows,
  sourceText,
  warningText,
  type BasisChoice,
  type GroupId,
  type PeriodChoice,
} from "@/lib/stock/fundamentals";
import { humanReason } from "@/lib/stock/derive";
import {
  BalanceChart,
  CashflowChart,
  PeStrip,
  RoeDecomposition,
  RowChart,
  WaterfallChart,
} from "./GroupCharts";
import { PeriodsTable, ScalarTable } from "./PeriodsTable";

export const FILING_FOOTNOTE = "Figures are entered by you; verify against company filings.";

const pill =
  "touch-target inline-flex h-9 items-center rounded-control border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50";
const pillOn = "border-accent font-medium text-text-1";
const pillOff = "border-border text-text-2";

function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
  testPrefix,
  describedBy,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string; disabled?: boolean }>;
  onChange: (v: T) => void;
  testPrefix: string;
  /** Id of visible text that explains why an option is disabled. */
  describedBy?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className="flex flex-wrap items-center gap-1"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          data-testid={`${testPrefix}-${o.id}`}
          aria-pressed={value === o.id}
          disabled={o.disabled === true}
          onClick={() => onChange(o.id)}
          className={cx(pill, value === o.id ? pillOn : pillOff)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Fundamentals tab (docs/06 section 6.4, F07): owner-entered results with the API's one-basis
 * answer, per-metric source, derived/ratio/valuation blocks with their honest reasons, charts per
 * group and the F13b manual results form (symbol fixed) for adding or restating a period.
 */
export function FundamentalsTab({ symbol }: { symbol: string }) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState<PeriodChoice>("Q");
  const [basis, setBasis] = useState<BasisChoice>("auto");
  const [group, setGroup] = useState<GroupId>("pnl");
  const [picked, setPicked] = useState<Partial<Record<GroupId, string>>>({});
  const [form, setForm] = useState<{ n: number; periodEnd: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const q = useQuery({
    queryKey: fundamentalsFullKey(symbol, basis, period),
    queryFn: () => getFundamentalsFull(symbol, basis, period),
    staleTime: STALE_TIME.fundamentals,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (form) panelRef.current?.focus();
  }, [form]);

  const openForm = (periodEnd: string) => setForm((f) => ({ n: (f?.n ?? 0) + 1, periodEnd }));
  const closeForm = () => {
    setForm(null);
    addRef.current?.focus();
  };

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-3" data-testid="fnd-loading" aria-busy="true">
        <Skeleton className="h-9 w-2/3" label="Loading fundamentals" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (q.isError) {
    const e = q.error;
    return (
      <Card
        title="Fundamentals"
        testId="fnd-error"
        state="error"
        message={`${e instanceof ApiError ? e.message : "Fundamentals could not be loaded."}${e instanceof ApiError && e.requestId ? ` (request ${e.requestId})` : ""}`}
        onRetry={() => void q.refetch()}
      />
    );
  }
  const d = q.data.data;
  if ("redirect_symbol" in d) {
    return <Skeleton className="h-48 w-full" label="Opening the current symbol" />;
  }

  const periods = d.periods ?? [];
  const labels = d.labels ?? periods;
  // With keepPreviousData the answer on screen can still be the previous toggle's; every label,
  // the form prefill and the edit buttons follow the data shown, not the toggle just pressed.
  const shownPeriod: PeriodChoice =
    d.period_type === "A" ? "A" : d.period_type === "Q" ? "Q" : period;
  const updating = q.isPlaceholderData;
  const unitNoun = shownPeriod === "Q" ? "quarters" : "annual periods";
  const available = d.basis_available ?? [];
  const entered = d.periods_available ?? periods.length;
  const stale = q.data.meta?.stale === true;
  const stamp = formatDate(d.last_updated ?? null);
  const empty = periods.length === 0;
  const partial = !empty && (d.status === "partial" || d.status === "parse_error");

  const fixed = {
    symbol,
    basis: d.basis_used === "standalone" ? "standalone" : "consolidated",
    periodType: shownPeriod,
    ...(form && form.periodEnd ? { periodEnd: form.periodEnd } : {}),
  };
  const onChanged = () => void qc.invalidateQueries({ queryKey: ["stocks", symbol] });

  const rows = group === "ratios" || group === "valuation" ? [] : seriesRows(d, group);
  const shown = rows.filter((r) => hasAnyValue(r) || !r.key.includes("."));
  const selectedKey =
    picked[group] && shown.some((r) => r.key === picked[group])
      ? (picked[group] as string)
      : (shown[0]?.key ?? null);
  const selectedRow = shown.find((r) => r.key === selectedKey) ?? null;
  const derivedNote = d.derived_reason ? humanReason(d.derived_reason) : null;

  const formPanel = form ? (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="fnd-form-panel"
      aria-label="Add or edit results"
      className="flex flex-col gap-2 rounded-card border border-border bg-surface-1 p-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lead font-semibold">Add or edit results</h3>
        <button
          type="button"
          data-testid="fnd-form-close"
          onClick={closeForm}
          className={cx(pill, pillOff)}
        >
          Close form
        </button>
      </div>
      <p className="text-caption text-text-2">
        Saved values appear here after the refresh. Balance sheet and cash flow figures come from
        the balance_cashflow_annual.csv import.
      </p>
      <ResultsForm key={`${symbol}:${form.n}`} fixed={fixed} onChanged={onChanged} />
    </div>
  ) : null;

  const addButton = (
    <button
      ref={addRef}
      type="button"
      data-testid="fnd-add-results"
      onClick={() => openForm("")}
      className={cx(pill, pillOn)}
    >
      Add results
    </button>
  );
  const disabledBases = (["consolidated", "standalone"] as const).filter(
    (b) => !available.includes(b),
  );
  const toggles = (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Toggle
          label="Period"
          value={period}
          onChange={setPeriod}
          testPrefix="fnd-period"
          options={[
            { id: "Q", label: "Quarterly" },
            { id: "A", label: "Annual" },
          ]}
        />
        <Toggle
          label="Basis"
          value={basis}
          onChange={setBasis}
          testPrefix="fnd-basis"
          describedBy={disabledBases.length > 0 ? "fnd-basis-disabled" : undefined}
          options={[
            { id: "auto", label: "Auto" },
            {
              id: "consolidated",
              label: "Consolidated",
              disabled: !available.includes("consolidated"),
            },
            {
              id: "standalone",
              label: "Standalone",
              disabled: !available.includes("standalone"),
            },
          ]}
        />
      </div>
      {disabledBases.length > 0 ? (
        <p
          id="fnd-basis-disabled"
          data-testid="fnd-basis-disabled"
          className="text-caption text-text-2"
        >
          {disabledBases.join(" and ")} unavailable: no{" "}
          {shownPeriod === "Q" ? "quarterly" : "annual"} periods are entered on that basis.
        </p>
      ) : null}
    </>
  );
  const importLink = (
    <Link
      href="/imports"
      data-testid="fnd-import-csv"
      className="touch-target inline-flex items-center text-body-sm text-accent underline"
    >
      Import CSV
    </Link>
  );

  if (empty) {
    return (
      <div className="flex flex-col gap-3" data-testid="fnd-empty">
        {period !== "Q" || basis !== "auto" ? (
          // A non-default choice with no rows must stay reversible (the toggles live nowhere else).
          <div className="flex flex-col gap-2" data-testid="fnd-empty-toggles">
            {toggles}
          </div>
        ) : null}
        <EmptyState
          message={`${d.entry_hint ?? "Add results via Import or the manual form."} Reason: ${humanReason(d.metrics_reason, "no data entered")}.`}
          action={
            <div className="flex flex-wrap items-center gap-3">
              {addButton}
              {importLink}
            </div>
          }
        />
        {formPanel}
        <p className="text-caption text-text-2" data-testid="fnd-footnote">
          {FILING_FOOTNOTE}
        </p>
      </div>
    );
  }

  const asOf = asOfText(d);
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="fundamentals-tab"
      aria-busy={updating}
      data-updating={updating}
    >
      <Card
        title="Fundamentals"
        testId="fnd-card"
        state={partial ? "partial" : "ready"}
        message={`Partial history: ${formatCount(entered).text} ${unitNoun} entered. Growth and trends need more periods; an unknown value shows a dash with its reason.`}
        source={sourceText(d)}
        asOf={asOf}
        stale={stale}
        actions={
          <>
            {addButton}
            {importLink}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {toggles}
          <div className="flex flex-wrap items-center gap-3">
            <DepthChip
              text={`${formatCount(periods.length).text} of ${formatCount(entered).text} ${unitNoun} shown`}
            />
          </div>
          {updating ? (
            <p role="status" data-testid="fnd-updating" className="text-caption text-text-2">
              Loading the {period === "Q" ? "quarterly" : "annual"} view; the figures below are
              still the previous view.
            </p>
          ) : null}
          <p role="status" data-testid="fnd-summary" className="text-body-sm text-text-1">
            Showing {shownPeriod === "Q" ? "quarterly" : "annual"} {d.basis_used ?? "consolidated"}{" "}
            figures, {formatCount(periods.length).text} periods, INR crore unless a row says
            otherwise.
          </p>
          <p className="text-caption text-text-2" data-testid="fnd-last-updated" data-stale={stale}>
            Last updated {stamp.reason === null ? stamp.text : "unknown"}
            {d.last_updated_source ? ` (${d.last_updated_source})` : ""}
            {stale ? ", stale: no recent update" : ""}.
          </p>
          {d.basis_note ? (
            <Banner tone="info" testId="fnd-basis-note">
              {d.basis_note}
            </Banner>
          ) : null}
          {q.data.warnings.map((w) => (
            <Banner key={w.code} tone="warn" testId={`fnd-warning-${w.code}`}>
              {warningText(w, d.derived_as_of)}
            </Banner>
          ))}
          {derivedNote ? (
            <Banner tone="info" testId="fnd-derived-note">
              Growth, margins, ratios and valuation: {derivedNote}.
            </Banner>
          ) : null}
        </div>
      </Card>
      {formPanel}
      <Card title="Figures" testId="fnd-figures">
        <div className="flex flex-col gap-3">
          <Toggle
            label="Group"
            value={group}
            onChange={setGroup}
            testPrefix="fnd-group"
            options={GROUPS.map((g) => ({ id: g.id, label: g.label }))}
          />
          {group === "ratios" || group === "valuation" ? (
            <ScalarTable
              rows={scalarRows(d, group)}
              asOfText={`Analytics snapshot, as of ${formatDerivedAsOf(d.derived_as_of).reason === null ? formatDerivedAsOf(d.derived_as_of).text : "unknown"}`}
              caption={group === "ratios" ? "Ratios, latest" : "Valuation, latest"}
            />
          ) : shown.length === 0 ? (
            <p className="text-body-sm text-text-2" data-testid="fnd-group-empty">
              No {GROUPS.find((g) => g.id === group)?.label ?? ""} figures entered for this view.
              {group === "pnl" ? "" : " Import balance_cashflow_annual.csv to add them."}
            </p>
          ) : (
            <PeriodsTable
              rows={shown}
              periods={periods}
              labels={labels}
              selectedKey={selectedKey}
              onSelect={(k) => setPicked((p) => ({ ...p, [group]: k }))}
              onEdit={openForm}
              caption={`${GROUPS.find((g) => g.id === group)?.label ?? ""}, ${shownPeriod === "Q" ? "quarterly" : "annual"}, ${d.basis_used ?? ""}`}
            />
          )}
        </div>
      </Card>
      {group === "pnl" || group === "bs" || group === "cf" ? (
        <RowChart data={d} row={selectedRow} />
      ) : null}
      {group === "pnl" ? <WaterfallChart data={d} /> : null}
      {group === "bs" ? <BalanceChart data={d} /> : null}
      {group === "cf" ? <CashflowChart data={d} /> : null}
      {group === "ratios" ? <RoeDecomposition data={d} /> : null}
      {group === "valuation" ? <PeStrip data={d} /> : null}
      <p className="text-caption text-text-2" data-testid="fnd-footnote">
        {FILING_FOOTNOTE}
      </p>
    </div>
  );
}
