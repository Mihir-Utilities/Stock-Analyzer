import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
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

const item = (id: number, symbol: string) => ({
  id,
  symbol,
  name: `${symbol} Limited`,
  isin: null,
  series: "EQ",
  sector: "Energy",
  industry: null,
  company_type: null,
  status: "active",
  instrument_kind: "equity",
  tracked: id % 2 === 0,
});

/** The API is not running in e2e; /stocks is answered from fixtures, anything else is a 501. */
async function mockApi(page: Page, paths: string[]) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname.replace("/api/v1", "")}`;
    paths.push(key);
    if (key === "GET /stocks") {
      const more = url.searchParams.has("cursor");
      return reply(route, {
        status: 200,
        body: {
          data: {
            items: more ? [item(3, "M&M")] : [item(1, "RELIANCE"), item(2, "TCS")],
            next_cursor: more ? null : "c1",
          },
          meta: {},
          warnings: [],
        },
      });
    }
    return reply(route, {
      status: 501,
      body: { error: { code: "NOT_IMPLEMENTED", message: key } },
    });
  });
}

test("every nav entry opens a real page (UI-94)", async ({ page }) => {
  await signIn(page);
  await mockApi(page, []);
  for (const [path, title] of [
    ["/stocks", "Stocks"],
    ["/compare", "Compare stocks"],
    ["/screener", "Screener"],
    ["/admin/status", "Admin status"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByTestId("not-found-title")).toHaveCount(0);
  }
});

test("browse pages, links with an encoded symbol, and the unbuilt pages call no API (UI-95)", async ({
  page,
}) => {
  const calls: string[] = [];
  await signIn(page);
  await mockApi(page, calls);
  await page.goto("/stocks");
  await expect(page.getByTestId("stocks-row-TCS")).toBeVisible();
  await page.getByTestId("stocks-more").click();
  await expect(page.getByTestId("stocks-link-M&M")).toHaveAttribute("href", "/stocks/M%26M");
  await expect(page.getByTestId("stocks-more")).toHaveCount(0);
  for (const path of ["/admin/status"]) {
    calls.length = 0;
    await page.goto(path);
    await expect(page.getByTestId("app-footer")).toBeVisible();
    // The shell's search palette preloads the live stock index; the page itself calls nothing.
    expect(calls.filter((c) => !c.startsWith("GET /auth") && c !== "GET /stocks/index")).toEqual(
      [],
    );
  }
});

test.describe("axe, touch targets and overflow on the new screens (UI-97)", () => {
  test.use({ bypassCSP: true });
  for (const path of ["/stocks", "/compare", "/screener", "/admin/status"]) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`${path} ${theme} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page, []);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(path);
          await setTheme(page, theme);
          if (path === "/stocks") await page.getByTestId("stocks-list").waitFor();
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
