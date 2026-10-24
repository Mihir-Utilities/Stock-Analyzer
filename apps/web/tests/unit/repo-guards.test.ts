import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOption, type ChartDataset } from "@/components/charts/chart-data";
import { heatColor } from "@/components/ui/Heatmap";

const webRoot = process.cwd();
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(join(webRoot, "src")).filter((f) => /\.(tsx?|css)$/.test(f));

describe("external links (CLAUDE.md security checklist)", () => {
  it('every target="_blank" in src carries rel="noopener noreferrer"', () => {
    const offenders: string[] = [];
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      // JSX element or object literal: look at the tag/props around each occurrence.
      for (const m of text.matchAll(/target=(?:"_blank"|\{"_blank"\})|target:\s*"_blank"/g)) {
        const around = text.slice(Math.max(0, m.index - 300), m.index + 300);
        if (
          !/rel=(?:"|\{")noopener noreferrer/.test(around) &&
          !/rel:\s*"noopener noreferrer"/.test(around)
        ) {
          offenders.push(f);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only ExternalLink opens new tabs", () => {
    const users = sources.filter((f) => /_blank/.test(readFileSync(f, "utf8")));
    expect(users.map((f) => f.replace(/\\/g, "/").split("/").pop())).toEqual(["ExternalLink.tsx"]);
  });
});

describe("design tokens in components", () => {
  it("heatColor returns token variables only, no colour literals", () => {
    for (const v of [-5, -0.1, 0, 3, 5, 99]) {
      const c = heatColor(v, 5) ?? "";
      expect(c).not.toMatch(/#|\brgb\(|\bhsl\(/);
      expect(c).toMatch(/var\(--(up|down)\).*var\(--surface-2\)/);
    }
  });
});

describe("reduced motion (docs/06a section 3.3)", () => {
  const ds: ChartDataset = {
    xName: "Date",
    x: ["a", "b", "c"],
    series: [{ id: "s", name: "S", unit: "INR", kind: "line", values: [1, 2, 3] }],
    source: "t",
    asOf: "2025-01-01",
  };
  it("chart animation is on by default and off under reduced motion", () => {
    expect(buildOption(ds, { theme: "dark" })["animation"]).toBe(true);
    expect(buildOption(ds, { theme: "dark", reducedMotion: true })["animation"]).toBe(false);
  });

  it("CSS disables animation and transition durations under prefers-reduced-motion", () => {
    const css = readFileSync(join(webRoot, "src/app/globals.css"), "utf8");
    const block =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/scroll-behavior:\s*auto !important/);
  });
});
