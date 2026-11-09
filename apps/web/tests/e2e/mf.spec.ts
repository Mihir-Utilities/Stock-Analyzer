import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import type { MockReply } from "../mocks/imports-fixtures";
import * as fx from "../mocks/mf-fixtures";

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
async function mockApi(page: Page) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    const routes: Record<string, MockReply> = {
      "GET /mf/schemes": fx.searchPage([
        fx.item(120503),
        fx.item(118989, { name: "Beta Large Cap Fund", plan: "regular", status: "inactive" }),
        fx.item(100001, { latest_nav: null, return_1y_pct: null, last_nav_date: null }),
      ]),
      "GET /mf/categories": fx.categories,
      "GET /mf/schemes/120503": fx.envelope(fx.detail()),
      "GET /mf/schemes/120503/nav": fx.nav(),
      "GET /mf/schemes/120503/sip": fx.envelope(fx.sip()),
      "GET /mf/schemes/999999": {
        status: 404,
        body: {
          error: {
            code: "NOT_FOUND",
            message: "Scheme not found",
            details: { suggestions: [{ code: 120503, name: "Alpha Flexi Cap Fund" }] },
          },
        },
      },
      "GET /mf/compare": fx.compare(),
      "GET /watchlist": fx.emptyWatchFunds,
    };
    return reply(
      route,
      routes[key] ?? { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: key } } },
    );
  });
}

const ATTR = "NAV data: AMFI, via mfapi.in";

test("MF screens carry the attribution and footer (SAF-03)", async ({ page }) => {
  await signIn(page);
  await mockApi(page);
  for (const path of ["/mf", "/mf/120503", "/mf/compare?codes=120503,118989", "/mf/999999"]) {
    await page.goto(path);
    await expect(page.getByTestId("mf-attribution")).toHaveText(ATTR);
    await expect(page.getByTestId("app-footer")).toBeVisible();
  }
});

test("search, detail, SIP and compare work end to end (MF-05, MF-11, MF-13)", async ({ page }) => {
  await signIn(page);
  await mockApi(page);
  await page.goto("/mf");
  await expect(page.getByTestId("mf-row-120503")).toContainText("INR per unit, 23 Oct 2026");
  await expect(page.getByTestId("mf-row-100001")).toContainText("no NAV stored yet");
  await page.getByTestId("mf-compare-120503").check();
  await page.getByTestId("mf-compare-118989").check();
  await page.getByTestId("mf-compare-go").click();
  await expect(page).toHaveURL(/\/mf\/compare\?codes=120503,118989/);
  await expect(page.getByTestId("mf-compare-different-starts")).toBeVisible();
  await expect(page.getByTestId("mf-compare-chart")).toBeVisible();

  await page.goto("/mf/120503");
  await expect(page.getByTestId("mf-name")).toContainText("Alpha Flexi Cap Fund");
  await expect(page.getByTestId("mf-nav-chart")).toBeVisible();
  await expect(page.getByTestId("mf-return-r_5y")).toContainText("history is shorter");
  await expect(page.getByTestId("mf-lumpsum-unavailable")).toContainText("Not available yet");
  // MF-11: day 31 is refused in the form.
  await page.getByTestId("sip-day").fill("31");
  await page.getByTestId("sip-start").fill("2026-01-01");
  await page.getByTestId("sip-submit").click();
  await expect(page.getByTestId("form-field-error")).toContainText("1 to 28");
  await page.getByTestId("sip-day").fill("1");
  await page.getByTestId("sip-submit").click();
  await expect(page.getByTestId("sip-result-card")).toContainText("₹16,000.00");
  await expect(page.getByTestId("mf-sip-chart")).toBeVisible();
  // Show data exists for every chart (UI-10).
  await page.getByTestId("mf-sip-chart").getByTestId("chart-show-data").click();
  await expect(page.getByTestId("mf-sip-chart").getByTestId("chart-data-table")).toBeVisible();

  // MF-13: wrong code gives suggestions.
  await page.goto("/mf/999999");
  await expect(page.getByTestId("mf-suggestion-120503")).toBeVisible();
});

test.describe("axe and touch targets on the fund screens (UI-26, label-content-name-mismatch)", () => {
  test.use({ bypassCSP: true });
  const paths = ["/mf", "/mf/120503", "/mf/compare?codes=120503,118989", "/mf/999999"];
  for (const path of paths) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`${path} ${theme} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(path);
          await setTheme(page, theme);
          if (path === "/mf") await page.getByTestId("mf-results").waitFor();
          if (path === "/mf/120503") {
            await page.getByTestId("mf-nav-chart").waitFor();
            await page.getByTestId("sip-start").fill("2026-01-01");
            await page.getByTestId("sip-submit").click();
            await page.getByTestId("mf-sip-chart").waitFor();
          }
          if (path.startsWith("/mf/compare")) await page.getByTestId("mf-compare-chart").waitFor();
          if (path === "/mf/999999") await page.getByTestId("mf-suggestion-120503").waitFor();
          await page.addScriptTag({ content: axeSource });
          const violations = await page.evaluate(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const axe = (window as any).axe;
            const r = await axe.run(document, {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag412"],
              },
            });
            return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => ({
              id: v.id,
              nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 3),
            }));
          });
          expect(violations).toEqual([]);
          if (width === 375) {
            const small = await page.evaluate(() =>
              Array.from(document.querySelectorAll("button[data-testid], a[data-testid]"))
                .filter((el) => el.getAttribute("data-testid") !== "skip-link")
                .map((el) => ({
                  id: el.getAttribute("data-testid"),
                  r: el.getBoundingClientRect(),
                }))
                .filter(
                  (x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5),
                )
                .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
            );
            expect(small).toEqual([]);
            const labels = await page.evaluate(() =>
              Array.from(document.querySelectorAll("label"))
                .filter((el) => el.querySelector("input[type=checkbox]"))
                .map((el) => ({ t: el.textContent, r: el.getBoundingClientRect() }))
                .filter((x) => x.r.height < 43.5)
                .map((x) => x.t),
            );
            expect(labels).toEqual([]);
            const { scrollWidth, clientWidth } = await page.evaluate(() => ({
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
            }));
            expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
          }
        });
      }
    }
  }
});
