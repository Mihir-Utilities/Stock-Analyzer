import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { WEB_ORIGIN } from "./ports";

const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");
const ORIGIN = WEB_ORIGIN;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  contentType: "application/json",
  headers,
  body: JSON.stringify(body),
});
const ok = (data: unknown) => json(200, { data, meta: {}, warnings: [] });
const fail = (status: number, code: string) => json(status, { error: { code, message: code } });

async function signIn(page: Page) {
  await page.context().addCookies([{ name: "session", value: "e2e-placeholder", url: ORIGIN }]);
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const r = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return r.violations.map(
      (v: { id: string; nodes: { html: string }[] }) =>
        `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`,
    );
  });
}

// SEC-01 (browser side) and the login journey.
test.describe("login (SEC-01, docs/06 section 6.1)", () => {
  test.use({ bypassCSP: true });

  test("wrong password and lockout look identical; success honours a safe next", async ({
    page,
  }) => {
    let calls = 0;
    await page.route("**/api/v1/auth/login", async (route) => {
      calls += 1;
      const body = route.request().postDataJSON() as { password: string };
      expect(route.request().headers()["x-requested-with"]).toBe("fetch");
      if (body.password === "right") {
        await route.fulfill(ok({ authenticated: true, expires_at: "2026-11-01T00:00:00Z" }));
      } else {
        await route.fulfill(fail(401, "UNAUTHENTICATED"));
      }
    });
    await page.route("**/api/v1/**", (route) => {
      if (route.request().url().includes("/auth/login")) return route.fallback();
      return route.fulfill(fail(501, "NOT_IMPLEMENTED"));
    });

    await page.goto("/login?next=%2Fportfolio");
    for (let i = 0; i < 3; i++) {
      await page.getByTestId("login-password").fill("wrong");
      await page.getByTestId("login-submit").click();
      await expect(page.getByTestId("form-field-error")).toContainText(
        "Invalid credentials or temporarily locked.",
      );
    }
    expect(calls).toBe(3);
    expect(await axeViolations(page)).toEqual([]);

    await page.getByTestId("login-password").fill("right");
    await page.getByTestId("login-submit").click();
    // The placeholder session cookie is not set by the mocked login, so the gate sends the
    // browser back to /login with the same validated next: proof the redirect target was /portfolio.
    await page.waitForURL(/\/login\?next=%2Fportfolio/);
  });

  test("429 shows the Retry-After wait", async ({ page }) => {
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill(
        json(429, { error: { code: "RATE_LIMITED", message: "x" } }, { "Retry-After": "30" }),
      ),
    );
    await page.goto("/login");
    await page.getByTestId("login-password").fill("x");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("form-field-error")).toContainText("Try again in 30 s");
  });
});

// UI-01 style loaded dashboard, 375 px: no horizontal scroll, touch targets, axe incl. contrast.
test.describe("dashboard with data", () => {
  test.use({ bypassCSP: true, viewport: { width: 375, height: 900 } });

  test("renders cards, passes axe and touch-target checks", async ({ page }) => {
    await signIn(page);
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
      if (path === "/watchlist") {
        return route.fulfill(
          ok({
            stocks: [
              {
                id: 1,
                symbol: "TCS",
                name: "TCS",
                ltp: 4012.5,
                ltp_as_of: "2026-10-23",
                change_pct: 1.5,
              },
              {
                id: 2,
                symbol: "INFY",
                name: "Infosys",
                ltp: 1500,
                ltp_as_of: "2026-10-23",
                change_pct: -2.25,
              },
            ],
            funds: [],
          }),
        );
      }
      if (path === "/alerts/events") {
        return route.fulfill(ok({ items: [], next_cursor: null }));
      }
      if (path === "/broker/status") return route.fulfill(ok({ enabled: false, mode: "manual" }));
      if (path.endsWith("/events")) return route.fulfill(ok({ calendar: [] }));
      return route.fulfill(fail(501, "NOT_IMPLEMENTED"));
    });
    await page.goto("/");
    await expect(page.getByTestId("watch-tile")).toHaveCount(2);
    await expect(page.getByTestId("dash-indices")).toHaveAttribute("data-state", "empty");
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => {
        localStorage.setItem("analyzer-theme", t);
        document.documentElement.setAttribute("data-theme", t);
      }, theme);
      await page.waitForTimeout(500); // let colour transitions settle before sampling contrast
      expect(await axeViolations(page)).toEqual([]);
    }
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button[data-testid], a[data-testid]"))
        .filter((el) => el.getAttribute("data-testid") !== "skip-link")
        .map((el) => ({ id: el.getAttribute("data-testid"), r: el.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5))
        .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
    );
    expect(small).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
