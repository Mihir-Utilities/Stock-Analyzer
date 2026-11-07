import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { setTheme } from "./theme";
import * as fnd from "../mocks/fundamentals-fixtures";
import type { MockReply } from "../mocks/imports-fixtures";
import { ok } from "../mocks/imports-fixtures";
import * as fx from "../mocks/stock-fixtures";
import * as cx from "../mocks/chart-fixtures";

const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");

async function mockApi(page: Page, fundamentals: MockReply) {
  await page
    .context()
    .addCookies([{ name: "session", value: "e2e-placeholder", domain: "127.0.0.1", path: "/" }]);
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    const routes: Record<string, MockReply> = {
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/prices": fx.prices(),
      "GET /stocks/TCS/indicators": cx.indicatorsWithSeries(70),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fundamentals,
      "POST /stocks/TCS/results": ok(
        { batch_id: 3, inserted: 1, updated: 0, warnings: [], post_import_job_id: null },
        201,
      ),
      "GET /watchlist": fx.emptyWatchlist,
    };
    const r = routes[key] ?? {
      status: 501,
      body: { error: { code: "NOT_IMPLEMENTED", message: key } },
    };
    return route.fulfill({
      status: r.status,
      contentType: "application/json",
      body: JSON.stringify(r.body),
    });
  });
}

async function axeViolations(page: Page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const r = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
      rules: { "label-content-name-mismatch": { enabled: true } },
    });
    return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 3),
    }));
  });
}

async function smallTargets(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("button[data-testid], a[data-testid], input[data-testid]"))
      .filter((el) => el.getAttribute("data-testid") !== "skip-link")
      .map((el) => ({ id: el.getAttribute("data-testid"), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5))
      .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
  );
}

test("Fundamentals tab: table, groups, charts and the manual form in a real browser (FND-11/12 UI)", async ({
  page,
}) => {
  await mockApi(page, fnd.fundamentals());
  await page.goto("/stocks/TCS?tab=fundamentals");
  await expect(page.getByTestId("fnd-table")).toBeVisible();
  await expect(page.getByTestId("fnd-cell-pnl.revenue-2026-09-30")).toContainText("1,300.00");
  await expect(page.getByTestId("fnd-waterfall")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("fnd-row-chart").getByTestId("chart-canvas")).toHaveAttribute(
    "data-ready",
    "true",
  );
  for (const g of ["bs", "cf", "ratios", "valuation"]) {
    await page.getByTestId(`fnd-group-${g}`).click();
    await expect(page.getByTestId(`fnd-group-${g}`)).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByTestId("fnd-group-pnl").click();
  await page.getByTestId("fnd-edit-2026-06-30").click();
  await expect(page.getByTestId("results-period-end")).toHaveValue("2026-06-30");
  await expect(page.getByTestId("fnd-form-panel")).toBeFocused();
});

test("Fundamentals empty state offers the CTA", async ({ page }) => {
  await mockApi(page, fnd.noData);
  await page.goto("/stocks/TCS?tab=fundamentals");
  await expect(page.getByTestId("fnd-empty")).toContainText("no data entered");
  await page.getByTestId("fnd-add-results").click();
  await expect(page.getByTestId("results-symbol")).toHaveValue("TCS");
});

test.describe("axe and touch targets on the Fundamentals tab", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`fundamentals ${theme} at ${width}`, async ({ page }) => {
        await mockApi(
          page,
          fnd.fundamentals({}, [{ code: "BASIS_NOT_MIXED", message: "1 period is hidden." }]),
        );
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/stocks/TCS?tab=fundamentals");
        await setTheme(page, theme);
        await expect(page.getByTestId("fnd-waterfall")).toHaveAttribute("data-state", "ready");
        await page.getByTestId("fnd-add-results").click();
        await expect(page.getByTestId("results-form")).toBeVisible();
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) expect(await smallTargets(page)).toEqual([]);
      });
    }
  }
});
