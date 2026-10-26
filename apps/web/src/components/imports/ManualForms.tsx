"use client";

import { Tabs } from "@/components/ui/overlays";
import { ActionForm } from "./ActionForm";
import { AddStockForm } from "./AddStockForm";
import { ResultsForm } from "./ResultsForm";
import { ShareholdingForm } from "./ShareholdingForm";

/**
 * Manual forms tab (docs/06 section 6.10). Calendar events have no entry route in docs/03 section
 * 14, so there is no form for them (assumption F13b-1).
 */
export function ManualForms() {
  return (
    <div className="flex flex-col gap-3" data-testid="manual-forms">
      <p className="text-body-sm text-text-2" data-testid="manual-forms-note">
        Forms use the same checks as the CSV imports. Numbers: a comma is accepted only as a
        thousands separator (1,234.56 or 1,23,456.78); write decimals with a point. Calendar events
        cannot be entered yet.
      </p>
      <Tabs
        label="Manual forms"
        tabs={[
          { id: "stock", label: "Add stock", content: <AddStockForm /> },
          { id: "results", label: "Results", content: <ResultsForm /> },
          { id: "shareholding", label: "Shareholding", content: <ShareholdingForm /> },
          { id: "action", label: "Corporate action", content: <ActionForm /> },
        ]}
      />
    </div>
  );
}
