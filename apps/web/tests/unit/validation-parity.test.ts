import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOLDING_FIELDS,
  RESULT_FIELDS,
  cleanNumber,
  parseDate,
  validateAction,
  validateResults,
  validateShareholding,
} from "@/lib/imports/entry-validate";

// F13b-3 drift guard: the same table is read by apps/api/internal/importers/parity_test.go. The
// server is authoritative; if a case fails here the browser mirror is fixed, not the table.

interface Case {
  id: string;
  input: unknown;
  today?: string;
  ok: boolean;
  value?: string;
  field?: string;
  error_contains?: string;
}
interface Table {
  numbers: Case[];
  dates: Case[];
  results: Case[];
  shareholding: Case[];
  actions: Case[];
}

const table = JSON.parse(
  readFileSync(join(process.cwd(), "../../fixtures/validation-cases.json"), "utf8"),
) as Table;

function expectOutcome(c: Case, errors: Record<string, string>) {
  if (c.ok) {
    expect(errors, c.id).toEqual({});
    return;
  }
  expect(c.field, c.id).toBeDefined();
  expect(errors[c.field ?? ""], c.id).toContain(c.error_contains ?? "");
}

function blanks<T extends string>(keys: readonly T[], given: Record<string, string> = {}) {
  return Object.fromEntries(keys.map((k) => [k, given[k] ?? ""])) as Record<T, string>;
}

describe("IMP-68 validation parity table (F13b-3): numbers", () => {
  it.each(table.numbers.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = cleanNumber(c.input as string);
    if (c.ok) expect(r).toEqual({ ok: true, value: c.value });
    else {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(c.error_contains ?? "");
    }
  });
});

describe("IMP-68 validation parity table (F13b-3): dates", () => {
  it.each(table.dates.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = parseDate(c.input as string);
    if (c.ok) expect(r).toEqual({ ok: true, value: c.value });
    else {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(c.error_contains ?? "");
    }
  });
});

describe("IMP-68 validation parity table (F13b-3): results", () => {
  it.each(table.results.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const i = c.input as {
      basis: string;
      period_type: string;
      period_end: string;
      values: Record<string, string>;
    };
    const { errors } = validateResults(
      {
        basis: i.basis,
        periodType: i.period_type,
        periodEnd: i.period_end,
        values: blanks(RESULT_FIELDS, i.values),
      },
      c.today ?? "",
    );
    expectOutcome(c, errors);
  });
});

describe("IMP-68 validation parity table (F13b-3): shareholding", () => {
  it.each(table.shareholding.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const i = c.input as {
      quarter_end: string;
      filed_on?: string;
      count?: string;
      pct: Record<string, string>;
    };
    const { errors } = validateShareholding(
      {
        quarterEnd: i.quarter_end,
        filedOn: i.filed_on ?? "",
        count: i.count ?? "",
        pct: blanks(HOLDING_FIELDS, i.pct),
      },
      c.today ?? "",
    );
    expectOutcome(c, errors);
  });
});

describe("IMP-68 validation parity table (F13b-3): actions", () => {
  it.each(table.actions.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const i = c.input as Record<string, string | undefined>;
    const { errors } = validateAction({
      exDate: i.ex_date ?? "",
      type: i.type ?? "",
      ratioNum: i.ratio_num ?? "",
      ratioDen: i.ratio_den ?? "",
      amount: i.amount ?? "",
      purpose: i.purpose ?? "",
    });
    expectOutcome(c, errors);
  });
});
