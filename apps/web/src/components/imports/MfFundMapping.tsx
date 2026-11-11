"use client";

import { Banner } from "@/components/ui/banners";
import { formatCount } from "@/lib/format";
import type { UnmappedFund } from "@/lib/imports/mf";
import type { MfCandidate } from "@/lib/imports/schemas";
import { SchemePicker } from "@/components/portfolio/SchemePicker";
import { optionLabel, planLabel } from "@/components/portfolio/text";

export interface Choice {
  code: number;
  name: string;
  plan: string;
  option: string;
}

function Pill({
  children,
  testId,
  warn = false,
}: {
  children: string;
  testId?: string;
  warn?: boolean;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center rounded-chip border bg-surface-2 px-1.5 py-0.5 text-micro ${warn ? "border-warn text-text-1" : "border-border text-text-2"}`}
    >
      {children}
    </span>
  );
}

function Candidate({
  fundIndex,
  c,
  checked,
  onChoose,
}: {
  fundIndex: number;
  c: MfCandidate;
  checked: boolean;
  onChoose: (c: Choice) => void;
}) {
  return (
    <label className="touch-target flex cursor-pointer items-start gap-2 rounded-control border border-border p-2 text-body-sm hover:bg-surface-3">
      <input
        type="radio"
        name={`mf-fund-${fundIndex}`}
        data-testid={`mf-candidate-${fundIndex}-${c.scheme_code}`}
        checked={checked}
        onChange={() =>
          onChoose({ code: c.scheme_code, name: c.name, plan: c.plan, option: c.option })
        }
        className="mt-1"
      />
      <span className="flex flex-col gap-1">
        <span className="text-text-1">{c.name}</span>
        <span className="flex flex-wrap gap-1">
          <Pill testId="mf-candidate-plan">{`${planLabel(c.plan)} plan`}</Pill>
          <Pill testId="mf-candidate-option">{`${optionLabel(c.option)} option`}</Pill>
          {c.on_watchlist ? <Pill testId="mf-candidate-watchlist">On your watchlist</Pill> : null}
          <Pill testId="mf-candidate-nav" warn={!c.has_nav}>
            {c.has_nav ? "NAV data available" : "No NAV data yet"}
          </Pill>
        </span>
        <span className="text-micro text-text-2">
          {c.fund_house ? `${c.fund_house}; ` : ""}
          {c.isin ? `ISIN ${c.isin}; ` : ""}code {c.scheme_code}
        </span>
      </span>
    </label>
  );
}

/**
 * The fund-name mapping step (MFH-23). The owner picks the scheme for EVERY unmapped fund name:
 * nothing is pre-selected and nothing is chosen automatically, even with a single candidate.
 * Direct or Regular and Growth or IDCW are spelled out on each candidate, watchlist schemes first.
 */
export function MfFundMapping({
  funds,
  choices,
  onChoose,
  onSave,
  saving,
  error,
}: {
  funds: UnmappedFund[];
  choices: Record<string, Choice>;
  onChoose: (fundName: string, c: Choice) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}) {
  if (funds.length === 0) return null;
  const chosen = funds.filter((f) => choices[f.fund_name] !== undefined).length;
  return (
    <section
      aria-labelledby="mf-map-h"
      data-testid="mf-import-mapping"
      className="flex flex-col gap-3 rounded-card border border-border p-3"
    >
      <h3 id="mf-map-h" className="text-body font-semibold text-text-1">
        Choose the scheme for each fund name ({formatCount(funds.length).text} to do)
      </h3>
      <p className="text-body-sm text-text-2">
        Your statement has only a fund name. Pick the exact scheme for every name below, checking
        Direct or Regular and Growth or IDCW. Nothing is chosen for you. Rows of a name stay blocked
        until you pick its scheme, and your choice is remembered for later imports.
      </p>
      {error ? (
        <Banner tone="error" testId="mf-map-error">
          {error}
        </Banner>
      ) : null}
      {funds.map((f, i) => {
        const pick = choices[f.fund_name];
        return (
          <fieldset
            key={f.fund_name}
            data-testid={`mf-map-fund-${i}`}
            className="flex flex-col gap-2 rounded-control border border-border p-2"
          >
            <legend className="px-1 text-body-sm font-medium text-text-1">
              {f.fund_name} ({formatCount(f.rows).text} rows)
            </legend>
            {f.candidates.length === 0 ? (
              <p className="text-body-sm text-text-2" data-testid={`mf-map-none-${i}`}>
                No candidate scheme was found for this name. Search for the scheme below.
              </p>
            ) : (
              <div
                className="flex flex-col gap-2"
                role="radiogroup"
                aria-label={`Scheme for ${f.fund_name}`}
              >
                {f.candidates.map((c) => (
                  <Candidate
                    key={c.scheme_code}
                    fundIndex={i}
                    c={c}
                    checked={pick?.code === c.scheme_code}
                    onChoose={(x) => onChoose(f.fund_name, x)}
                  />
                ))}
              </div>
            )}
            <details>
              <summary className="touch-target cursor-pointer text-body-sm text-accent">
                Search for another scheme
              </summary>
              <SchemePicker
                label="Scheme"
                testPrefix={`mf-map-search-${i}`}
                onPick={(s) =>
                  onChoose(f.fund_name, {
                    code: s.code,
                    name: s.name,
                    plan: s.plan,
                    option: s.option,
                  })
                }
              />
            </details>
            {pick ? (
              <p className="text-body-sm text-text-1" data-testid={`mf-map-chosen-${i}`}>
                Chosen: {pick.name} ({planLabel(pick.plan)} plan, {optionLabel(pick.option)}{" "}
                option), code {pick.code}.
              </p>
            ) : (
              <p className="text-caption text-text-2">No scheme chosen yet.</p>
            )}
          </fieldset>
        );
      })}
      <div>
        <button
          type="button"
          data-testid="mf-map-save"
          disabled={chosen === 0 || saving}
          aria-busy={saving}
          onClick={onSave}
          className="touch-target h-9 rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
        >
          {saving
            ? "Saving"
            : `Save ${formatCount(chosen).text} of ${formatCount(funds.length).text} choices and re-check`}
        </button>
      </div>
    </section>
  );
}
