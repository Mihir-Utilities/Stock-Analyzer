"use client";

import { Card } from "@/components/ui/Card";
import { Tabs } from "@/components/ui/overlays";
import { BatchesTab } from "./BatchesTab";
import { DeletePricesAction } from "./DeletePricesAction";
import { ImportWizard, templateUrl } from "./ImportWizard";
import { ManualForms } from "./ManualForms";
import { StorageMeter } from "./StorageMeter";
import { TrimHistory } from "./TrimHistory";
import { IMPORT_KINDS } from "@/lib/imports/schemas";

/** Persistent rights notice (docs/06 section 6.10), shown above every tab. */
export const RIGHTS_NOTICE =
  "Enter or import only data you have the right to use. Prefer company filings and your own records.";

const TEMPLATE_TEXT: Record<(typeof IMPORT_KINDS)[number], string> = {
  instruments: "Your stock list: symbol and name, with optional ISIN, series, kind and status.",
  prices: "Daily prices: symbol, date, open, high, low, close, volume.",
  holidays:
    "Market holidays of one year: date, optional description and segment. The template has the header row only; type the dates from the exchange circular.",
  results_quarterly: "Quarterly results, one row per stock, basis and quarter end (INR crore).",
  results_annual: "Annual results, one row per stock, basis and year end (INR crore).",
  balance_cashflow: "Annual balance sheet and cash flow, one row per stock, basis and year end.",
  fundamentals_long: "Any fundamentals metric as one row each: symbol, basis, period, key, value.",
  shareholding: "Shareholding pattern per quarter, in percent.",
  corporate_actions: "Splits, bonuses, dividends and other actions with their ex-dates.",
  instrument_meta: "Sector, industry, company type and index tags per stock.",
};

function TemplatesTab() {
  return (
    <Card title="Templates" testId="templates">
      <ul className="flex flex-col gap-3">
        {IMPORT_KINDS.map((k) => (
          <li key={k} className="flex flex-col gap-1">
            <a
              href={templateUrl(k)}
              download
              data-testid={`template-${k}`}
              className="touch-target inline-flex w-fit items-center text-body text-accent underline"
            >
              Download {k}.csv template
            </a>
            <span className="text-body-sm text-text-2">{TEMPLATE_TEXT[k]}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ImportCenter() {
  return (
    <div className="flex flex-col gap-4" data-testid="import-center">
      <h1 className="text-page font-semibold text-text-1">Import center</h1>
      <p
        data-testid="rights-notice"
        className="rounded-control border border-border bg-surface-2 px-3 py-2 text-body-sm text-text-1"
      >
        {RIGHTS_NOTICE}
      </p>
      <Tabs
        label="Import center sections"
        tabs={[
          { id: "upload", label: "Upload", content: <ImportWizard /> },
          { id: "templates", label: "Templates", content: <TemplatesTab /> },
          { id: "forms", label: "Manual forms", content: <ManualForms /> },
          { id: "batches", label: "Batches", content: <BatchesTab /> },
          {
            id: "storage",
            label: "Storage",
            content: (
              <div className="flex flex-col gap-4">
                <StorageMeter />
                <TrimHistory />
                <DeletePricesAction />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
