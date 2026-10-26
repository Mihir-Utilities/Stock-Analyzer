import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import { fail, type MockReply } from "../mocks/imports-fixtures";
import * as fx from "../mocks/portfolio-fixtures";

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

interface Seen {
  posts: Array<{ key: string | null; body: unknown }>;
}

/** The API is not running in e2e; every /api/v1 call is answered from the contract fixtures. */
async function mockApi(page: Page, oversell = false): Promise<Seen> {
  const seen: Seen = { posts: [] };
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    let r: MockReply | undefined;
    switch (key) {
      case "GET /portfolio/summary":
        r = fx.envelope(fx.summary(), fx.reviewWarnings);
        break;
      case "GET /portfolio/txns":
        r = fx.envelope(fx.txns);
        break;
      case "GET /portfolio/adjustments":
        r = fx.envelope(fx.adjustments);
        break;
      case "GET /watchlist":
        r = fx.envelope(fx.watchlist);
        break;
      case "GET /market/holidays":
        r = fail(501, "NOT_IMPLEMENTED", "holidays");
        break;
      case "POST /portfolio/txns":
        seen.posts.push({
          key: req.headers()["idempotency-key"] ?? null,
          body: req.postDataJSON(),
        });
        r = oversell
          ? fail(
              422,
              "INSUFFICIENT_HOLDINGS",
              "A sell would exceed the quantity held on its date",
              {
                transaction_id: 0,
                date: "2026-10-23",
                held_qty: "10.0000",
                sell_qty: "15.0000",
              },
            )
          : fx.envelope(
              fx.savedTxn,
              [
                {
                  code: "NON_TRADING_DAY",
                  message: "24 Oct 2026 was a weekend or listed market holiday",
                },
              ],
              201,
            );
        break;
    }
    return reply(
      route,
      r ?? { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: key } } },
    );
  });
  return seen;
}

test("PF-01 E2E: an oversell is refused with the server's detail", async ({ page }) => {
  await signIn(page);
  const seen = await mockApi(page, true);
  await page.goto("/portfolio");
  await expect(page.getByTestId("pf-summary")).toContainText("+₹5,000.00");
  await page.getByTestId("txn-add").click();
  await page.getByTestId("txn-symbol").fill("TCS");
  await page.getByTestId("txn-side").selectOption("sell");
  await page.getByTestId("txn-qty").fill("15");
  await page.getByTestId("txn-price").fill("4000");
  await page.getByTestId("txn-date").fill("2026-10-23");
  await page.getByTestId("txn-save").click();
  const err = page.getByTestId("txn-error");
  await expect(err).toContainText("A sell would exceed the quantity held on its date");
  await expect(err).toContainText("you hold 10 shares and the sell is for 15");
  expect(seen.posts).toHaveLength(1);
  expect(seen.posts[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  // the retry of the same attempt reuses the key
  await page.getByTestId("txn-save").click();
  await expect.poll(() => seen.posts.length).toBe(2);
  expect(seen.posts[1]?.key).toBe(seen.posts[0]?.key);
});

test("PF-06 E2E: a weekend date warns and the transaction can still be saved", async ({ page }) => {
  await signIn(page);
  const seen = await mockApi(page);
  await page.goto("/portfolio");
  await page.getByTestId("txn-add").click();
  await page.getByTestId("txn-symbol").fill("TCS");
  await page.getByTestId("txn-qty").fill("5");
  await page.getByTestId("txn-price").fill("4000");
  await page.getByTestId("txn-date").fill("2026-10-24");
  await expect(page.getByTestId("txn-nontrading-warning")).toContainText("weekend");
  await page.getByTestId("txn-save").click();
  await expect.poll(() => seen.posts.length).toBe(1);
  await expect(page.getByTestId("txn-notice")).toContainText("weekend or listed market holiday");
});

test("PF-09 E2E: a split/bonus adjustment is shown, value is invariant, review items are honest", async ({
  page,
}) => {
  await signIn(page);
  await mockApi(page);
  await page.goto("/portfolio");
  const row = page
    .getByRole("grid", { name: "Holdings" })
    .getByRole("row")
    .filter({ hasText: "INFY" });
  await expect(row).toContainText("₹10,000.00");
  await expect(row).toContainText("bonus 1 Aug 2026 x2.00000000 applied");
  await expect(page.getByTestId("pf-warning-REVIEW_NEEDED")).toContainText("needs review");
  await expect(page.getByTestId("adj-review-banner")).toContainText("Review needed");
  await expect(page.getByTestId("adj-remove")).toBeDisabled();
  await expect(page.getByTestId("pf-chart-sector")).toBeVisible();
});

test.describe("axe and touch targets on portfolio and watchlist", () => {
  test.use({ bypassCSP: true });
  for (const path of ["/portfolio", "/watchlist"]) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`${path} ${theme} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(path);
          await setTheme(page, theme);
          if (path === "/portfolio") {
            await page.getByTestId("pf-chart-breakdown").waitFor();
            await page.getByTestId("txn-table").waitFor();
            await page.getByTestId("adj-list").waitFor();
            await page.getByTestId("txn-add").click();
          } else {
            await page.getByTestId("watch-stock-TCS").waitFor();
          }
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
