import { METRICS, SCREENER_LIMITS, metricDef, metricLabel } from "./metrics";
import type { FilterSpec, ScreenSpec } from "./schemas";

// Screener builder state <-> request body (docs/03 section 9). The client validates the same
// limits the server enforces so the owner gets a message next to the field; the server remains
// authoritative and its 422 `fields[]` are shown too. No user text is ever concatenated into SQL
// or a URL here: the body is JSON and metric keys come only from the whitelist.

export const NUMERIC_OPS = [">", ">=", "<", "<=", "=", "between"] as const;
export const TEXT_OPS = ["=", "in"] as const;

export const OP_LABELS: Record<string, string> = {
  ">": "greater than",
  ">=": "at least",
  "<": "less than",
  "<=": "at most",
  "=": "equals",
  between: "between",
  in: "is one of",
};

export const UNIVERSE_KINDS = ["equity", "etf", "reit", "invit", "sme", "other"] as const;
export const DEFAULT_COLUMNS: ReadonlyArray<string> = [
  "market_cap_cr",
  "pe",
  "roe",
  "quality_score",
];
export const PAGE_LIMIT = 50;

export interface FilterDraft {
  id: number;
  metric: string;
  op: string;
  a: string;
  b: string;
  list: string;
}

export interface Draft {
  filters: FilterDraft[];
  sortMetric: string;
  sortDir: "asc" | "desc";
  columns: string[];
  kind: string;
  companyType: string;
  index: string;
}

export const emptyDraft = (): Draft => ({
  filters: [],
  sortMetric: "",
  sortDir: "desc",
  columns: [...DEFAULT_COLUMNS],
  kind: "equity",
  companyType: "",
  index: "",
});

export function newFilter(id: number, metric = "roe"): FilterDraft {
  return { id, metric, op: ">", a: "", b: "", list: "" };
}

export interface QueryBody {
  filters: FilterSpec[];
  sort?: { metric: string; dir: "asc" | "desc" };
  columns?: string[];
  universe: { kind: string; company_type?: string; index?: string };
  limit: number;
}

export type SavedSpec = Omit<QueryBody, "limit">;
export interface SavedBody {
  name: string;
  spec: SavedSpec;
}

export interface DraftError {
  /** Filter id, or null for a form-level field. */
  id: number | null;
  field: string;
  message: string;
}

const DECIMAL = /^[+-]?\d+(\.\d+)?$/;

export function parseNumber(raw: string): number | null {
  const t = raw.trim();
  if (!DECIMAL.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && Math.abs(v) <= SCREENER_LIMITS.maxNumber ? v : null;
}

export function opsFor(metric: string): ReadonlyArray<string> {
  return metricDef(metric)?.kind === "text" ? TEXT_OPS : NUMERIC_OPS;
}

export function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function buildFilter(f: FilterDraft, errors: DraftError[]): FilterSpec | null {
  const def = metricDef(f.metric);
  if (!def) {
    errors.push({ id: f.id, field: "metric", message: "Choose a metric from the list." });
    return null;
  }
  if (!opsFor(f.metric).includes(f.op)) {
    errors.push({ id: f.id, field: "op", message: "Choose an operator that fits this metric." });
    return null;
  }
  if (def.kind === "text") {
    if (f.op === "=") {
      const t = f.list.trim();
      if (t === "" || t.length > SCREENER_LIMITS.textLen) {
        errors.push({
          id: f.id,
          field: "value",
          message: `Enter 1 to ${SCREENER_LIMITS.textLen} characters.`,
        });
        return null;
      }
      return { metric: f.metric, op: "=", value: t };
    }
    const items = splitList(f.list);
    if (
      items.length === 0 ||
      items.length > SCREENER_LIMITS.inValues ||
      items.some((s) => s.length > SCREENER_LIMITS.textLen)
    ) {
      errors.push({
        id: f.id,
        field: "value",
        message: `Enter 1 to ${SCREENER_LIMITS.inValues} names separated by commas, each up to ${SCREENER_LIMITS.textLen} characters.`,
      });
      return null;
    }
    return { metric: f.metric, op: "in", value: items };
  }
  if (f.op === "between") {
    const lo = parseNumber(f.a);
    const hi = parseNumber(f.b);
    if (lo === null || hi === null) {
      errors.push({ id: f.id, field: "value", message: "Enter both bounds as plain numbers." });
      return null;
    }
    if (lo > hi) {
      errors.push({
        id: f.id,
        field: "value",
        message: "The lower bound must not exceed the upper.",
      });
      return null;
    }
    return { metric: f.metric, op: "between", value: [lo, hi] };
  }
  const v = parseNumber(f.a);
  if (v === null) {
    errors.push({ id: f.id, field: "value", message: "Enter a plain number, for example 15." });
    return null;
  }
  return { metric: f.metric, op: f.op, value: v };
}

export type BuildResult = { ok: true; body: QueryBody } | { ok: false; errors: DraftError[] };

export function buildQuery(d: Draft): BuildResult {
  const errors: DraftError[] = [];
  if (d.filters.length > SCREENER_LIMITS.filters) {
    errors.push({
      id: null,
      field: "filters",
      message: `At most ${SCREENER_LIMITS.filters} filters are allowed.`,
    });
  }
  const filters: FilterSpec[] = [];
  for (const f of d.filters) {
    const built = buildFilter(f, errors);
    if (built) filters.push(built);
  }
  if (d.sortMetric !== "" && !metricDef(d.sortMetric)) {
    errors.push({ id: null, field: "sort", message: "Choose a sort metric from the list." });
  }
  const columns = [...new Set(d.columns)].filter((c) => metricDef(c));
  if (columns.length > SCREENER_LIMITS.columns) {
    errors.push({ id: null, field: "columns", message: "Too many columns." });
  }
  const index = d.index.trim();
  if (index.length > SCREENER_LIMITS.textLen) {
    errors.push({
      id: null,
      field: "index",
      message: `Index name is at most ${SCREENER_LIMITS.textLen} characters.`,
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  const body: QueryBody = {
    filters,
    universe: {
      kind: d.kind,
      ...(d.companyType ? { company_type: d.companyType } : {}),
      ...(index ? { index } : {}),
    },
    limit: PAGE_LIMIT,
  };
  if (d.sortMetric) body.sort = { metric: d.sortMetric, dir: d.sortDir };
  if (columns.length > 0) body.columns = columns;
  return { ok: true, body };
}

export function toSavedSpec(body: QueryBody): SavedSpec {
  const { limit: _limit, ...rest } = body;
  void _limit;
  return rest;
}

/** Metrics shown as table columns: filter metrics, the sort metric, then the chosen columns. */
export function displayMetrics(body: QueryBody | SavedSpec): string[] {
  return [
    ...new Set([
      ...body.filters.map((f) => f.metric),
      ...(body.sort ? [body.sort.metric] : []),
      ...(body.columns ?? []),
    ]),
  ];
}

/** A saved or preset spec as builder state; filters on metrics outside the whitelist are dropped. */
export function specToDraft(
  spec: ScreenSpec,
  nextId: () => number,
): { draft: Draft; dropped: string[] } {
  const dropped: string[] = [];
  const filters: FilterDraft[] = [];
  for (const f of spec.filters) {
    const def = metricDef(f.metric);
    if (!def || !opsFor(f.metric).includes(f.op)) {
      dropped.push(metricLabel(f.metric));
      continue;
    }
    const base = newFilter(nextId(), f.metric);
    base.op = f.op;
    if (Array.isArray(f.value)) {
      if (f.op === "between") {
        base.a = String(f.value[0] ?? "");
        base.b = String(f.value[1] ?? "");
      } else base.list = f.value.join(", ");
    } else if (def.kind === "text") base.list = String(f.value);
    else base.a = String(f.value);
    filters.push(base);
  }
  const sort = spec.sort && metricDef(spec.sort.metric) ? spec.sort : null;
  if (spec.sort && !sort) dropped.push(`sort on ${metricLabel(spec.sort.metric)}`);
  for (const c of spec.columns ?? []) {
    if (!metricDef(c)) dropped.push(`column ${metricLabel(c)}`);
  }
  return {
    draft: {
      filters,
      sortMetric: sort?.metric ?? "",
      sortDir: sort?.dir === "asc" ? "asc" : "desc",
      columns: (spec.columns ?? []).filter((c) => metricDef(c)),
      kind: (UNIVERSE_KINDS as ReadonlyArray<string>).includes(spec.universe?.kind ?? "")
        ? (spec.universe?.kind as string)
        : "equity",
      companyType:
        spec.universe?.company_type === "general" || spec.universe?.company_type === "financial"
          ? spec.universe.company_type
          : "",
      index: spec.universe?.index ?? "",
    },
    dropped,
  };
}

/** docs/03 section 9: `^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,59}$`. */
export const SAVED_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,59}$/;

export function savedNameError(raw: string): string | null {
  const name = raw.trim();
  if (name === "") return "Enter a name for this screen.";
  if (!SAVED_NAME.test(name)) {
    return "Use 1 to 60 characters: letters and digits first, then letters, digits, spaces and _ . ( ) -.";
  }
  return null;
}

export const SAVED_NAME_LOWER = (name: string): string => name.trim().toLowerCase();

/** Every whitelisted key, for the pickers. */
export const ALL_METRIC_KEYS: ReadonlyArray<string> = METRICS.map((m) => m.key);
