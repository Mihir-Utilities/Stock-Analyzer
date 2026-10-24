import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, over } from "@/lib/theme/contrast";
import { echartsTheme } from "@/lib/theme/echarts-theme";
import { themeStylesheet } from "@/lib/theme/theme-css";
import { resolveInitialTheme } from "@/lib/theme/use-theme";
import {
  categoricalPalette,
  colorTokens,
  type ColorToken,
  type ThemeName,
} from "@/lib/theme/tokens";

const webRoot = process.cwd();
const designDoc = readFileSync(join(webRoot, "../../docs/06a-design-system.md"), "utf8");
const themes: ThemeName[] = ["dark", "light"];
const names = Object.keys(colorTokens) as ColorToken[];

function docColorTable(): Record<string, { dark: string; light: string }> {
  const out: Record<string, { dark: string; light: string }> = {};
  for (const line of designDoc.split("\n")) {
    const m = /^\| `--([a-z0-9-]+)` \| (#[0-9A-Fa-f]{6,8}) \| (#[0-9A-Fa-f]{6,8}) \|/.exec(line);
    if (m?.[1] && m[2] && m[3]) out[m[1]] = { dark: m[2], light: m[3] };
  }
  return out;
}

describe("UI-11 tokens match docs/06a section 3.1 exactly", () => {
  const table = docColorTable();

  it("has every documented colour token and no extras", () => {
    expect(Object.keys(table).sort()).toEqual([...names].sort());
  });

  it.each(names)("%s hex values (dark and light)", (name) => {
    expect(colorTokens[name].dark.toUpperCase()).toBe(table[name]?.dark.toUpperCase());
    expect(colorTokens[name].light.toUpperCase()).toBe(table[name]?.light.toUpperCase());
  });

  it("categorical palette is the documented 8 colours", () => {
    const line = designDoc.split("\n").find((l) => l.startsWith("Chart categorical palette")) ?? "";
    const hex = [...line.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0].toUpperCase());
    expect(hex.slice(0, 8)).toEqual(categoricalPalette.map((c) => c.toUpperCase()));
  });
});

describe("UI-11 CSS variables are generated from the tokens", () => {
  const css = themeStylesheet();
  it("defines every token for both themes", () => {
    for (const name of names) {
      expect(css).toContain(`--${name}: ${colorTokens[name].dark};`);
      expect(css).toContain(`--${name}: ${colorTokens[name].light};`);
    }
    expect(css).toContain(':root[data-theme="light"]');
  });
});

// UI-04: dark/light parity and contrast. Text >= 4.5:1, graphics >= 3:1 (docs/06a section 3.1).
describe("contrast (UI-04)", () => {
  const surfaces: ColorToken[] = ["bg", "surface-1", "surface-2", "surface-3"];
  const semantic: ColorToken[] = ["accent", "up", "down", "warn", "info", "exp"];

  // The spec's hex values (docs/06a section 3.1) are implemented exactly. Some semantic colours
  // fall short of 4.5:1 as text on some surfaces; those pairs are listed here and recorded as
  // OQ-16 in docs/OPEN_QUESTIONS.md. The shell uses none of them for text. This test fails if the
  // set of failing pairs changes in either direction, so a spec fix or a regression is noticed.
  const KNOWN_TEXT_DEVIATIONS = [
    "dark: down on surface-3",
    "light: accent on accent-weak over surface-1",
    "light: accent on bg",
    "light: accent on surface-2",
    "light: accent on surface-3",
    "light: down on surface-3",
    "light: info on surface-2",
    "light: info on surface-3",
    "light: up on surface-2",
    "light: up on surface-3",
    "light: warn on bg",
    "light: warn on surface-1",
    "light: warn on surface-2",
    "light: warn on surface-3",
  ];
  const KNOWN_GRAPHIC_DEVIATIONS = [
    "light: #5BC0DE on surface-1",
    "light: #9AA5B1 on surface-1",
    "light: #B07CFF on surface-1",
    "light: #E86AA6 on surface-1",
    "light: #F5A524 on surface-1",
    "light: #2BB673 on surface-1",
  ];

  for (const theme of themes) {
    describe(theme, () => {
      const c = (n: ColorToken) => colorTokens[n][theme];

      it.each(
        (["text-1", "text-2"] as ColorToken[]).flatMap((t) => surfaces.map((s) => [t, s] as const)),
      )("primary/secondary text %s on %s >= 4.5:1", (fg, bg) => {
        expect(contrastRatio(c(fg), c(bg))).toBeGreaterThanOrEqual(4.5);
      });

      it("hairline border is visible as a graphic on the page background (decorative)", () => {
        expect(contrastRatio(c("border"), c("bg"))).toBeGreaterThan(1.1);
      });
    });
  }

  it("UI-12 semantic text pairs below 4.5:1 are exactly the documented deviations (OQ-16)", () => {
    const failing: string[] = [];
    for (const theme of themes) {
      for (const fg of semantic) {
        for (const bg of surfaces) {
          if (contrastRatio(colorTokens[fg][theme], colorTokens[bg][theme]) < 4.5) {
            failing.push(`${theme}: ${fg} on ${bg}`);
          }
        }
      }
      const sel = over(colorTokens["accent-weak"][theme], colorTokens["surface-1"][theme]);
      if (contrastRatio(colorTokens.accent[theme], sel) < 4.5) {
        failing.push(`${theme}: accent on accent-weak over surface-1`);
      }
    }
    expect(failing.sort()).toEqual([...KNOWN_TEXT_DEVIATIONS].sort());
  });

  it("UI-12 categorical chart colours below 3:1 on the card surface are exactly the documented ones (OQ-16)", () => {
    const failing: string[] = [];
    for (const theme of themes) {
      for (const colour of categoricalPalette) {
        if (contrastRatio(colour, colorTokens["surface-1"][theme]) < 3) {
          failing.push(`${theme}: ${colour} on surface-1`);
        }
      }
    }
    expect(failing.sort()).toEqual([...KNOWN_GRAPHIC_DEVIATIONS].sort());
  });

  it("text-3 (tertiary/disabled) is only used for non-essential text", () => {
    // Disabled text is exempt from WCAG 1.4.3; the value is recorded so a change is deliberate.
    for (const theme of themes) {
      const ratio = contrastRatio(colorTokens["text-3"][theme], colorTokens["surface-1"][theme]);
      expect(ratio).toBeGreaterThan(2.5);
    }
  });

  it("dark and light define the same set of tokens (parity)", () => {
    for (const name of names) {
      expect(colorTokens[name].dark).toBeTruthy();
      expect(colorTokens[name].light).toBeTruthy();
    }
  });
});

describe("UI-11 ECharts theme from tokens", () => {
  it.each(themes)("%s theme only uses token colours", (theme) => {
    const t = echartsTheme(theme);
    expect(t.textStyle.color).toBe(colorTokens["text-2"][theme]);
    expect(t.categoryAxis.axisLine.lineStyle.color).toBe(colorTokens.border[theme]);
    expect(t.color).toEqual([...categoricalPalette]);
    expect(t.candlestick.itemStyle.color).toBe(colorTokens.up[theme]);
    expect(t.candlestick.itemStyle.color0).toBe(colorTokens.down[theme]);
    expect(t.diverging[0]).toBe(colorTokens.down[theme]);
    expect(t.diverging[2]).toBe(colorTokens.up[theme]);
  });
});

describe("theme choice", () => {
  it("honours a stored choice, else the system preference", () => {
    expect(resolveInitialTheme("light", true)).toBe("light");
    expect(resolveInitialTheme("dark", false)).toBe("dark");
    expect(resolveInitialTheme(null, true)).toBe("dark");
    expect(resolveInitialTheme(null, false)).toBe("light");
    expect(resolveInitialTheme("purple", false)).toBe("light");
  });

  it("public/theme-init.js uses the same storage key", () => {
    const js = readFileSync(join(webRoot, "public/theme-init.js"), "utf8");
    expect(js).toContain('"analyzer-theme"');
  });
});

describe("tokens only (CLAUDE.md section 3)", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  const src = join(webRoot, "src");
  const files = walk(src).filter((f) => /\.(tsx?|css)$/.test(f));

  it("UI-11 has no hex colour literal outside lib/theme/tokens.ts", () => {
    const offenders = files.filter(
      (f) =>
        !/lib[\\/]theme[\\/]tokens\.ts$/.test(f) &&
        /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("UI-14 makes no reference to an external http(s) host in source (no external requests)", () => {
    const offenders = files.filter((f) =>
      /https?:\/\/(?!app\.invalid)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
