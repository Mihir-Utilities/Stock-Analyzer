import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import * as ix from "../mocks/inv-fixtures";
import type { MockReply } from "../mocks/imports-fixtures";
import { ok } from "../mocks/imports-fixtures";
import { relativeStrength } from "../mocks/rst-fixtures";
import * as fx from "../mocks/stock-fixtures";

// F22 (RST-E01, RST-E02): the Relative strength card in a real browser: axe in both themes at 375
// and 1440 px, no horizontal page scroll, 44 px targets, keyboard reachability of the reasons, the
// How to read disclosure, the chart's Show data and the import hint.

const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");
const BARS = 70; // the fixture's analysis arrays have 70 points

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

async function mockApi(page: Page, rs: Record<string, unknown> = relativeStrength(BARS)) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const routes: Record<string, MockReply> = {
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/prices": fx.prices({ n: BARS }),
      "GET /stocks/TCS/indicators": ix.indicatorsWithInv((a) => ({ ...a, relative_strength: rs })),
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
        "#main button[data-testid], #main a[data-testid], #main input[data-testid], #main select[data-testid]",
      ),
    )
      .filter((el) => el.closest('[data-testid="inv-rs"]'))
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

/** Presses Tab until the element has focus (a real keyboard path), up to `max` presses. */
async function tabTo(page: Page, testId: string, max = 120) {
  const target = page.getByTestId(testId);
  for (let i = 0; i < max; i++) {
    if (
      await target.evaluate(
        (el) => el === document.activeElement || el.contains(document.activeElement),
      )
    ) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`${testId} was not reached by Tab within ${max} presses`);
}

test.describe("Analysis tab: Relative strength card", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`axe, targets and no page scroll: ${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/stocks/TCS?tab=analysis");
        await setTheme(page, theme);
        await expect(page.getByTestId("inv-rs")).toHaveAttribute("data-state", /ready|partial/);
        await expect(page.getByTestId("inv-rs-peer-3m")).toBeVisible();
        await expect(page.getByTestId("inv-rs-chart")).toBeVisible();
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

  test("keyboard: the How to read disclosure, the chart's Show data and the tables", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stocks/TCS?tab=analysis");
    await expect(page.getByTestId("inv-rs-windows")).toBeVisible();
    await tabTo(page, "inv-rs-howto");
    const howto = page.getByTestId("inv-rs-howto");
    await howto.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(howto).toHaveAttribute("open", "");
    const chart = page.getByTestId("inv-rs-chart");
    await chart.getByTestId("chart-show-data").focus();
    await page.keyboard.press("Enter");
    await expect(chart.getByRole("table")).toBeVisible();
    // the reason a period is blank is plain text on the page, not hover only
    await expect(page.getByTestId("inv-rs-reasons")).toContainText("fewer dates in common");
  });

  test("tables scroll inside labelled focusable regions at 375 px, not the page", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/stocks/TCS?tab=analysis");
    await expect(page.getByTestId("inv-rs-windows")).toBeVisible();
    const region = page.getByRole("region", {
      name: "Return against the Nifty 50 by period, scrollable",
    });
    await expect(region).toHaveAttribute("tabindex", "0");
    await noPageScroll(page);
  });

  test("RST-E02 no index imported: the hint and the Import link are visible and keyboard reachable", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(
      page,
      relativeStrength(BARS, { vs_index: null, vs_index_reason: "no_index_series" }),
    );
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/stocks/TCS?tab=analysis");
    const box = page.getByTestId("inv-rs-no-index");
    await expect(box).toContainText("Import NIFTY50 history in prices.csv (the reserved symbol)");
    await expect(page.getByTestId("inv-rs-windows")).toHaveCount(0);
    await tabTo(page, "inv-rs-import-link");
    await expect(page.getByTestId("inv-rs-import-link")).toBeFocused();
    await expect(page.getByTestId("inv-rs-import-link")).toHaveAttribute("href", "/imports");
    expect(await axeViolations(page)).toEqual([]);
    await noPageScroll(page);
  });
});
