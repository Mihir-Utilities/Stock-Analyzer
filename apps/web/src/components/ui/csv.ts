// CSV export that is safe to open in a spreadsheet (IMP-15).

const DANGEROUS_START = /^[=+\-@\t\r]/;

export type CsvValue = string | number | boolean | null | undefined;

/**
 * One CSV cell. Strings starting with `=`, `+`, `-`, `@`, TAB or CR get a leading `'` so a
 * spreadsheet treats them as text. Real numbers are written as numbers (a negative number is not
 * a formula); non-finite numbers and nulls become empty cells, never "NaN" or "Infinity".
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = DANGEROUS_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Browser download of a blob; the object URL is revoked straight away. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadCsv(csv: string, filename: string): void {
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
}
