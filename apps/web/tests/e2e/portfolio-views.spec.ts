import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import { dbStatus, stockIndex, type MockReply } from "../mocks/imports-fixtures";
import * as pf from "../mocks/portfolio-fixtures";
import * as fx from "../mocks/mf-portfolio-fixtures";

// F16 review (MFHW-E*): the All / Equity / Mutual funds views, the MF transaction form and the
// statement import wizard in a real browser: axe, keyboard use of the switcher, a 375 px layout.
// The API is not running in e2e; every /api/v1 call is answered from synthetic contract fixtures.

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

const META = { as_of: "2026-10-24T09:00:00Z", source: "mixed", stale: false };

async function mockApi(page: Page) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    let r: MockReply | undefined;
    switch (key) {
      case "GET /portfolio/summary": {
        const v = url.searchParams.get("view");
        const view = v === "mf" || v === "equity" ? v : "all";
        r = fx.envelope(fx.viewSummary(view), [], 200, META);
        break;
      }
      case "GET /portfolio/txns":
        r = fx.envelope(pf.txns);
        break;
      case "GET /portfolio/adjustments":
        r = fx.envelope(pf.adjustments);
        break;
      case "GET /portfolio/mf/txns":
        r = fx.envelope({ items: [fx.mfTxn, fx.mfTxnImported], next_cursor: null });
        break;
      case "GET /portfolio/mf/fund-mappings":
        r = fx.envelope({ items: [fx.mfMapping] });
        break;
      case "GET /portfolio/mf/holdings":
        r = fx.envelope({ items: [fx.alphaGrowth, fx.betaIdcw] });
        break;
      case "GET /mf/schemes":
        r = fx.envelope(fx.mfSchemeSearch);
        break;
      case "GET /market/holidays":
        r = { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: "holidays" } } };
        break;
      case "GET /admin/status":
        r = dbStatus(100);
        break;
      case "GET /stocks/index":
        r = stockIndex;
        break;
      case "POST /imports/mf_statement/validate":
        r = fx.envelope(fx.mfValidate({ unmapped: false }));
        break;
    }
    return reply(
      route,
      r ?? { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: key } } },
    );
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

async function smallTargets(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("button[data-testid], a[data-testid]"))
      .filter((el) => el.getAttribute("data-testid") !== "skip-link")
      .map((el) => ({ id: el.getAttribute("data-testid"), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5))
      .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
  );
}

const VIEW_READY = {
  all: "pf-breakdown-table",
  equity: "pf-card-benchmark",
  mf: "pf-mf-holdings-table",
} as const;

test.describe("MFHW-E1 axe on each portfolio view", () => {
  test.use({ bypassCSP: true });
  for (const view of ["all", "equity", "mf"] as const) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`view ${view} ${theme} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(`/portfolio?view=${view}`);
          await setTheme(page, theme);
          await page.getByTestId(VIEW_READY[view]).waitFor();
          if (view !== "equity") await page.getByTestId("pf-mf-charts").waitFor();
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

test.describe("MFHW-E2 axe on the MF transaction form", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`add form ${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/portfolio?view=mf");
        await setTheme(page, theme);
        await page.getByTestId("pf-mf-txn-add").click();
        await page.getByTestId("pf-mf-txn-form").waitFor();
        await expect(page.getByTestId("pf-mf-txn-form-heading")).toBeFocused();
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) expect(await smallTargets(page)).toEqual([]);
      });
    }
  }
});

test.describe("MFHW-E3 axe on the statement import wizard", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`upload and review ${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/imports?kind=mf_statement");
        await setTheme(page, theme);
        await page.getByTestId("mf-import-file").waitFor();
        expect(await axeViolations(page)).toEqual([]);
        await page.getByTestId("mf-import-file").setInputFiles({
          name: "statement.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("Date,Fund Name\n"),
        });
        await page.getByTestId("wizard-next").click();
        await page.getByTestId("mf-import-summary").waitFor();
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
});

test.describe("MFHW-E4 the view switcher by keyboard", () => {
  test("arrows move and select, rapid arrows end on the last one pressed, the URL follows", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/portfolio");
    await page.getByTestId("pf-breakdown-table").waitFor();
    await expect(page.getByTestId("pf-view-all")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("pf-view-all").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("pf-view-equity")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("pf-view-equity")).toBeFocused();
    await expect(page).toHaveURL(/view=equity/);
    // two quick presses: equity -> mf -> all (wraps); the late URL report must not undo the second
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("pf-view-all")).toHaveAttribute("aria-checked", "true");
    await expect(page).toHaveURL(/view=all/);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("pf-view-all")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("End");
    await expect(page.getByTestId("pf-view-mf")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("pf-mf-holdings-table").waitFor();
    await expect(page.getByTestId("pf-view-body")).toHaveAttribute("data-view", "mf");
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pf-view-all")).toHaveAttribute("aria-checked", "true");
  });

  test("the stock sections of All show only stock numbers", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/portfolio?view=all");
    await page.getByTestId("pf-ltp-note").waitFor();
    await expect(page.getByTestId("pf-ltp-note")).toContainText("+₹1,234.50");
    await expect(page.getByTestId("pf-ltp-note")).not.toContainText("1,534.50");
    await expect(page.getByTestId("pf-card-total-pnl")).toHaveCount(0);
  });
});

test.describe("MFHW-E5 layout at 375 px", () => {
  for (const view of ["all", "equity", "mf"] as const) {
    test(`${view}: no horizontal scroll of the page, the MF table scrolls inside its own region`, async ({
      page,
    }) => {
      await signIn(page);
      await mockApi(page);
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(`/portfolio?view=${view}`);
      await page.getByTestId(VIEW_READY[view]).waitFor();
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      if (view !== "equity") {
        const region = page.getByRole("region", { name: "Mutual fund holdings table" });
        const wide = await region.evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(wide).toBe(true);
        // the scheme name column stays in view while the table scrolls sideways
        await region.evaluate((el) => (el.scrollLeft = 300));
        const th = page.getByTestId("pf-mf-row-100001").locator("th").first();
        const box = await th.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(-1);
        expect(box!.x).toBeLessThan(60);
      }
    });
  }
});
