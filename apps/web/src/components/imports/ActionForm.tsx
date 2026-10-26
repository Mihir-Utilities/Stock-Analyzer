"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { FormField, inputClass } from "@/components/ui/FormField";
import { postAction } from "@/lib/imports/api";
import {
  ACTION_TYPES,
  noteError,
  validateAction,
  type FieldErrors,
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

const TYPE_LABEL: Record<(typeof ACTION_TYPES)[number], string> = {
  split: "Split",
  bonus: "Bonus",
  dividend: "Dividend",
  rights: "Rights issue",
  buyback: "Buyback",
  merger: "Merger",
  demerger: "Demerger",
  other: "Other",
};

/** Manual corporate action, stored as confirmed (docs/01 7.4; same validators as the CSV). */
export function ActionForm() {
  const [symbol, setSymbol] = useState("");
  const [exDate, setExDate] = useState("");
  const [type, setType] = useState("split");
  const [ratioNum, setRatioNum] = useState("");
  const [ratioDen, setRatioDen] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [note, setNote] = useState("");
  const [local, setLocal] = useState<FieldErrors>({});
  const once = useSingleFlight();

  const save = useMutation({
    mutationFn: (v: { symbol: string; body: Record<string, unknown> }) =>
      postAction(v.symbol, v.body),
  });
  const server = serverFieldMap(save.error);
  const msg = (k: string) => pick(local, server, k);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { errors, body } = validateAction({ exDate, type, ratioNum, ratioDen, amount, purpose });
    if (!symbol.trim()) errors.symbol = "Enter the exchange symbol.";
    const ne = noteError(note);
    if (ne) errors.note = ne;
    setLocal(errors);
    if (Object.keys(errors).length > 0 || !body) return;
    const payload: Record<string, unknown> = { ...body };
    if (note.trim()) payload.note = note.trim();
    once(() => save.mutateAsync({ symbol, body: payload }));
  };

  const ratioHint =
    type === "split"
      ? "Old face value and new face value, for example 10 and 2."
      : type === "bonus"
        ? "New shares and shares held, for example 1 and 1 for a 1:1 bonus."
        : "Needed for split and bonus; for other types give both or neither.";

  return (
    <Card title="Corporate action" testId="action-form">
      <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-3">
        <p className="text-body-sm text-text-2">
          Saved as confirmed. A split or bonus changes the price history only after the
          re-adjustment runs; a repeat of the same stock, ex-date, type and purpose updates that
          action.
        </p>
        <SymbolInput
          value={symbol}
          onChange={setSymbol}
          error={msg("symbol")}
          testId="action-symbol"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CellInput
            label="Ex-date"
            required
            value={exDate}
            onChange={setExDate}
            error={msg("ex_date")}
            testId="action-ex-date"
            placeholder="2026-09-12"
          />
          <FormField label="Type" required error={msg("type")}>
            {(p) => (
              <select
                {...p}
                data-testid="action-type"
                className={inputClass}
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {ACTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <CellInput
            label="Ratio number"
            hint={ratioHint}
            value={ratioNum}
            onChange={setRatioNum}
            error={msg("ratio_num")}
            testId="action-ratio-num"
          />
          <CellInput
            label="Ratio denominator"
            value={ratioDen}
            onChange={setRatioDen}
            error={msg("ratio_den")}
            testId="action-ratio-den"
          />
          <CellInput
            label="Amount per share"
            hint={type === "dividend" ? "Required for a dividend." : "Optional."}
            unit="INR"
            value={amount}
            onChange={setAmount}
            error={msg("amount_per_share")}
            testId="action-amount"
          />
        </div>
        <FormField label="Purpose (optional)" error={msg("purpose_text")}>
          {(p) => (
            <input
              {...p}
              data-testid="action-purpose"
              className={inputClass}
              maxLength={500}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          )}
        </FormField>
        <NoteInput value={note} onChange={setNote} error={msg("note")} testId="action-note" />
        <GenericError
          error={save.error}
          shown={Object.keys(server).length > 0}
          testId="action-error"
          unknownSymbolText="This symbol is not in your stock list. Add the stock first."
        />
        {save.isSuccess ? (
          <ManualResultPanel result={save.data} title="Action saved" testId="action-saved" />
        ) : null}
        <div>
          <SubmitButton testId="action-submit" pending={save.isPending} label="Save action" />
        </div>
      </form>
    </Card>
  );
}
