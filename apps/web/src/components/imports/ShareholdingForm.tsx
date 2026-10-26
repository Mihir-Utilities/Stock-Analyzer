"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { postShareholding } from "@/lib/imports/api";
import {
  HOLDING_FIELDS,
  noteError,
  todayIst,
  validateShareholding,
  type FieldErrors,
  type HoldingField,
} from "@/lib/imports/entry-validate";
import { useSingleFlight } from "@/lib/imports/single-flight";
import {
  CellInput,
  GenericError,
  ManualResultPanel,
  NoteInput,
  SubmitButton,
  SymbolInput,
  pick,
  serverFieldMap,
} from "./ManualCommon";

const LABELS: Record<HoldingField, string> = {
  promoter: "Promoter",
  fii: "FII / FPI",
  dii: "DII",
  mf: "Mutual funds (part of DII)",
  insurance: "Insurance (part of DII)",
  govt: "Government",
  public: "Public",
  pledged_of_promoter: "Pledged share of promoter holding",
};

const emptyPct = (): Record<HoldingField, string> =>
  Object.fromEntries(HOLDING_FIELDS.map((k) => [k, ""])) as Record<HoldingField, string>;

/** Manual shareholding quarter (docs/01 7.3 and 7.6; same validators as shareholding.csv). */
export function ShareholdingForm() {
  const [symbol, setSymbol] = useState("");
  const [quarterEnd, setQuarterEnd] = useState("");
  const [filedOn, setFiledOn] = useState("");
  const [count, setCount] = useState("");
  const [pct, setPct] = useState<Record<HoldingField, string>>(emptyPct);
  const [note, setNote] = useState("");
  const [local, setLocal] = useState<FieldErrors>({});
  const once = useSingleFlight();

  const save = useMutation({
    mutationFn: (v: { symbol: string; body: Record<string, unknown> }) =>
      postShareholding(v.symbol, v.body),
  });
  const server = serverFieldMap(save.error);
  const msg = (k: string) => pick(local, server, k);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { errors, body } = validateShareholding({ quarterEnd, filedOn, count, pct }, todayIst());
    if (!symbol.trim()) errors.symbol = "Enter the exchange symbol.";
    const ne = noteError(note);
    if (ne) errors.note = ne;
    setLocal(errors);
    if (Object.keys(errors).length > 0 || !body) return;
    const payload: Record<string, unknown> = { ...body };
    if (note.trim()) payload.note = note.trim();
    once(() => save.mutateAsync({ symbol, body: payload }));
  };

  return (
    <Card title="Shareholding quarter" testId="shareholding-form">
      <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-3">
        <p className="text-body-sm text-text-2">
          Percent numbers from 0 to 100. Leave a cell empty when the filing does not give it: it is
          stored as unknown, never as 0. Promoter + FII + DII + government + public must add up to
          100, give or take 1.
        </p>
        <SymbolInput
          value={symbol}
          onChange={setSymbol}
          error={msg("symbol")}
          testId="shareholding-symbol"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CellInput
            label="Quarter end"
            hint="31 Mar, 30 Jun, 30 Sep or 31 Dec."
            required
            value={quarterEnd}
            onChange={setQuarterEnd}
            error={msg("quarter_end")}
            testId="shareholding-quarter-end"
            placeholder="2026-09-30"
          />
          <CellInput
            label="Filed on (optional)"
            value={filedOn}
            onChange={setFiledOn}
            error={msg("filed_on")}
            testId="shareholding-filed-on"
            placeholder="2026-10-15"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {HOLDING_FIELDS.map((k) => (
            <CellInput
              key={k}
              label={LABELS[k]}
              unit="%"
              value={pct[k]}
              onChange={(v) => setPct((s) => ({ ...s, [k]: v }))}
              error={msg(k)}
              testId={`shareholding-${k}`}
            />
          ))}
          <CellInput
            label="Number of shareholders (optional)"
            value={count}
            onChange={setCount}
            error={msg("shareholders_count")}
            testId="shareholding-count"
          />
        </div>
        <NoteInput value={note} onChange={setNote} error={msg("note")} testId="shareholding-note" />
        <GenericError
          error={save.error}
          shown={Object.keys(server).length > 0}
          testId="shareholding-error"
          unknownSymbolText="This symbol is not in your stock list. Add the stock first."
        />
        {save.isSuccess ? (
          <ManualResultPanel
            result={save.data}
            title="Shareholding saved"
            testId="shareholding-saved"
          />
        ) : null}
        <div>
          <SubmitButton
            testId="shareholding-submit"
            pending={save.isPending}
            label="Save shareholding"
          />
        </div>
      </form>
    </Card>
  );
}
