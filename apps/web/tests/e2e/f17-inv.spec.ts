import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import * as ix from "../mocks/inv-fixtures";
import type { MockReply } from "../mocks/imports-fixtures";
import { ok } from "../mocks/imports-fixtures";
import * as fx from "../mocks/stock-fixtures";

// F17 (INV-U08, INV-T06, INV-T07): the investment-context Analysis cards and the Home tile in a real
// browser: axe in both themes at 375 and 1440 px, no horizontal page scroll, 44 px targets, keyboard.

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

async function mockApi(page: Page, opts: { many?: boolean } = {}) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const routes: Record<string, MockReply> = {
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/prices": fx.prices({ n: 70 }),
      "GET /stocks/TCS/indicators": ix.indicatorsWithInv(),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /stocks/seasonality": opts.many
        ? ix.seasonalityMany(48)
        : ix.seasonalityList(
            new URL(req.url()).searchParams.get("scope") === "watchlist" ? "watchlist" : "all",
          ),
      "GET /watchlist": ok({
        stocks: ["AAA", "CCC"].map((symbol, id) => ({
          id: id + 1,
          symbol,
          name: `${symbol} Limited`,
          ltp: 100,
          ltp_as_of: "2026-11-10",
          change_pct: 0.5,
        })),
        funds: [],
      }),
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

test.describe("Analysis tab: investment-context cards", () => {
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
        await expect(page.getByTestId("inv-position")).toHaveAttribute("data-state", "ready");
        await expect(page.getByTestId("inv-sip")).toHaveAttribute("data-state", "ready");
        await expect(page.getByTestId("heatmap-year-col")).toBeVisible();
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

  test("tables scroll inside labelled focusable regions at 375 px, not the page", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/stocks/TCS?tab=analysis");
    await expect(page.getByTestId("inv-entry")).toHaveAttribute("data-state", "partial");
    const region = page.getByRole("region", { name: "Entry-point study, scrollable" });
    await expect(region).toHaveAttribute("tabindex", "0");
    const wider = await region.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(wider).toBe(true);
    await noPageScroll(page);
    // the monthly grid keeps its first and its Year column inside its own scroll region
    const grid = page.getByRole("region", { name: "Monthly returns by year, scrollable" });
    await expect(grid).toHaveAttribute("tabindex", "0");
    await expect(page.getByTestId("heatmap-year-col")).toBeVisible();
  });

  test("keyboard: the SIP day selector and the How to read disclosure", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stocks/TCS?tab=analysis");
    await expect(page.getByTestId("inv-sip")).toHaveAttribute("data-state", "ready");
    const ratio = page.getByTestId("inv-sip-ratio");
    await expect(ratio).toContainText("1.05x");
    await page.getByTestId("inv-sip-day").focus();
    await page.keyboard.press("ArrowDown");
    await expect(ratio).toContainText("1.06x");
    await expect(page.getByTestId("inv-sip-live")).toContainText("Day 1");
    const howto = page.getByTestId("inv-position-howto");
    await howto.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(howto).toHaveAttribute("open", "");
  });
});

test.describe("Home tile: This month, across the years", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`axe, targets and no page scroll: ${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await setTheme(page, theme);
        await expect(page.getByTestId("dash-seasonality-list")).toBeVisible();
        await expect(page.getByTestId("dash-seasonality-note")).toBeVisible();
        await setTheme(page, theme);
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) {
          expect(await smallTargets(page)).toEqual([]);
          await noPageScroll(page);
        }
      });
    }
  }

  test("keyboard: sort and minimum years by keyboard, a polite live region announces the count", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const list = page.getByTestId("dash-seasonality-list");
    await expect(list).toBeVisible();
    const order = () =>
      page
        .locator('a[data-testid^="dash-seasonality-row-"]')
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute("data-testid")?.replace("dash-seasonality-row-", "")),
        );
    expect(await order()).toEqual(["BBB", "CCC", "AAA"]);
    await page.getByTestId("dash-seasonality-sort").focus();
    await page.keyboard.press("ArrowDown"); // Most years first
    expect(await order()).toEqual(["BBB", "AAA", "CCC"]);
    await page.getByTestId("dash-seasonality-min-years").focus();
    await page.keyboard.press("ArrowDown"); // 5 years
    expect(await order()).toEqual(["BBB", "AAA"]);
    await expect(page.getByTestId("dash-seasonality-live")).toHaveText("2 stocks shown");
    await expect(page.getByTestId("dash-seasonality-short")).toContainText(
      "Not enough years yet (3)",
    );
    // Enter on a row follows its link to the Analysis tab
    await page.getByTestId("dash-seasonality-row-BBB").focus();
    await expect(page.getByTestId("dash-seasonality-row-BBB")).toHaveAttribute(
      "href",
      "/stocks/BBB?tab=analysis",
    );
  });

  test("INVA: the All stocks | Watchlist control works by keyboard and marks watchlisted stocks", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const order = () =>
      page
        .locator('a[data-testid^="dash-seasonality-row-"]')
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute("data-testid")?.replace("dash-seasonality-row-", "")),
        );
    await expect(page.getByTestId("dash-seasonality-list")).toBeVisible();
    expect(await order()).toEqual(["BBB", "CCC", "AAA"]);
    await expect(page.getByTestId("dash-seasonality-watch-AAA")).toBeVisible();
    await expect(page.getByTestId("dash-seasonality-watch-BBB")).toHaveCount(0);
    await page.getByTestId("dash-seasonality-scope-all").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("dash-seasonality-scope-watchlist")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("dash-seasonality-scope-watchlist")).toBeFocused();
    await expect.poll(order).toEqual(["CCC", "AAA"]);
    await expect(page.getByTestId("dash-seasonality-live")).toHaveText("2 stocks shown");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(order).toEqual(["BBB", "CCC", "AAA"]);
  });

  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`48 tracked stocks: axe, targets and no page scroll: ${theme} at ${width}`, async ({
        page,
      }) => {
        await signIn(page);
        await mockApi(page, { many: true });
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await setTheme(page, theme);
        await expect(page.getByTestId("dash-seasonality-list")).toBeVisible();
        await expect(page.getByTestId("dash-seasonality-scope")).toBeVisible();
        await setTheme(page, theme);
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) {
          expect(await smallTargets(page)).toEqual([]);
          await noPageScroll(page);
        }
      });
    }
  }

  test("375 px: one column, each row a stacked card, month so far at the end", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");
    const row = page.getByTestId("dash-seasonality-row-AAA");
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    const parts = await row.evaluate((el) =>
      Array.from(el.children).map((c) => Math.round(c.getBoundingClientRect().top)),
    );
    expect([...parts].sort((a, b) => a - b)).toEqual(parts);
    await noPageScroll(page);
  });
});
