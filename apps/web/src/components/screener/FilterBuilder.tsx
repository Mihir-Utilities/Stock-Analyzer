"use client";

import { inputClass } from "@/components/ui/FormField";
import {
  METRICS,
  NUMERIC_METRICS,
  SCREENER_LIMITS,
  metricDef,
  unitWords,
} from "@/lib/screener/metrics";
import {
  OP_LABELS,
  UNIVERSE_KINDS,
  newFilter,
  opsFor,
  type Draft,
  type DraftError,
  type FilterDraft,
} from "@/lib/screener/spec";
import { BTN, SELECT } from "./parts";

function MetricOptions({ numericOnly = false }: { numericOnly?: boolean }) {
  const list = numericOnly ? NUMERIC_METRICS : METRICS;
  return (
    <>
      {list.map((m) => (
        <option key={m.key} value={m.key}>
          {m.label}
          {m.kind === "numeric" ? ` (${unitWords(m.unit)})` : " (text)"}
        </option>
      ))}
    </>
  );
}

function FilterRow({
  f,
  n,
  errors,
  onChange,
  onRemove,
}: {
  f: FilterDraft;
  n: number;
  errors: DraftError[];
  onChange: (patch: Partial<FilterDraft>) => void;
  onRemove: () => void;
}) {
  const def = metricDef(f.metric);
  const isText = def?.kind === "text";
  const errId = `screener-f${f.id}-err`;
  const mine = errors.filter((e) => e.id === f.id);
  const valueInvalid = mine.some((e) => e.field === "value");
  const describedBy = mine.length > 0 ? errId : undefined;
  const unit = def && !isText ? unitWords(def.unit) : "";
  return (
    <li>
      <fieldset
        data-testid={`screener-filter-${f.id}`}
        className="flex flex-col gap-2 rounded-control border border-border p-3"
      >
        <legend className="px-1 text-caption font-medium text-text-1">Filter {n}</legend>
        <div className="grid grid-cols-1 gap-2 tablet:grid-cols-[2fr_1fr_2fr_auto]">
          <select
            aria-label={`Filter ${n} metric`}
            data-testid={`screener-metric-${f.id}`}
            value={f.metric}
            aria-describedby={describedBy}
            onChange={(e) => {
              const ops = opsFor(e.target.value);
              onChange({
                metric: e.target.value,
                op: ops.includes(f.op) ? f.op : (ops[0] ?? ">"),
                a: "",
                b: "",
                list: "",
              });
            }}
            className={SELECT}
          >
            <MetricOptions />
          </select>
          <select
            aria-label={`Filter ${n} operator`}
            data-testid={`screener-op-${f.id}`}
            value={f.op}
            onChange={(e) => onChange({ op: e.target.value })}
            className={SELECT}
          >
            {opsFor(f.metric).map((op) => (
              <option key={op} value={op}>
                {OP_LABELS[op] ?? op}
              </option>
            ))}
          </select>
          {isText ? (
            <input
              type="text"
              aria-label={`Filter ${n} ${f.op === "in" ? "names, comma separated" : "name"}`}
              data-testid={`screener-value-${f.id}`}
              value={f.list}
              maxLength={f.op === "in" ? 5200 : SCREENER_LIMITS.textLen}
              aria-invalid={valueInvalid}
              aria-describedby={describedBy}
              onChange={(e) => onChange({ list: e.target.value })}
              className={inputClass}
            />
          ) : f.op === "between" ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Filter ${n} lower bound${unit ? ` (${unit})` : ""}`}
                data-testid={`screener-value-${f.id}`}
                value={f.a}
                aria-invalid={valueInvalid}
                aria-describedby={describedBy}
                onChange={(e) => onChange({ a: e.target.value })}
                className={inputClass}
              />
              <span className="text-body-sm text-text-2">and</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Filter ${n} upper bound${unit ? ` (${unit})` : ""}`}
                data-testid={`screener-value2-${f.id}`}
                value={f.b}
                aria-invalid={valueInvalid}
                aria-describedby={describedBy}
                onChange={(e) => onChange({ b: e.target.value })}
                className={inputClass}
              />
            </div>
          ) : (
            <input
              type="text"
              inputMode="decimal"
              aria-label={`Filter ${n} value${unit ? ` (${unit})` : ""}`}
              data-testid={`screener-value-${f.id}`}
              value={f.a}
              aria-invalid={valueInvalid}
              aria-describedby={describedBy}
              onChange={(e) => onChange({ a: e.target.value })}
              className={inputClass}
            />
          )}
          <button
            type="button"
            data-testid={`screener-remove-${f.id}`}
            aria-label={`Remove filter ${n}`}
            onClick={onRemove}
            className={BTN}
          >
            Remove
          </button>
        </div>
        {unit ? <p className="text-caption text-text-2">Unit: {unit}</p> : null}
        {mine.length > 0 ? (
          <p
            id={errId}
            role="alert"
            data-testid={`screener-filter-error-${f.id}`}
            className="text-caption text-text-1"
          >
            <span className="font-medium text-down">Error: </span>
            {mine.map((e) => e.message).join(" ")}
          </p>
        ) : null}
      </fieldset>
    </li>
  );
}

export function FilterBuilder({
  draft,
  setDraft,
  errors,
  nextId,
}: {
  draft: Draft;
  setDraft: (fn: (d: Draft) => Draft) => void;
  errors: DraftError[];
  nextId: () => number;
}) {
  const atMax = draft.filters.length >= SCREENER_LIMITS.filters;
  const patch = (id: number, p: Partial<FilterDraft>) =>
    setDraft((d) => ({ ...d, filters: d.filters.map((f) => (f.id === id ? { ...f, ...p } : f)) }));
  const formErrors = errors.filter((e) => e.id === null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-lead font-semibold text-text-1">Filters</h3>
        {draft.filters.length === 0 ? (
          <p className="text-body-sm text-text-2" data-testid="screener-no-filters">
            No filters yet: the screen lists every stock in the universe. Add a filter or pick a
            preset.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Filters">
            {draft.filters.map((f, i) => (
              <FilterRow
                key={f.id}
                f={f}
                n={i + 1}
                errors={errors}
                onChange={(p) => patch(f.id, p)}
                onRemove={() =>
                  setDraft((d) => ({ ...d, filters: d.filters.filter((x) => x.id !== f.id) }))
                }
              />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="screener-add-filter"
            disabled={atMax}
            aria-describedby={atMax ? "screener-add-disabled" : undefined}
            onClick={() =>
              setDraft((d) => ({ ...d, filters: [...d.filters, newFilter(nextId())] }))
            }
            className={BTN}
          >
            Add filter
          </button>
          <span className="text-caption text-text-2" data-testid="screener-filter-count">
            {draft.filters.length} of {SCREENER_LIMITS.filters} filters
          </span>
        </div>
        {atMax ? (
          <p id="screener-add-disabled" className="text-caption text-text-2">
            Add filter is off: a screen has at most {SCREENER_LIMITS.filters} filters.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 tablet:grid-cols-4">
        <label className="flex flex-col gap-1 text-caption font-medium text-text-1">
          Sort by
          <select
            data-testid="screener-sort-metric"
            value={draft.sortMetric}
            onChange={(e) => setDraft((d) => ({ ...d, sortMetric: e.target.value }))}
            className={SELECT}
          >
            <option value="">Default order</option>
            <MetricOptions />
          </select>
        </label>
        <label className="flex flex-col gap-1 text-caption font-medium text-text-1">
          Sort direction
          <select
            data-testid="screener-sort-dir"
            value={draft.sortDir}
            disabled={draft.sortMetric === ""}
            aria-describedby={draft.sortMetric === "" ? "screener-dir-disabled" : undefined}
            onChange={(e) =>
              setDraft((d) => ({ ...d, sortDir: e.target.value === "asc" ? "asc" : "desc" }))
            }
            className={SELECT}
          >
            <option value="desc">Highest first</option>
            <option value="asc">Lowest first</option>
          </select>
          {draft.sortMetric === "" ? (
            <span id="screener-dir-disabled" className="text-caption font-normal text-text-2">
              Choose a sort metric first.
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1 text-caption font-medium text-text-1">
          Kind
          <select
            data-testid="screener-kind"
            value={draft.kind}
            onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
            className={SELECT}
          >
            {UNIVERSE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-caption font-medium text-text-1">
          Company type
          <select
            data-testid="screener-company-type"
            value={draft.companyType}
            onChange={(e) => setDraft((d) => ({ ...d, companyType: e.target.value }))}
            className={SELECT}
          >
            <option value="">Any</option>
            <option value="general">General</option>
            <option value="financial">Financial</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-caption font-medium text-text-1 tablet:col-span-2">
          Index tag (optional)
          <input
            type="text"
            data-testid="screener-index"
            value={draft.index}
            maxLength={SCREENER_LIMITS.textLen}
            placeholder="For example NIFTY 500"
            onChange={(e) => setDraft((d) => ({ ...d, index: e.target.value }))}
            className={inputClass}
          />
        </label>
      </div>

      <fieldset className="rounded-control border border-border p-3" data-testid="screener-columns">
        <legend className="px-1 text-caption font-medium text-text-1">
          Columns (filter and sort metrics are always shown)
        </legend>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 tablet:grid-cols-3">
          {METRICS.map((m) => (
            <label
              key={m.key}
              className="touch-target flex items-center gap-2 text-body-sm text-text-1"
            >
              <input
                type="checkbox"
                data-testid={`screener-col-${m.key}`}
                checked={draft.columns.includes(m.key)}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    columns: e.target.checked
                      ? [...d.columns, m.key]
                      : d.columns.filter((c) => c !== m.key),
                  }))
                }
              />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>

      {formErrors.length > 0 ? (
        <p role="alert" data-testid="screener-form-error" className="text-body-sm text-text-1">
          <span className="font-medium text-down">Error: </span>
          {formErrors.map((e) => e.message).join(" ")}
        </p>
      ) : null}
    </div>
  );
}
