import { parseDate } from "./entry-validate";

/** Splits one CSV line on `sep`, honouring double quotes (enough for a date column). */
function splitLine(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells;
}

/**
 * Distinct years (ascending) of the valid dates in the `date` column of a holidays.csv text.
 * Stopgap for F13bR-1: the validate response carries no year summary, so the review step derives
 * the years the commit will replace from the uploaded file. Rows that fail the date rules are
 * skipped (the server reports them as errors and blocks the commit).
 */
export function holidayYears(text: string): number[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\n|\r/);
  const head = lines[0] ?? "";
  const sep = head.split(";").length > head.split(",").length ? ";" : ",";
  const col = splitLine(head, sep).findIndex((h) => h.trim().toLowerCase() === "date");
  if (col < 0) return [];
  const years = new Set<number>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const r = parseDate(splitLine(line, sep)[col] ?? "");
    if (r.ok && r.value) years.add(Number(r.value.slice(0, 4)));
  }
  return [...years].sort((a, b) => a - b);
}
