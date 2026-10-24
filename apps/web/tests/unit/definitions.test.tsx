import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs generator without type declarations
import { buildDefinitions, ENTRIES, OUT_PATH, SPEC_PATH } from "../../scripts/gen-definitions.mjs";
import { DefinitionTip } from "@/components/ui/DefinitionTip";
import { definitions, getDefinition } from "@/lib/definitions";

describe("UI-23: definitions.ts is generated from docs/05", () => {
  it("the committed file matches the generator output (not stale)", () => {
    const spec = readFileSync(SPEC_PATH as string, "utf8");
    const current = readFileSync(OUT_PATH as string, "utf8").replace(/\r\n/g, "\n");
    expect(current).toBe(buildDefinitions(spec));
  });
  it("every entry has a label and a non-empty formula text without markdown", () => {
    expect(Object.keys(definitions).length).toBe((ENTRIES as unknown[]).length);
    for (const d of Object.values(definitions)) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.text.length).toBeGreaterThan(10);
      expect(d.text).not.toMatch(/\*\*|`/);
    }
  });
  it("key formulas carry the spec wording", () => {
    expect(getDefinition("pe").text).toMatch(/eps_ttm_adj/);
    expect(getDefinition("rsi").text).toMatch(/Wilder/);
    expect(getDefinition("roe").text).toMatch(/average\(equity_t, equity_\{t-1\}\)/);
  });
  it("a missing anchor fails generation instead of going stale", () => {
    expect(() => buildDefinitions("# empty spec")).toThrow(/anchor/);
  });
});

describe("UI-23: DefinitionTip", () => {
  it("opens a popover with the formula text", async () => {
    render(<DefinitionTip term="pe" />);
    await userEvent.click(screen.getByTestId("definition-pe"));
    expect(screen.getByText(/eps_ttm_adj/)).toBeTruthy();
  });
});
