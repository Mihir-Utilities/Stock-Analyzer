"use client";

import { Banner } from "@/components/ui/banners";
import { DASH, formatCount } from "@/lib/format";
import { isHeaderIssue } from "@/lib/imports/mf";
import type { RowIssue } from "@/lib/imports/schemas";

/**
 * Row errors of a statement with an Include box per errored data row (B15R-6). An unticked row is
 * sent in `excluded_rows` and its errors stop blocking; a header problem can never be excluded.
 * All text comes from the API and is rendered as plain escaped text.
 */
export function MfErrorRows({
  errors,
  total,
  excluded,
  onToggle,
  blocking,
}: {
  errors: RowIssue[];
  total: number;
  excluded: ReadonlySet<number>;
  onToggle: (line: number, include: boolean) => void;
  /** Errors that still block the commit (not on an unticked row). */
  blocking: number;
}) {
  if (total === 0) return null;
  const headerCount = errors.filter((e) => isHeaderIssue(e)).length;
  return (
    <section
      aria-label="Errors in the file"
      data-testid="mf-import-errors"
      className="flex flex-col gap-2"
    >
      <h3 className="text-body font-semibold text-text-1">Errors ({formatCount(total).text})</h3>
      <p className="text-body-sm text-text-2">
        Fix these in the file and upload it again, or untick the rows you want to leave out. Nothing
        is committed while an error remains on a row you keep. Leaving out only some of the errored
        rows still blocks the commit.
      </p>
      {headerCount > 0 ? (
        <Banner tone="error" testId="mf-import-header-error">
          The file header or layout has a problem. A header problem cannot be left out: fix the file
          and upload it again.
        </Banner>
      ) : null}
      <p className="text-body-sm text-text-1" data-testid="mf-import-blocking">
        {blocking === 0
          ? "No error blocks the commit any more."
          : `${formatCount(blocking).text} errors still block the commit.`}
      </p>
      <div
        tabIndex={0}
        role="region"
        aria-label="Errors table"
        className="max-h-64 overflow-auto rounded-control border border-border"
      >
        <table className="w-full text-left text-body-sm">
          <caption className="sr-only">Errors with row, column and an Include box</caption>
          <thead className="sticky top-0 bg-surface-2 text-text-2">
            <tr>
              <th scope="col" className="px-2 py-1 font-medium">
                Include
              </th>
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
            {errors.map((e, i) => (
              <tr
                key={`${e.row}-${e.column}-${i}`}
                data-testid="import-error-row"
                className="border-t border-border"
              >
                <td className="px-2 py-1">
                  {isHeaderIssue(e) ? (
                    DASH
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={`Include row ${e.row}`}
                      data-testid={`mf-err-include-${e.row}`}
                      checked={!excluded.has(e.row)}
                      onChange={(ev) => onToggle(e.row, ev.target.checked)}
                    />
                  )}
                </td>
                <td className="px-2 py-1 tabular-nums">{e.row === 0 ? "File" : e.row}</td>
                <td className="px-2 py-1">{e.column || DASH}</td>
                <td className="px-2 py-1">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > errors.length ? (
        <p className="text-caption text-text-2" data-testid="mf-import-errors-cut">
          Showing the first {formatCount(errors.length).text} of {formatCount(total).text}. The rest
          cannot be left out here: fix the file.
        </p>
      ) : null}
    </section>
  );
}
