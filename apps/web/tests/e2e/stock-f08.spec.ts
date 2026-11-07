import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import type { MockReply } from "../mocks/imports-fixtures";
import * as f8 from "../mocks/f08-fixtures";
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

/** Stateful mock: after a PATCH the candidate is no longer detected (ACT-03, ACT-04). */
async function mockApi(page: Page, state: { decided: boolean; patches: unknown[] }) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    if (key === "PATCH /stocks/TCS/actions/9") {
      state.decided = true;
      state.patches.push(JSON.parse(req.postData() ?? "{}"));
      return reply(route, f8.patchConfirmed());
    }
    const events = state.decided ? fx.events : f8.eventsDetected;
    const routes: Record<string, MockReply> = {
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/prices": fx.prices(),
      "GET /stocks/TCS/indicators": fx.indicatorsFull(),
      "GET /stocks/TCS/events": events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /stocks/TCS/shareholding": f8.shareholdingNoMf,
      "GET /settings/prices-adjustment": f8.adjustment(false),
      "GET /watchlist": fx.emptyWatchlist,
    };
    return reply(
      route,
      routes[key] ?? { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: key } } },
    );
  });
}

test("ACT-03 end to end: detected split is confirmed with both ratios and leaves the list", async ({
  page,
}) => {
  const state = { decided: false, patches: [] as unknown[] };
  await signIn(page);
  await mockApi(page, state);
  await page.goto("/stocks/TCS?tab=events");
  await expect(page.getByTestId("detected-action")).toBeVisible();
  await page.getByTestId("confirm-type").selectOption("split");
  await page.getByTestId("confirm-ratio-num").fill("10");
  await page.getByTestId("confirm-ratio-den").fill("2");
  await expect(page.getByTestId("confirm-preview")).toContainText("5.0000");
  await page.getByTestId("action-confirm").click();
  await page.getByTestId("confirm-ok").first().click();
  await expect(page.getByTestId("decision-result")).toContainText("multiplier 5.0000");
  await expect(page.getByTestId("detected-action")).toHaveCount(0);
  expect(state.patches).toEqual([
    { status: "confirmed", action_type: "split", ratio_num: "10", ratio_den: "2" },
  ]);
});

test("other tabs render their honest states (SHP-01, peers, data)", async ({ page }) => {
  await signIn(page);
  await mockApi(page, { decided: false, patches: [] });
  await page.goto("/stocks/TCS?tab=ownership");
  await expect(page.getByTestId("mf-missing-note")).toContainText("DII (includes mutual funds)");
  await page.getByTestId("tab-peers").click();
  await expect(page.getByTestId("peers-unavailable")).toContainText("not available yet");
  await page.getByTestId("tab-data").click();
  await expect(page.getByTestId("adjustment-state")).toContainText("treated as raw");
  await expect(page.getByTestId("delete-prices")).toBeVisible();
});

test.describe("axe and touch targets on the F08 tabs", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page, { decided: false, patches: [] });
        await page.setViewportSize({ width, height: 900 });
        const waits: Record<string, string> = {
          ownership: "chart-ownership-stack",
          peers: "peers-unavailable",
          events: "detected-action",
          data: "data-coverage",
        };
        for (const [tab, ready] of Object.entries(waits)) {
          await page.goto(`/stocks/TCS?tab=${tab}`);
          await setTheme(page, theme);
          await page.getByTestId(ready).waitFor();
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
          expect(violations, `${tab} axe`).toEqual([]);
          if (width === 375) {
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
            expect(small, `${tab} touch targets`).toEqual([]);
          }
        }
      });
    }
  }
});
