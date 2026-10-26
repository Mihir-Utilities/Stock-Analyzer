import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import type { MockReply } from "../mocks/imports-fixtures";
import * as fx from "../mocks/stock-fixtures";

const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");

async function signIn(page: Page) {
  await page
    .context()
    .addCookies([{ name: "session", value: "e2e-placeholder", domain: "127.0.0.1", path: "/" }]);
}

function reply(route: Route, r: MockReply) {
  return route.fulfill({
    status: r.status,
    contentType: "application/json",
    body: JSON.stringify(r.body),
  });
}

/** The API is not running in e2e; every /api/v1 call is answered from the contract fixtures. */
async function mockApi(page: Page, drop = false) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    const routes: Record<string, MockReply> = {
      "GET /stocks/TCS": fx.profile(
        fx.withFreshness({ prices_stale: true, holidays_missing: true }),
      ),
      "GET /stocks/TCS/prices": fx.prices(
        { drops: drop ? { 40: 0.75 } : {} },
        drop
          ? [
              {
                code: "UNCONFIRMED_ACTION",
                message: `Possible split on ${fx.bars(70)[20]![0]} not yet confirmed`,
              },
            ]
          : [],
      ),
      "GET /stocks/TCS/indicators": fx.indicatorsFull(),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /watchlist": fx.emptyWatchlist,
    };
    return reply(
      route,
      routes[key] ?? {
        status: 501,
        body: { error: { code: "NOT_IMPLEMENTED", message: key } },
      },
    );
  });
}

test("stock page renders header, notices and Overview (BRK-12, SYS-14, UI-09)", async ({
  page,
}) => {
  await signIn(page);
  await mockApi(page, true);
  await page.goto("/stocks/TCS");
  await expect(page.getByTestId("stock-symbol")).toHaveText("TCS");
  await expect(page.getByTestId("header-refresh")).toHaveCount(0);
  await expect(page.getByTestId("import-chip")).toContainText("Last price import: 9 Oct 2026");
  await expect(page.getByTestId("import-chip")).toContainText("stale");
  await expect(page.getByTestId("holidays-missing-chip")).toBeVisible();
  await expect(page.getByTestId("soft-flag-dismiss")).toBeDisabled();
  await expect(page.getByTestId("card-events")).toContainText("Q2 results");
  await expect(page.getByTestId("kpi-grid")).toContainText("not computed yet");
  await page.getByTestId("tab-chart").click();
  await expect(page).toHaveURL(/tab=chart/);
});

test.describe("axe and touch targets on the stock page", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page, true);
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/stocks/TCS");
        await setTheme(page, theme);
        await page.getByTestId("card-events").waitFor();
        await page.getByTestId("chart-performance").waitFor();
        await page.addScriptTag({ content: axeSource });
        const violations = await page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const axe = (window as any).axe;
          const r = await axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          });
          return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 3),
          }));
        });
        expect(violations).toEqual([]);
        if (width === 375) {
          // UI-40: every interactive element of the stock page (not only those with a test id),
          // including the unconfirmed-action and soft-flag controls, is at least 44 px.
          const small = await page.evaluate(() =>
            Array.from(
              document.querySelectorAll(
                '[data-testid="stock-page"] :is(a[href], button, input, select, textarea, summary, [role="tab"], [role="button"], [tabindex]:not([tabindex="-1"]))',
              ),
            )
              .map((el) => ({
                id: el.getAttribute("data-testid") ?? el.tagName.toLowerCase(),
                r: el.getBoundingClientRect(),
              }))
              .filter(
                (x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5),
              )
              .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
          );
          expect(await page.getByTestId("action-confirm").count()).toBe(1);
          expect(await page.getByTestId("soft-flag-dismiss").count()).toBe(1);
          expect(small).toEqual([]);
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
        }
      });
    }
  }
});
