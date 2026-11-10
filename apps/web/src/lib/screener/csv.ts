import { toCsv, type CsvValue } from "@/components/ui/csv";
import { metricHeader } from "./metrics";
import type { ScreenerItem } from "./schemas";

/**
 * CSV of the loaded screener rows (docs/06 6.6). Cells go through the shared CSV-injection guard
 * (`csvCell`: `=`, `+`, `-`, `@`, TAB and CR get a leading quote); an unknown value is an empty
 * cell, never 0. Numbers are raw API numbers in the unit named in the header.
 */
export function screenerCsv(
  items: ReadonlyArray<ScreenerItem>,
  metrics: ReadonlyArray<string>,
  units: Record<string, string>,
): string {
  const headers = [
    "Symbol",
    "Name",
    ...metrics.map((m) => metricHeader(m, units)),
    "Coverage (percent of metrics)",
    "Last updated (IST date)",
    "Last updated source",
    "Stale",
    "Stale reason",
  ];
  const rows: CsvValue[][] = items.map((it) => [
    it.symbol,
    it.name,
    ...metrics.map((m) => it.values[m] ?? null),
    Math.round(it.coverage * 1000) / 10,
    it.last_updated,
    it.last_updated_source,
    it.stale,
    it.stale_reason,
  ]);
  return toCsv(headers, rows);
}
