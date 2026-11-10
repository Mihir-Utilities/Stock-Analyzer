import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import * as fx from "../mocks/f10-fixtures";
import type { MockReply } from "../mocks/imports-fixtures";

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

interface State {
  queryBodies: unknown[];
  compareNoCommon: boolean;
}

/** The API is not running in e2e; the B13 routes are answered from the contract fixtures. */
async function mockApi(page: Page, state: State) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname.replace("/api/v1", "")}`;
    if (key === "GET /screener/saved") return reply(route, fx.saved(["High ROE"]));
    if (key === "POST /screener/query") {
      const body = req.postDataJSON() as { cursor: string | null };
      state.queryBodies.push(body);
      return reply(
        route,
        body.cursor === null
          ? fx.screener(
              [
                fx.item("TCS", {
                  values: { roe: 45.1, pe: null, market_cap_cr: 1250000, quality_score: 80 },
                  value_reasons: { pe: "not_available" },
                }),
                fx.item("M&M", {
                  stale: true,
                  stale_reason: "fundamentals_older_than_120_days",
                  last_updated: "2026-05-01",
                }),
              ],
              { next: "c1", total: 3, excluded: { roe: 41 } },
            )
          : fx.screener([fx.item("INFY")], { total: 3 }),
      );
    }
    if (key === "GET /compare")
      return reply(
        route,
        fx.compare({ noCommon: state.compareNoCommon, shortB: true, staleB: true }),
      );
    return reply(route, {
      status: 501,
      body: { error: { code: "NOT_IMPLEMENTED", message: key } },
    });
  });
}

async function axeViolations(page: Page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const r = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag412"] },
    });
    return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 3),
    }));
  });
}

test("screener: build, run, stale rows, exclusions, load more, keyboard only (SCR, UI-98)", async ({
  page,
}) => {
  const state: State = { queryBodies: [], compareNoCommon: false };
  await signIn(page);
  await mockApi(page, state);
  await page.goto("/screener");
  await expect(page.getByRole("heading", { level: 1, name: "Screener" })).toBeVisible();
  await expect(page.getByTestId("screener-owner-data-notice")).toContainText("owner-entered data");

  await page.getByTestId("screener-add-filter").click();
  await page.getByLabel(/^Filter 1 value/).fill("15");
  await page.getByTestId("screener-run").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("screener-table")).toBeVisible();
  await expect(page.getByTestId("screener-results-heading")).toBeFocused();
  await expect(page.getByTestId("screener-status")).toContainText("Showing 2 of 3 stocks");
  await expect(page.getByTestId("screener-excluded")).toContainText("ROE 41");
  await expect(page.getByTestId("screener-row-M&M")).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("screener-stamp-M&M")).toContainText("Stale:");
  await expect(page.getByTestId("screener-cell-TCS-pe")).toContainText("not available");
  await page.getByTestId("screener-more").click();
  await expect(page.getByTestId("screener-row-INFY")).toBeVisible();
  expect(state.queryBodies).toHaveLength(2);
  expect((state.queryBodies[1] as { cursor: string }).cursor).toBe("c1");
});

test("compare: chart, best marks, short history and the no-common-dates state (CMP, UI-98)", async ({
  page,
}) => {
  const state: State = { queryBodies: [], compareNoCommon: false };
  await signIn(page);
  await mockApi(page, state);
  await page.goto("/compare?symbols=TCS%2CM%26M&range=1Y");
  await expect(page.getByTestId("compare-chart")).toBeVisible();
  await expect(page.getByTestId("compare-short-M&M")).toContainText("Short history");
  await expect(page.getByTestId("compare-cell-M&M-pe")).toContainText("Best");
  state.compareNoCommon = true;
  await page.goto("/compare?symbols=TCS%2CM%26M&range=3Y");
  await expect(page.getByTestId("compare-no-common-dates")).toBeVisible();
  await expect(page.getByTestId("compare-chart")).toHaveCount(0);
});

test.describe("axe, touch targets and overflow on screener and compare (UI-98)", () => {
  test.use({ bypassCSP: true });
  for (const path of ["/screener", "/compare?symbols=TCS%2CM%26M&range=1Y"]) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`${path} ${theme} at ${width}`, async ({ page }) => {
          const state: State = { queryBodies: [], compareNoCommon: false };
          await signIn(page);
          await mockApi(page, state);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(path);
          if (path === "/screener") {
            await page.getByTestId("screener-add-filter").click();
            await page.getByLabel(/^Filter 1 value/).fill("15");
            await page.getByTestId("screener-run").click();
            await page.getByTestId("screener-table").waitFor();
          } else {
            await page.getByTestId("compare-table").waitFor();
          }
          await setTheme(page, theme);
          expect(await axeViolations(page)).toEqual([]);
          if (width === 375) {
            const small = await page.evaluate(() =>
              Array.from(
                document.querySelectorAll(
                  "button[data-testid], a[data-testid], select[data-testid], input[type=checkbox][data-testid]",
                ),
              )
                .filter((el) => el.getAttribute("data-testid") !== "skip-link")
                .map((el) => {
                  const t = el.closest("label") ?? el;
                  return { id: el.getAttribute("data-testid"), r: t.getBoundingClientRect() };
                })
                .filter(
                  (x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5),
                )
                .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
            );
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
  }
});
