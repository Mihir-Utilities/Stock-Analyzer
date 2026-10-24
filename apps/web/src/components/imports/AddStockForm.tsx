"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { FormField, inputClass } from "@/components/ui/FormField";
import { addStock } from "@/lib/imports/api";
import { describeError, fieldMessage, isApiError } from "@/lib/imports/errors";

const WARNING_TEXT: Record<string, string> = {
  ISIN_MALFORMED:
    "The ISIN is not valid (IN followed by 10 letters or digits), so the stock was added without an ISIN.",
  SYMBOL_UPPERCASED: "The symbol was converted to upper case.",
};

/** Manual Add stock form (docs/06 section 6.10; same validators as instruments.csv, INS-15). */
export function AddStockForm() {
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [isin, setIsin] = useState("");
  const [local, setLocal] = useState<{ symbol?: string; name?: string }>({});
  const symbolRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: addStock,
    onSuccess: () => {
      setSymbol("");
      setName("");
      setIsin("");
      void qc.invalidateQueries({ queryKey: ["stocks"] });
      symbolRef.current?.focus();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: { symbol?: string; name?: string } = {};
    if (!symbol.trim()) errs.symbol = "Enter the exchange symbol.";
    if (!name.trim()) errs.name = "Enter the company name.";
    setLocal(errs);
    if (errs.symbol || errs.name) return;
    create.mutate({ symbol, name, isin });
  };

  const conflict = isApiError(create.error, "CONFLICT");
  const symbolErr =
    local.symbol ??
    (conflict
      ? "This symbol already exists. Use instruments.csv to update it."
      : fieldMessage(create.error, "symbol"));
  const nameErr = local.name ?? fieldMessage(create.error, "name");
  const isinErr = fieldMessage(create.error, "isin");
  const generic =
    create.isError && !conflict && !symbolErr && !nameErr && !isinErr
      ? describeError(create.error)
      : null;

  return (
    <Card title="Add stock" testId="add-stock">
      <form onSubmit={submit} noValidate className="flex max-w-lg flex-col gap-3">
        <FormField
          label="Symbol"
          hint="Exchange symbol, for example TCS or M&M. Letters, digits, & and - only."
          required
          error={symbolErr}
        >
          {(p) => (
            <input
              {...p}
              ref={symbolRef}
              data-testid="add-stock-symbol"
              className={inputClass}
              autoComplete="off"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Name" required error={nameErr}>
          {(p) => (
            <input
              {...p}
              data-testid="add-stock-name"
              className={inputClass}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="ISIN (optional)"
          hint="IN followed by 10 letters or digits."
          error={isinErr}
        >
          {(p) => (
            <input
              {...p}
              data-testid="add-stock-isin"
              className={inputClass}
              autoComplete="off"
              value={isin}
              onChange={(e) => setIsin(e.target.value)}
            />
          )}
        </FormField>
        {generic ? (
          <Banner tone="error" testId="add-stock-error">
            {generic}
          </Banner>
        ) : null}
        {create.isSuccess ? (
          <div className="flex flex-col gap-2" role="status" data-testid="add-stock-success">
            <Banner tone="info" testId="add-stock-added">
              Added {create.data.symbol}. Import prices to see its history.
            </Banner>
            {create.data.warnings.map((w) => (
              <Banner key={w} tone="warn" testId="add-stock-warning">
                {WARNING_TEXT[w] ?? w}
              </Banner>
            ))}
          </div>
        ) : null}
        <div>
          <button
            type="submit"
            data-testid="add-stock-submit"
            disabled={create.isPending}
            className="touch-target h-9 rounded-control border border-accent px-3 text-body-sm font-medium hover:bg-surface-3 disabled:opacity-50"
          >
            {create.isPending ? "Adding" : "Add stock"}
          </button>
        </div>
      </form>
    </Card>
  );
}
