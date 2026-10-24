import type { RowIssue } from "@/lib/imports/schemas";
import { DASH, formatCount } from "@/lib/format";

/** Cell text for the preview table: empty cells show the dash, never 0. Raw file values, so no number formatting. */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined || v === "") return DASH;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : DASH;
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * Row and column errors or warnings (decision D-P: every issue names the offending row and
 * column; row numbers are file lines, header = 1). The API keeps the first 200 entries and sends
 * the full count, so the list says when it is cut.
 */
export function IssueList({
  kind,
  issues,
  total,
}: {
  kind: "error" | "warning";
  issues: RowIssue[];
  total: number;
}) {
  if (total === 0) return null;
  const label = kind === "error" ? "Errors" : "Warnings";
  return (
    <section
      aria-label={`${label} in the file`}
      data-testid={`import-${kind}s`}
      className="flex flex-col gap-2"
    >
      <h3 className="text-body font-semibold text-text-1">
        {label} ({formatCount(total).text})
      </h3>
      {kind === "error" ? (
        <p className="text-body-sm text-text-2">
          Fix these in the file and upload it again. Nothing is committed while errors exist.
        </p>
      ) : (
        <p className="text-body-sm text-text-2">
          Warnings do not block the commit; the rows are kept as described.
        </p>
      )}
      <div
        tabIndex={0}
        role="region"
        aria-label={`${label} table`}
        className="max-h-64 overflow-auto rounded-control border border-border"
      >
        <table className="w-full text-left text-body-sm">
          <caption className="sr-only">{label} with row and column</caption>
          <thead className="sticky top-0 bg-surface-2 text-text-2">
            <tr>
              <th scope="col" className="px-2 py-1 font-medium">
                Row
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                Column
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                Message
              </th>
            </tr>
          </thead>
          <tbody>
            {issues.map((e, i) => (
              <tr
                key={`${e.row}-${e.column}-${i}`}
                data-testid={`import-${kind}-row`}
                className="border-t border-border"
              >
                <td className="px-2 py-1 tabular-nums">{e.row === 0 ? "File" : e.row}</td>
                <td className="px-2 py-1">{e.column || DASH}</td>
                <td className="px-2 py-1">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > issues.length ? (
        <p className="text-caption text-text-2" data-testid={`import-${kind}s-cut`}>
          Showing the first {formatCount(issues.length).text} of {formatCount(total).text}.
        </p>
      ) : null}
    </section>
  );
}

/** First rows of the file as the API normalised them. Empty cells show the dash, never 0. */
export function PreviewTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) {
    return (
      <p className="text-body-sm text-text-2" data-testid="import-preview-empty">
        No valid rows to preview.
      </p>
    );
  }
  const columns: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Preview table"
      className="overflow-auto rounded-control border border-border"
    >
      <table data-testid="import-preview" className="w-full text-left text-body-sm">
        <caption className="sr-only">First {rows.length} rows of the file</caption>
        <thead className="bg-surface-2 text-text-2">
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className="whitespace-nowrap px-2 py-1 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {columns.map((c) => (
                <td key={c} className="whitespace-nowrap px-2 py-1 tabular-nums">
                  {formatCell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
