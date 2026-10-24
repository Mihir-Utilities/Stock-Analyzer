import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { STORY_ORIGIN } from "./ports";

// Component checks against the static Storybook build (docs/06a section 10):
//  - axe (wcag2a/aa, 2.1, including colour contrast) on every F02 story in both themes
//  - ChartFrame behaviour in a real browser (SVG draw, PNG export, fullscreen, theme sync)
//  - screenshot baselines for key components in both themes (VISUAL=1; baselines are per OS)

const SB = STORY_ORIGIN;
const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");
const indexPath = join(process.cwd(), "storybook-static/index.json");

interface Entry {
  id: string;
  type: string;
  title: string;
}
const entries: Entry[] = existsSync(indexPath)
  ? Object.values(
      (JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Record<string, Entry> }).entries,
    )
  : [];
const stories = entries.filter(
  (e) => e.type === "story" && (e.title === "UI/Components" || e.title === "Charts/ChartFrame"),
);

const url = (id: string, theme: "dark" | "light") =>
  `${SB}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`;

async function ready(page: import("@playwright/test").Page) {
  await page.waitForSelector("#storybook-root > :not(style)");
  // Charts load echarts lazily; wait until every canvas host reports ready.
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[data-testid="chart-canvas"]')).every(
      (el) => el.getAttribute("data-ready") === "true",
    ),
  );
}

test.describe("stories exist", () => {
  test("Storybook build contains the F02 stories", () => {
    expect(stories.length).toBeGreaterThan(30);
  });
});

test.describe("UI-20 axe on every component story (both themes)", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const s of stories) {
      test(`${theme} ${s.id}`, async ({ page }) => {
        await page.goto(url(s.id, theme));
        await ready(page);
        await page.addScriptTag({ content: axeSource });
        const result = await page.evaluate(async () => {
          const axe = (
            window as unknown as {
              axe: {
                run: (
                  c: Document,
                  o: object,
                ) => Promise<{
                  violations: Array<{
                    id: string;
                    impact: string;
                    nodes: Array<{ target: string[]; failureSummary: string }>;
                  }>;
                }>;
              };
            }
          ).axe;
          return axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          });
        });
        const summary = result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => `${n.target.join(" ")} :: ${n.failureSummary}`).slice(0, 3),
        }));
        expect(summary).toEqual([]);
      });
    }
  }
});

test.describe("ChartFrame in a real browser", () => {
  test("UI-07 UI-10 draws in the real SVG renderer, shows the data table, exports CSV and PNG", async ({
    page,
  }) => {
    await page.goto(url("charts-chartframe--ready", "dark"));
    await ready(page);
    await expect(page.getByTestId("chart-canvas").locator("svg")).toHaveCount(1);

    const csv = page.waitForEvent("download");
    await page.getByTestId("chart-export-csv").click();
    expect((await csv).suggestedFilename()).toBe("chart.csv");

    const png = page.waitForEvent("download");
    await page.getByTestId("chart-export-png").click();
    const d = await png;
    expect(d.suggestedFilename()).toBe("chart.png");
    const path = await d.path();
    const head = readFileSync(path).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(page.getByTestId("chart-export-error")).toHaveCount(0);

    await page.getByTestId("chart-show-data").click();
    await expect(page.getByTestId("chart-data-table")).toBeVisible();
    expect(await page.getByTestId("chart-data-row").count()).toBe(120);
  });

  test("UI-19 legend toggle hides a series; theme change redraws with the new theme", async ({
    page,
  }) => {
    await page.goto(url("charts-chartframe--ready", "dark"));
    await ready(page);
    await page.getByTestId("legend-b").click();
    await expect(page.getByTestId("legend-b")).toHaveAttribute("aria-pressed", "false");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await expect(page.getByTestId("chart-frame")).toHaveAttribute("data-theme-name", "light");
    await ready(page);
    await expect(page.getByTestId("chart-canvas").locator("svg")).toHaveCount(1);
  });

  test("full screen toggles", async ({ page }) => {
    await page.goto(url("charts-chartframe--ready", "dark"));
    await ready(page);
    await page.getByTestId("chart-fullscreen").click();
    await expect(page.getByTestId("chart-fullscreen")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("chart-fullscreen").click();
    await expect(page.getByTestId("chart-fullscreen")).toHaveAttribute("aria-pressed", "false");
  });

  test("makes no requests to other origins", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol.startsWith("http")) {
        external.push(r.url());
      }
    });
    await page.goto(url("charts-chartframe--points-2000", "dark"));
    await ready(page);
    expect(external).toEqual([]);
  });
});

const visualIds = [
  "ui-components--card-states",
  "ui-components--stats",
  "ui-components--gauges",
  "ui-components--data-table-ready",
  "ui-components--heatmap",
  "charts-chartframe--ready",
  "charts-chartframe--bars-and-forecast",
];
test.describe("visual regression (set VISUAL=1; baselines are per OS)", () => {
  test.skip(!process.env["VISUAL"], "VISUAL=1 not set");
  test.use({ viewport: { width: 1000, height: 800 }, reducedMotion: "reduce" });
  for (const theme of ["dark", "light"] as const) {
    for (const id of visualIds) {
      test(`${theme} ${id}`, async ({ page }) => {
        await page.goto(url(id, theme));
        await ready(page);
        await expect(page).toHaveScreenshot(`${id}-${theme}.png`, { fullPage: true });
      });
    }
  }
});
