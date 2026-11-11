"use client";

import { useQuery } from "@tanstack/react-query";
import { FormField, inputClass } from "@/components/ui/FormField";
import { useState } from "react";
import { searchSchemes } from "@/lib/mf/api";
import { isGroup, type SchemeItem } from "@/lib/mf/schemas";
import { useDebouncedValue } from "@/lib/portfolio/debounce";
import { optionLabel, planLabel } from "./text";

const MIN_CHARS = 3;

/**
 * Scheme search for the MF forms. It reuses the fund search (`GET /mf/schemes`) and shows plan
 * (Direct or Regular) and option (Growth or IDCW) on every result, so a look-alike scheme is never
 * picked by accident (MFH-23). Nothing is picked automatically.
 */
export function SchemePicker({
  label = "Scheme",
  error,
  onPick,
  testPrefix = "pf-mf-scheme",
}: {
  label?: string;
  error?: string | null;
  onPick: (s: SchemeItem) => void;
  testPrefix?: string;
}) {
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim(), 300);
  const enabled = q.length >= MIN_CHARS;
  const res = useQuery({
    queryKey: ["portfolio", "mf-scheme-search", q],
    enabled,
    queryFn: ({ signal }) =>
      searchSchemes(
        {
          q,
          category: "",
          fundHouse: "",
          plan: "any",
          option: "any",
          includeAll: true,
          group: false,
        },
        undefined,
        signal,
      ),
    staleTime: 60_000,
  });
  const items: SchemeItem[] = (res.data?.data.items ?? []).flatMap((i) =>
    isGroup(i) ? i.variants : [i],
  );
  return (
    <div className="flex flex-col gap-2">
      <FormField
        label={label}
        required
        error={error ?? null}
        hint={`Type at least ${MIN_CHARS} letters of the fund name. Check Direct or Regular and Growth or IDCW before you pick.`}
      >
        {(p) => (
          <input
            {...p}
            data-testid={`${testPrefix}-search`}
            className={inputClass}
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </FormField>
      {enabled && res.isPending ? (
        <p className="text-caption text-text-2" data-testid={`${testPrefix}-loading`}>
          Searching...
        </p>
      ) : null}
      {enabled && res.isError ? (
        <p className="text-caption text-text-2" data-testid={`${testPrefix}-error`}>
          The fund search failed. Try again in a moment.
        </p>
      ) : null}
      {enabled && res.isSuccess && items.length === 0 ? (
        <p className="text-caption text-text-2" data-testid={`${testPrefix}-none`}>
          No scheme matches. Check the spelling.
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul
          className="flex max-h-56 flex-col overflow-y-auto rounded-control border border-border"
          aria-label="Scheme search results"
          data-testid={`${testPrefix}-results`}
        >
          {items.slice(0, 20).map((s) => (
            <li key={s.code} className="border-b border-border last:border-b-0">
              <button
                type="button"
                data-testid={`${testPrefix}-pick-${s.code}`}
                onClick={() => onPick(s)}
                className="touch-target flex w-full flex-col items-start px-2 py-1 text-left text-body-sm hover:bg-surface-3"
              >
                <span>{s.name}</span>
                <span className="text-micro text-text-2">
                  {planLabel(s.plan)} plan, {optionLabel(s.option)} option
                  {s.fund_house ? `, ${s.fund_house}` : ""}, code {s.code}
                  {s.status !== "active" ? `, ${s.status}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
