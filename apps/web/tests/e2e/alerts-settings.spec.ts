import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";

// F12: alerts, Telegram link, settings, sign-out. The API is not running in e2e: every /api/v1
// call is answered here from fixed data (no wall clock, no random values).

const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");

async function signIn(page: Page) {
  await page
    .context()
    .addCookies([{ name: "session", value: "e2e-placeholder", domain: "127.0.0.1", path: "/" }]);
}

const envelope = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ data, meta: {}, warnings: [] }),
});
const error = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } }),
});

const alert = {
  id: 7,
  target: { type: "stock", symbol: "TCS", name: "Tata Consultancy Services" },
  kind: "price_above",
  params: { price: 4000.5 },
  status: "active",
  one_shot: true,
  cooldown_minutes: 1440,
  expires_on: null,
  last_fired_at: null,
  created_at: "2026-10-20T04:00:00Z",
};

interface Seen {
  logout: number;
  logoutAll: number;
  csrf: Array<string | undefined>;
}

async function mockApi(page: Page, opts: { linked?: boolean } = {}): Promise<Seen> {
  const seen: Seen = { logout: 0, logoutAll: 0, csrf: [] };
  await page.route("**/api/v1/**", (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    if (req.method() !== "GET") seen.csrf.push(req.headers()["x-requested-with"]);
    switch (key) {
      case "GET /alerts":
        return route.fulfill(envelope({ items: [alert], next_cursor: null }));
      case "GET /alerts/events":
        return route.fulfill(envelope({ items: [], next_cursor: null }));
      case "GET /auth/me":
        return route.fulfill(
          envelope({ authenticated: true, telegram_linked: opts.linked === true, prefs: {} }),
        );
      case "POST /alerts":
        return route.fulfill(
          error(422, "THRESHOLD_ALREADY_MET", "already true", {
            kind: "price_above",
            threshold: 4000,
            value: 4123.5,
            as_of: "2026-10-23",
          }),
        );
      case "POST /telegram/link-code":
        return route.fulfill(
          envelope({
            code: "A7K9-Q2XM",
            expires_at: "2099-01-01T00:00:00Z",
            bot_username: null,
            deep_link: null,
          }),
        );
      case "POST /auth/logout":
        seen.logout += 1;
        return route.fulfill(envelope({ ok: true }));
      case "POST /auth/logout-all":
        seen.logoutAll += 1;
        return route.fulfill(envelope({ ok: true }));
      default:
        return route.fulfill(error(501, "NOT_IMPLEMENTED", key));
    }
  });
  return seen;
}

test.describe("ALR-01 threshold already met in a real browser", () => {
  test("create dialog shows the inline error and keeps the owner's input", async ({ page }) => {
    await signIn(page);
    const seen = await mockApi(page);
    await page.goto("/alerts");
    await page.getByTestId("alert-new").click();
    await page.getByTestId("alert-symbol").fill("TCS");
    await page.getByTestId("alert-param-price").fill("4000");
    await page.getByTestId("alert-submit").click();
    await expect(page.getByTestId("form-field-error")).toContainText(
      "last imported bar of 23 Oct 2026",
    );
    await expect(page.getByTestId("alert-param-price")).toHaveValue("4000");
    expect(seen.csrf).toContain("fetch");
  });
});

test.describe("ALR-16 link flow tolerates a missing bot", () => {
  test("code, countdown and honest bot-missing note", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/alerts");
    await page.getByTestId("telegram-make-code").click();
    await expect(page.getByTestId("telegram-code")).toHaveText("A7K9-Q2XM");
    await expect(page.getByTestId("telegram-bot-missing")).toBeVisible();
    await expect(page.getByTestId("telegram-countdown")).toContainText("Expires in");
  });
});

test.describe("SEC sign-out from the shell", () => {
  test("Sign out posts once and lands on /login", async ({ page }) => {
    await signIn(page);
    const seen = await mockApi(page);
    await page.goto("/alerts");
    await page.getByTestId("session-menu-button").click();
    await page.getByTestId("logout").click();
    await page.waitForURL("**/login**");
    expect(seen.logout).toBe(1);
    expect(seen.csrf).toContain("fetch");
  });

  test("Sign out everywhere asks first", async ({ page }) => {
    await signIn(page);
    const seen = await mockApi(page);
    await page.goto("/settings");
    await page.getByTestId("settings-logout-all").click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    expect(seen.logoutAll).toBe(0);
    await page.locator('dialog[open] [data-testid="confirm-ok"]').click();
    await page.waitForURL("**/login**");
    expect(seen.logoutAll).toBe(1);
  });
});

test.describe("axe and touch targets on alerts and settings (extends UI-26)", () => {
  test.use({ bypassCSP: true });
  for (const path of ["/alerts", "/settings"]) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`${path} ${theme} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(path);
          await setTheme(page, theme);
          if (path === "/alerts") {
            await page.getByTestId("alert-row").waitFor();
            await page.getByTestId("telegram-make-code").click();
            await page.getByTestId("telegram-code").waitFor();
          } else {
            await page.getByTestId("password-form").waitFor();
            await page.getByTestId("telegram-make-code").waitFor();
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

  test("the create form (drawer) passes axe and touch targets at 375", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/alerts");
    await page.getByTestId("alert-new").click();
    await page.getByTestId("alert-form").waitFor();
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (window as any).axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag412"] },
      });
      return r.violations.map((v: { id: string }) => v.id);
    });
    expect(violations).toEqual([]);
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll("dialog[open] button[data-testid]"))
        .map((el) => ({ id: el.getAttribute("data-testid"), r: el.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0 && (x.r.width < 43.5 || x.r.height < 43.5))
        .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
    );
    expect(small).toEqual([]);
  });
});
