"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { AsOfChip, SourceChip } from "@/components/ui/chips";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField, inputClass } from "@/components/ui/FormField";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import { formatDate, formatInr, formatPercent } from "@/lib/format";
import { getCategories, mfKeys, searchSchemes, type SearchParams } from "@/lib/mf/api";
import { MF_SOURCE, MF_UNIT, planOptionLabels } from "@/lib/mf/derive";
import { isGroup, type FundGroup, type SchemeItem } from "@/lib/mf/schemas";
import { STALE_TIME } from "@/components/shell/Providers";
import { btn, linkBtn, MfChip, MfNotice } from "./parts";

export const SEARCH_DEBOUNCE_MS = 250;
export const MAX_COMPARE = 5;

const DEFAULTS: SearchParams = {
  q: "",
  category: "",
  fundHouse: "",
  plan: "direct",
  option: "growth",
  includeAll: false,
  group: false,
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function VariantChips({ item }: { item: SchemeItem }) {
  const [plan, option] = planOptionLabels(item);
  return (
    <span className="flex flex-wrap gap-1">
      <MfChip testId="mf-plan-chip">{plan}</MfChip>
      <MfChip testId="mf-option-chip" tone={item.option === "idcw" ? "warn" : "neutral"}>
        {option}
      </MfChip>
      {item.status === "inactive" ? (
        <MfChip testId="mf-inactive-chip" tone="warn">
          Inactive
        </MfChip>
      ) : null}
    </span>
  );
}

function NavCell({ item }: { item: SchemeItem }) {
  const nav = formatInr(item.latest_nav, { reason: "no NAV stored yet" });
  const date = formatDate(item.last_nav_date, { reason: "no NAV date" });
  return (
    <div className="num">
      <span title={nav.reason ?? undefined}>{nav.text}</span>
      <span className="block text-micro text-text-2">
        {item.latest_nav === null ? nav.reason : `${MF_UNIT}, ${date.text}`}
      </span>
    </div>
  );
}

function OneYearCell({ item }: { item: SchemeItem }) {
  const r = formatPercent(item.return_1y_pct, {
    reason: "not computed yet or history shorter than 1 year",
  });
  const asOf = formatDate(item.returns_as_of, { reason: "no date" });
  return (
    <div className="num">
      <span title={r.reason ?? undefined}>{r.text}</span>
      <span className="block text-micro text-text-2">
        {item.return_1y_pct === null ? r.reason : `CAGR, as of ${asOf.text}`}
      </span>
    </div>
  );
}

function SchemeRow({
  item,
  selected,
  full,
  onToggle,
  showName,
}: {
  item: SchemeItem;
  selected: boolean;
  full: boolean;
  onToggle: (code: number) => void;
  showName: boolean;
}) {
  return (
    <tr data-testid={`mf-row-${item.code}`} className="border-t border-border align-top">
      <td className="px-2 py-2">
        {showName ? (
          <>
            <Link
              href={`/mf/${item.code}`}
              data-testid={`mf-link-${item.code}`}
              className="touch-target inline-flex items-center text-body-sm text-accent underline"
            >
              {item.name}
            </Link>
            <span className="block text-micro text-text-2">
              {[item.fund_house, item.category].filter(Boolean).join(" | ") ||
                "fund house and category not known"}
            </span>
          </>
        ) : (
          <Link
            href={`/mf/${item.code}`}
            data-testid={`mf-link-${item.code}`}
            className="touch-target inline-flex items-center text-body-sm text-accent underline"
          >
            Scheme {item.code}
          </Link>
        )}
      </td>
      <td className="px-2 py-2">
        <VariantChips item={item} />
      </td>
      <td className="px-2 py-2 text-right">
        <NavCell item={item} />
      </td>
      <td className="px-2 py-2 text-right">
        <OneYearCell item={item} />
      </td>
      <td className="px-2 py-2">
        <label className="touch-target inline-flex items-center gap-2 text-caption text-text-1">
          <input
            type="checkbox"
            data-testid={`mf-compare-${item.code}`}
            checked={selected}
            disabled={full && !selected}
            onChange={() => onToggle(item.code)}
            className="size-4"
          />
          <span>Compare</span>
          <span className="sr-only"> {item.name}</span>
        </label>
      </td>
    </tr>
  );
}

function GroupRows({
  group,
  selected,
  onToggle,
}: {
  group: FundGroup;
  selected: ReadonlySet<number>;
  onToggle: (code: number) => void;
}) {
  return (
    <tbody data-testid="mf-group-rows" className="border-t-2 border-border">
      <tr>
        <th scope="colgroup" colSpan={5} className="px-2 py-2 text-left text-body-sm font-semibold">
          {group.name}
          <span className="block text-micro font-normal text-text-2">
            {[group.fund_house, group.category].filter(Boolean).join(" | ") ||
              "fund house and category not known"}
          </span>
        </th>
      </tr>
      {group.variants.map((v) => (
        <SchemeRow
          key={v.code}
          item={v}
          selected={selected.has(v.code)}
          full={selected.size >= MAX_COMPARE}
          onToggle={onToggle}
          showName={false}
        />
      ))}
    </tbody>
  );
}

export function MfBrowse() {
  const [form, setForm] = useState<SearchParams>(DEFAULTS);
  const debouncedQ = useDebounced(form.q, SEARCH_DEBOUNCE_MS);
  const debouncedHouse = useDebounced(form.fundHouse, SEARCH_DEBOUNCE_MS);
  const params = useMemo<SearchParams>(
    () => ({ ...form, q: debouncedQ, fundHouse: debouncedHouse }),
    [form, debouncedQ, debouncedHouse],
  );
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const categories = useQuery({
    queryKey: mfKeys.categories,
    queryFn: () => getCategories(),
    staleTime: STALE_TIME.mf,
  });
  const q = useInfiniteQuery({
    queryKey: mfKeys.search(params),
    queryFn: ({ pageParam, signal }) => searchSchemes(params, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.data.next_cursor ?? undefined,
    staleTime: STALE_TIME.mf,
  });

  const set = (patch: Partial<SearchParams>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (code: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code);
      else if (n.size < MAX_COMPARE) n.add(code);
      return n;
    });

  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((p) => p.data.items);
  const lastMeta = pages[pages.length - 1]?.meta;
  const compareHref = `/mf/compare?codes=${[...selected].join(",")}`;
  const typing = form.q !== debouncedQ || form.fundHouse !== debouncedHouse;

  return (
    <div className="flex flex-col gap-4" data-testid="mf-browse">
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold text-text-1">Mutual funds</h1>
        <p className="text-body-sm text-text-2">
          Search schemes by name. Defaults: Direct plan, Growth option, active schemes only.
        </p>
      </header>

      <form
        role="search"
        aria-label="Fund search"
        onSubmit={(e) => e.preventDefault()}
        className="grid grid-cols-1 gap-3 rounded-card border border-border bg-surface-1 p-4 tablet:grid-cols-2"
      >
        <FormField label="Search by name" hint="Words in any order, for example: parag flexi">
          {(p) => (
            <input
              {...p}
              type="search"
              data-testid="mf-q"
              value={form.q}
              maxLength={100}
              onChange={(e) => set({ q: e.target.value })}
              className={inputClass}
            />
          )}
        </FormField>
        <FormField label="Fund house" hint="Part of the name, for example: hdfc">
          {(p) => (
            <input
              {...p}
              type="search"
              data-testid="mf-house"
              value={form.fundHouse}
              maxLength={100}
              onChange={(e) => set({ fundHouse: e.target.value })}
              className={inputClass}
            />
          )}
        </FormField>
        <FormField label="Category">
          {(p) => (
            <select
              {...p}
              data-testid="mf-category"
              value={form.category}
              onChange={(e) => set({ category: e.target.value })}
              className={inputClass}
            >
              <option value="">All categories</option>
              {(categories.data?.data.items ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Plan">
            {(p) => (
              <select
                {...p}
                data-testid="mf-plan"
                value={form.plan}
                onChange={(e) => set({ plan: e.target.value as SearchParams["plan"] })}
                className={inputClass}
              >
                <option value="direct">Direct</option>
                <option value="regular">Regular</option>
                {form.includeAll ? <option value="any">Any</option> : null}
              </select>
            )}
          </FormField>
          <FormField label="Option">
            {(p) => (
              <select
                {...p}
                data-testid="mf-option"
                value={form.option}
                onChange={(e) => set({ option: e.target.value as SearchParams["option"] })}
                className={inputClass}
              >
                <option value="growth">Growth</option>
                <option value="idcw">IDCW</option>
                {form.includeAll ? <option value="any">Any</option> : null}
              </select>
            )}
          </FormField>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="touch-target inline-flex items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              data-testid="mf-show-all"
              checked={form.includeAll}
              onChange={(e) =>
                set(
                  e.target.checked
                    ? { includeAll: true, plan: "any", option: "any" }
                    : { includeAll: false, plan: "direct", option: "growth" },
                )
              }
              className="size-4"
            />
            Show all (inactive schemes, every plan and option)
          </label>
          <label className="touch-target inline-flex items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              data-testid="mf-group"
              checked={form.group}
              onChange={(e) => set({ group: e.target.checked })}
              className="size-4"
            />
            Group variants
          </label>
        </div>
      </form>

      <div aria-live="polite" className="flex flex-wrap items-center gap-2" data-testid="mf-status">
        {q.isPending || typing ? (
          <span className="text-caption text-text-2">Searching</span>
        ) : (
          <>
            <SourceChip source={MF_SOURCE} />
            <AsOfChip asOf={lastMeta?.as_of ?? null} stale={lastMeta?.stale === true} />
          </>
        )}
      </div>

      {q.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-10 w-full" label="Loading funds" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : q.isError && items.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <Banner tone="error" testId="mf-error">
            {q.error instanceof ApiError ? q.error.message : "Funds could not be loaded."}
          </Banner>
          <button
            type="button"
            data-testid="mf-retry"
            onClick={() => void q.refetch()}
            className={btn}
          >
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState message="No funds match these filters. Clear a filter or tick Show all." />
      ) : (
        <div
          className="relative overflow-x-auto rounded-card border border-border bg-surface-1"
          tabIndex={0}
          role="region"
          aria-label="Fund results, scrollable"
        >
          <table aria-label="Funds" data-testid="mf-results" className="w-full min-w-[34rem]">
            <thead>
              <tr className="text-left text-caption text-text-2">
                <th scope="col" className="px-2 py-2 font-medium">
                  Fund
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Plan and option
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Latest NAV
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  1Y return
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Compare
                </th>
              </tr>
            </thead>
            {items.every((i) => !isGroup(i)) ? (
              <tbody>
                {items.map((i) =>
                  isGroup(i) ? null : (
                    <SchemeRow
                      key={i.code}
                      item={i}
                      selected={selected.has(i.code)}
                      full={selected.size >= MAX_COMPARE}
                      onToggle={toggle}
                      showName
                    />
                  ),
                )}
              </tbody>
            ) : null}
            {items.map((i) =>
              isGroup(i) ? (
                <GroupRows
                  key={`${i.name}|${i.variants[0]?.code ?? ""}`}
                  group={i}
                  selected={selected}
                  onToggle={toggle}
                />
              ) : null,
            )}
          </table>
        </div>
      )}

      {q.isError && items.length > 0 ? (
        <Banner tone="error" testId="mf-more-error">
          {q.error instanceof ApiError ? q.error.message : "More funds could not be loaded."} The
          funds above are still shown; use Load more to try again.
        </Banner>
      ) : null}

      {q.hasNextPage ? (
        <button
          type="button"
          data-testid="mf-more"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
          className={btn}
        >
          {q.isFetchingNextPage ? "Loading" : "Load more"}
        </button>
      ) : null}

      <div className="flex flex-wrap items-center gap-3" data-testid="mf-compare-bar">
        <span
          aria-live="polite"
          className="text-body-sm text-text-2"
          data-testid="mf-compare-count"
        >
          {selected.size} of {MAX_COMPARE} selected for compare
        </span>
        {selected.size >= 2 ? (
          <Link href={compareHref} data-testid="mf-compare-go" className={linkBtn}>
            Compare funds
          </Link>
        ) : (
          <span className="text-caption text-text-2">Select at least 2 funds to compare.</span>
        )}
      </div>

      <MfNotice />
    </div>
  );
}
