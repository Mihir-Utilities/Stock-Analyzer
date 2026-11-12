import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import * as ix from "../mocks/inv-fixtures";
import type { MockReply } from "../mocks/imports-fixtures";
import { ok } from "../mocks/imports-fixtures";
import * as fx from "../mocks/stock-fixtures";
import { swingDips } from "../mocks/swing-fixtures";

// F19 (SWD-E01, SWD-E02): the Swing dips card on the Analysis tab in a real browser: axe in both
// themes at 375 and 1440 px, no horizontal page scroll, 44 px targets, keyboard.

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

async function mockApi(page: Page) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const routes: Record<string, MockReply> = {
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/prices": fx.prices({ n: 70 }),
      "GET /stocks/TCS/indicators": ix.indicatorsWithInv((a) => ({
        ...a,
        swing_dips: swingDips(),
      })),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /watchlist": ok({ stocks: [], funds: [] }),
      "GET /alerts/events": ok({ items: [], next_cursor: null }),
      "GET /broker/status": ok({ enabled: false, mode: "manual" }),
    };
    const key = `${req.method()} ${path}`;
    return reply(
      route,
      routes[key] ??
        (path.endsWith("/events")
          ? ok({ calendar: [] })
          : { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: key } } }),
    );
  });
}

async function axeViolations(page: Page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
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
}

async function smallTargets(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "button[data-testid], a[data-testid], input[data-testid], select[data-testid]",
      ),
    )
      .filter((el) => el.getAttribute("data-testid") !== "skip-link")
      .map((el) => ({ id: el.getAttribute("data-testid"), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5))
      .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
  );
}

async function noPageScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test.describe("Analysis tab: Swing dips card", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`SWD-E01 axe, targets and no page scroll: ${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/stocks/TCS?tab=analysis");
        await setTheme(page, theme);
        await expect(page.getByTestId("inv-swing")).toHaveAttribute("data-state", "ready");
        await expect(page.getByTestId("inv-drawdown")).toHaveAttribute("data-state", "ready");
        await expect(page.getByTestId("inv-swing-open")).toBeVisible();
        for (const c of await page.getByTestId("chart-canvas").all()) {
          await expect(c).toHaveAttribute("data-ready", "true");
        }
        await setTheme(page, theme);
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) {
          expect(await smallTargets(page)).toEqual([]);
          await noPageScroll(page);
        }
      });
    }
  }

  test("SWD-E02 tables scroll inside labelled focusable regions at 375 px, not the page", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/stocks/TCS?tab=analysis");
    await expect(page.getByTestId("inv-swing")).toHaveAttribute("data-state", "ready");
    const region = page.getByRole("region", { name: "Swing dips by size of fall, scrollable" });
    await expect(region).toHaveAttribute("tabindex", "0");
    expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(page.getByRole("region", { name: "Last swing dips, scrollable" })).toHaveAttribute(
      "tabindex",
      "0",
    );
    await noPageScroll(page);
  });

  test("SWD-E02 keyboard: the 10% / 20% select and the How to read disclosure", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stocks/TCS?tab=analysis");
    await expect(page.getByTestId("inv-swing")).toHaveAttribute("data-state", "ready");
    const pick = page.getByTestId("inv-swing-pick-select");
    await expect(page.getByTestId("inv-swing-record")).toHaveCount(3);
    await pick.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("inv-swing-records-empty")).toContainText("No dip of 20%");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("inv-swing-record")).toHaveCount(3);
    const howto = page.getByTestId("inv-swing-howto");
    await howto.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(howto).toHaveAttribute("open", "");
  });
});
