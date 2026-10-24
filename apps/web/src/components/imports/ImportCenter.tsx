"use client";

import { Card } from "@/components/ui/Card";
import { Tabs } from "@/components/ui/overlays";
import { AddStockForm } from "./AddStockForm";
import { DeletePricesAction } from "./DeletePricesAction";
import { ImportWizard, templateUrl } from "./ImportWizard";
import { StorageMeter } from "./StorageMeter";
import { TrimHistory } from "./TrimHistory";
import { IMPORT_KINDS } from "@/lib/imports/schemas";

/** Persistent rights notice (docs/06 section 6.10), shown above every tab. */
export const RIGHTS_NOTICE =
  "Enter or import only data you have the right to use. Prefer company filings and your own records.";

const TEMPLATE_TEXT: Record<(typeof IMPORT_KINDS)[number], string> = {
  instruments: "Your stock list: symbol and name, with optional ISIN, series, kind and status.",
  prices: "Daily prices: symbol, date, open, high, low, close, volume.",
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
              className="w-fit text-body text-accent underline"
            >
              Download {k}.csv template
            </a>
            <span className="text-body-sm text-text-2">{TEMPLATE_TEXT[k]}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-body-sm text-text-2">
        Templates for results, shareholding, corporate actions and holidays arrive with the next
        import task.
      </p>
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
          { id: "forms", label: "Manual forms", content: <AddStockForm /> },
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
