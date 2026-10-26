import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import * as cx from "../mocks/chart-fixtures";
import type { MockReply } from "../mocks/imports-fixtures";
import { ok } from "../mocks/imports-fixtures";
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

/** Every /api/v1 call is answered from the contract fixtures; `n` sets the bar count. */
async function mockApi(page: Page, n = 70) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    const big = n > 200;
    const prices = big
      ? ok({
          bars: cx.manyBars(n),
          adjusted: true,
          actions: [{ date: "2019-03-01", type: "split", label: "1:2 split" }],
        })
      : fx.prices({
          n,
          actions: [{ date: fx.bars(n)[30]?.[0] ?? "", type: "split", label: "1:2 split" }],
        });
    const routes: Record<string, MockReply> = {
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/prices": prices,
      "GET /stocks/TCS/indicators": cx.indicatorsWithSeries(70),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /watchlist": fx.emptyWatchlist,
    };
    return reply(
      route,
      routes[key] ?? { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: key } } },
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
    Array.from(document.querySelectorAll("button[data-testid], a[data-testid], input[data-testid]"))
      .filter((el) => el.getAttribute("data-testid") !== "skip-link")
      .map((el) => ({ id: el.getAttribute("data-testid"), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5))
      .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
  );
}

test("Chart tab draws candles, volume and indicator panes in a real browser (UI-07, UI-10)", async ({
  page,
}) => {
  await signIn(page);
  await mockApi(page);
  await page.goto("/stocks/TCS?tab=chart");
  const frame = page.getByTestId("chart-main");
  await expect(frame).toHaveAttribute("data-state", "ready");
  await expect(frame.getByTestId("chart-canvas")).toHaveAttribute("data-ready", "true");
  await page.getByTestId("pane-rsi").click();
  await page.getByTestId("pane-macd").click();
  await expect(frame.locator("svg").first()).toBeVisible();
  // Candles are drawn (one path per candle plus panes), nothing throws.
  expect(await frame.locator("svg path").count()).toBeGreaterThan(70);
  await frame.getByTestId("chart-show-data").click();
  await expect(frame.getByTestId("chart-data-row")).toHaveCount(70);
  await frame.getByTestId("chart-show-data").click();
  await page.getByTestId("tab-analysis").click();
  await expect(page).toHaveURL(/tab=analysis/);
  await expect(page.getByTestId("chart-drawdown")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("chart-rolling-beta")).toContainText("no benchmark data imported");
});

test("2,000 points render smoothly on a phone", async ({ page }) => {
  await signIn(page);
  await mockApi(page, 2000);
  await page.setViewportSize({ width: 375, height: 800 });
  const t0 = Date.now();
  await page.goto("/stocks/TCS?tab=chart");
  const frame = page.getByTestId("chart-main");
  await expect(frame.getByTestId("chart-canvas")).toHaveAttribute("data-ready", "true", {
    timeout: 15_000,
  });
  await expect(frame).toHaveAttribute("data-state", "ready");
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(10_000);
  // Rendering 2,000 candles must not freeze the main thread: a click right after still answers.
  const start = Date.now();
  await page.getByTestId("overlay-sma20").click();
  expect(Date.now() - start).toBeLessThan(3_000);
  await frame.getByTestId("chart-show-data").click();
  await expect(frame.getByTestId("chart-data-row")).toHaveCount(2000);
});

test.describe("touch pinch", () => {
  // The CDP touch events below need a touch-enabled context, otherwise Chrome may drop them.
  test.use({ hasTouch: true });
  test("zooms the chart (mobile emulation)", pinchZoom);
});

async function pinchZoom({ page, browserName }: { page: Page; browserName: string }) {
  test.skip(browserName !== "chromium", "CDP touch events");
  await signIn(page);
  await mockApi(page, 400);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/stocks/TCS?tab=chart");
  const canvas = page.getByTestId("chart-main").getByTestId("chart-canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  // Touch points are viewport coordinates: bring the chart fully into view first and measure it
  // after the layout (fonts, banners) has settled, or the gesture can land on another element.
  await canvas.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const countLabels = () => canvas.locator("svg text").count();
  const before = await canvas.locator("svg").first().innerHTML();
  const cdp = await page.context().newCDPSession(page);
  const cy = box.y + 120;
  const cxm = box.x + box.width / 2;
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    pts: Array<{ x: number; y: number }>,
  ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  await touch("touchStart", [
    { x: cxm - 20, y: cy },
    { x: cxm + 20, y: cy },
  ]);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [
      { x: cxm - 20 - i * 12, y: cy },
      { x: cxm + 20 + i * 12, y: cy },
    ]);
    await page.waitForTimeout(40); // a finger takes frames to move; the zoom handler is throttled
  }
  await touch("touchEnd", []);
  // The zoom redraw lands a few frames after touchEnd; under load a fixed 300 ms was not enough.
  await expect
    .poll(() => canvas.locator("svg").first().innerHTML(), { timeout: 10_000 })
    .not.toEqual(before);
  expect(await countLabels()).toBeGreaterThan(0);
}

test.describe("axe and touch targets on the Chart and Analysis tabs", () => {
  test.use({ bypassCSP: true });
  for (const tab of ["chart", "analysis"] as const) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`${tab} ${theme} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(`/stocks/TCS?tab=${tab}`);
          await setTheme(page, theme);
          if (tab === "chart") {
            await expect(page.getByTestId("chart-main")).toHaveAttribute("data-state", "ready");
            await expect(page.getByTestId("indicator-summary")).toContainText(
              "Plain-language read",
            );
            await page.getByTestId("pane-rsi").click();
            await page.getByTestId("compare-input").fill("INFY");
          } else {
            await expect(page.getByTestId("chart-histogram")).toHaveAttribute(
              "data-state",
              "ready",
            );
            await expect(page.getByTestId("heatmap-calendar")).toBeVisible();
          }
          await page.waitForTimeout(400);
          expect(await axeViolations(page)).toEqual([]);
          if (width === 375) {
            expect(await smallTargets(page)).toEqual([]);
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
