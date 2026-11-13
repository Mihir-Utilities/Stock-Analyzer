import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import { dbStatus, stockIndex, type MockReply } from "../mocks/imports-fixtures";
import * as pf from "../mocks/portfolio-fixtures";
import * as fx from "../mocks/mf-portfolio-fixtures";
import * as rf from "../mocks/risk-fixtures";

// F20 (PRK-E01): the Portfolio risk section in a real browser: axe in both themes at 375 and 1440 px
// for All, Equity and Mutual funds, the keyboard on the view switch, no horizontal page scroll and
// "Show data" for both charts. The API is not running in e2e; every /api/v1 call is answered from
// synthetic contract fixtures.

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

async function mockApi(page: Page, opts: { unpriced?: boolean } = {}) {
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    const v = url.searchParams.get("view");
    const view = v === "mf" || v === "equity" ? v : "all";
    let r: MockReply | undefined;
    switch (key) {
      case "GET /portfolio/summary":
        r = fx.envelope(fx.viewSummary(view), [], 200, META);
        break;
      case "GET /portfolio/risk":
        r = pf.envelope(
          rf.risk(view, opts.unpriced ? { concentration: rf.unpriced } : {}),
          [],
          200,
          { ...META, source: view === "mf" ? "mfapi.in" : "mixed" },
        );
        break;
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
    Array.from(
      document.querySelectorAll(
        "[data-testid='pf-risk'] button[data-testid], [data-testid='pf-risk'] a[data-testid]",
      ),
    )
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

/** The section loads when it is near the viewport: scroll to it, then wait for its body. */
async function openRisk(page: Page, view: string) {
  await page.goto(`/portfolio?view=${view}`);
  await page.getByTestId("pf-risk-gate").scrollIntoViewIfNeeded();
  await page.getByTestId("pf-risk-body").waitFor();
  for (const c of await page.getByTestId("pf-risk").getByTestId("chart-canvas").all()) {
    await expect(c).toHaveAttribute("data-ready", "true");
  }
}

test.describe("PRK-E01 axe, targets and no page scroll", () => {
  test.use({ bypassCSP: true });
  for (const view of ["all", "equity", "mf"] as const) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`view ${view} ${theme} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await openRisk(page, view);
          await setTheme(page, theme);
          expect(await axeViolations(page)).toEqual([]);
          if (width === 375) {
            expect(await smallTargets(page)).toEqual([]);
            await noPageScroll(page);
          }
        });
      }
    }
  }

  for (const theme of ["dark", "light"] as const) {
    test(`partial state (unpriced holding) ${theme} at 375`, async ({ page }) => {
      await signIn(page);
      await mockApi(page, { unpriced: true });
      await page.setViewportSize({ width: 375, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openRisk(page, "all");
      await setTheme(page, theme);
      await expect(page.getByTestId("pf-risk-reason")).toContainText("D has no imported price yet");
      expect(await axeViolations(page)).toEqual([]);
      await noPageScroll(page);
    });
  }
});

test.describe("PRK-E01 keyboard and Show data", () => {
  test("arrows on the view switch update the section; one tab stop stays on the switcher", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await openRisk(page, "all");
    await expect(page.getByTestId("pf-risk")).toHaveAttribute("data-view", "all");
    await page.getByTestId("pf-view-all").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("pf-view-equity")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("pf-risk")).toHaveAttribute("data-view", "equity");
    await expect(page.getByTestId("pf-risk-live")).toContainText(
      "Portfolio risk updated for Equity",
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("pf-risk")).toHaveAttribute("data-view", "mf");
    await expect(page.getByTestId("pf-risk-live")).toContainText("Mutual funds");
  });

  test("Show data opens for both charts and the tables are keyboard-scrollable regions", async ({
    page,
  }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 375, height: 900 });
    await openRisk(page, "all");
    for (const chart of ["pf-risk-index-chart", "pf-risk-drawdown-chart"]) {
      const frame = page.getByTestId(chart);
      await frame.getByTestId("chart-show-data").click();
      await expect(frame.getByTestId("chart-data-table")).toBeVisible();
    }
    for (const id of ["pf-risk-weights-table", "pf-risk-groups-table", "pf-risk-stress-table"]) {
      const region = page.getByTestId(id);
      await expect(region).toHaveAttribute("tabindex", "0");
      await expect(region).toHaveAttribute("role", "region");
    }
    await noPageScroll(page);
  });
});
