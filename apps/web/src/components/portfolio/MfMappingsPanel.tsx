"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import { formatDate, formatCount } from "@/lib/format";
import { invalidatePortfolio } from "@/lib/portfolio/api";
import { mfKeys, putMapping, useMfMappings } from "@/lib/portfolio/mf-api";
import { mfMappingSchema, readRows, type MfMapping } from "@/lib/portfolio/mf-schemas";
import { SchemePicker } from "./SchemePicker";
import { optionLabel, planLabel } from "./text";

const BUTTON =
  "h-9 touch-target rounded-control border border-border px-3 text-body-sm hover:bg-surface-3 disabled:opacity-50";

function RemapForm({
  mapping,
  onClose,
  onSaved,
}: {
  mapping: MfMapping;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const qc = useQueryClient();
  const [pick, setPick] = useState<{
    code: number;
    name: string;
    plan: string;
    option: string;
  } | null>(null);
  const [needsRemap, setNeedsRemap] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (remap: boolean) =>
      putMapping({ fund_name: mapping.fund_name, scheme_code: pick?.code ?? 0, remap }),
    onSuccess: (saved) => {
      // Say what changed (old -> new) in the panel and close this form.
      onSaved(`${mapping.fund_name}: ${mapping.scheme_name} -> ${saved.scheme_name}.`);
      void qc.invalidateQueries({ queryKey: mfKeys.mappings });
      invalidatePortfolio(qc);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "FUND_MAPPING_IN_USE") {
        const n = e.details?.["rows"];
        setNeedsRemap(typeof n === "number" ? n : mapping.rows);
        setError(null);
        return;
      }
      setError(e instanceof ApiError ? e.message : "The mapping could not be saved.");
    },
  });
  return (
    <form
      data-testid="pf-mf-mapping-form"
      aria-label={`Change the scheme for ${mapping.fund_name}`}
      className="mt-2 flex flex-col gap-2 rounded-control border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (pick) save.mutate(needsRemap !== null && confirmed);
      }}
    >
      <p className="text-body-sm text-text-1">
        Statement name: <strong>{mapping.fund_name}</strong>. Pick the scheme it belongs to.
      </p>
      {error ? (
        <Banner tone="error" testId="pf-mf-mapping-error">
          {error}
        </Banner>
      ) : null}
      <SchemePicker
        label="New scheme"
        testPrefix="pf-mf-map-scheme"
        onPick={(s) => {
          setPick({ code: s.code, name: s.name, plan: s.plan, option: s.option });
          setNeedsRemap(null);
          setConfirmed(false);
        }}
      />
      {pick ? (
        <p className="text-body-sm text-text-1" data-testid="pf-mf-mapping-pick">
          Chosen: {pick.name} ({planLabel(pick.plan)}, {optionLabel(pick.option)}), code {pick.code}
          .
        </p>
      ) : null}
      {needsRemap !== null ? (
        <label className="flex items-start gap-2 text-body-sm text-text-1">
          <input
            type="checkbox"
            data-testid="pf-mf-mapping-remap-confirm"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            {formatCount(needsRemap).text} stored transactions use this mapping. Re-map rewrites all
            of them to the new scheme in one step (each scheme and folio is re-checked, and nothing
            changes if a redemption would then exceed the units held).
          </span>
        </label>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="pf-mf-mapping-save"
          disabled={!pick || save.isPending || (needsRemap !== null && !confirmed)}
          className={`${BUTTON} border-accent font-medium`}
        >
          {needsRemap !== null ? "Re-map transactions" : "Save mapping"}
        </button>
        <button
          type="button"
          data-testid="pf-mf-mapping-close"
          onClick={onClose}
          className={BUTTON}
        >
          Close
        </button>
      </div>
    </form>
  );
}

/** Remembered fund-name -> scheme choices, with an explicit change/re-map action (MFH-23). */
export function MfMappingsPanel() {
  const [open, setOpen] = useState(false);
  // The list is fetched only once the panel is opened.
  const q = useMfMappings(open);
  const [savedText, setSavedText] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const parsed = useMemo(
    () => (q.data ? readRows(mfMappingSchema, q.data.data.items) : null),
    [q.data],
  );
  return (
    <section
      aria-labelledby="pf-mf-mapping-h"
      data-testid="pf-mf-mappings"
      className="flex flex-col gap-2"
    >
      <h3 id="pf-mf-mapping-h" className="text-body font-semibold">
        <button
          type="button"
          data-testid="pf-mf-mappings-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="touch-target inline-flex items-center underline"
        >
          Fund-name mappings {open ? "(hide)" : "(show)"}
        </button>
      </h3>
      {open ? (
        <>
          <p className="text-caption text-text-2">
            Your statement has only a fund name. The scheme you picked for each name is remembered
            here and used by later imports.
          </p>
          {savedText ? (
            <Banner tone="info" testId="pf-mf-mapping-saved">
              Mapping saved: {savedText}
            </Banner>
          ) : null}
          {q.isPending ? <Skeleton className="h-16 w-full" label="Loading mappings" /> : null}
          {q.isError ? (
            <Banner tone="error" testId="pf-mf-mappings-error">
              The mappings could not be loaded.{" "}
              <button
                type="button"
                data-testid="pf-mf-mappings-retry"
                onClick={() => void q.refetch()}
                className="underline"
              >
                Retry
              </button>
            </Banner>
          ) : null}
          {parsed && parsed.rows.length === 0 ? (
            <p className="text-body-sm text-text-2" data-testid="pf-mf-mappings-empty">
              No fund names are mapped yet. They appear after your first statement import.
            </p>
          ) : null}
          {parsed && parsed.rows.length > 0 ? (
            <ul className="flex flex-col gap-2" data-testid="pf-mf-mapping-list">
              {parsed.rows.map((m, i) => (
                <li
                  key={m.fund_name}
                  data-testid={`pf-mf-mapping-row-${i}`}
                  className="rounded-control border border-border p-2 text-body-sm"
                >
                  <div>
                    <strong>{m.fund_name}</strong> maps to {m.scheme_name}
                  </div>
                  <div className="text-micro text-text-2">
                    {planLabel(m.plan)}, {optionLabel(m.option)}, code {m.scheme_code}
                    {m.isin ? `, ISIN ${m.isin}` : ""}; {formatCount(m.rows).text} stored
                    transactions
                    {m.updated_at ? `; updated ${formatDate(m.updated_at).text}` : ""}
                  </div>
                  {m.audit_note ? (
                    <div className="text-micro text-text-2">Audit: {m.audit_note}</div>
                  ) : null}
                  <button
                    type="button"
                    data-testid="pf-mf-mapping-change"
                    onClick={() => setChanging(changing === m.fund_name ? null : m.fund_name)}
                    className={`${BUTTON} mt-1`}
                  >
                    Change scheme
                  </button>
                  {changing === m.fund_name ? (
                    <RemapForm
                      mapping={m}
                      onClose={() => setChanging(null)}
                      onSaved={(t) => {
                        setSavedText(t);
                        setChanging(null);
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
