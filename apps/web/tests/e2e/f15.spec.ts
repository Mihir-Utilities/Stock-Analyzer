import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { WEB_ORIGIN } from "./ports";
import { setTheme } from "./theme";

// F15: admin status in a real browser (axe, 320 px, offline), PWA files and the shell-only service
// worker. The API is not running in e2e; /admin/status is answered by a route mock.

const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");

async function signIn(page: Page) {
  await page.context().addCookies([{ name: "session", value: "e2e-placeholder", url: WEB_ORIGIN }]);
}

const STATUS = {
  sources: [
    {
      source: "mfapi",
      checked_at: "2026-10-23T09:00:00Z",
      ok: true,
      latency_ms: 850,
      consecutive_failures: 0,
    },
    {
      source: "amfi",
      checked_at: "2026-10-23T09:00:00Z",
      ok: false,
      latency_ms: 61000,
      consecutive_failures: 3,
      disabled_until: "2026-10-23T12:00:00Z",
      note: "circuit open",
    },
  ],
  jobs: [
    {
      job: "mf_nav_daily",
      started_at: "2026-10-23T08:00:00Z",
      finished_at: "2026-10-23T08:02:05Z",
      status: "ok",
      rows_written: 12345,
      items_failed: 0,
    },
    {
      job: "compute_analysis_with_an_extremely_long_job_name_for_a_narrow_screen",
      started_at: "2026-10-23T08:00:00Z",
      finished_at: "2026-10-23T08:00:10Z",
      status: "failed",
      rows_written: 0,
      items_failed: 5,
      error: "boom: a long error message ".repeat(8),
    },
  ],
  coverage: {
    instruments: 2231,
    tracked: 612,
    with_prices: 598,
    with_fundamentals: 410,
    with_shareholding: 401,
  },
  db: {
    size_mb: 300,
    tables: [{ name: "price_daily", mb: 210.4, rows: 1500000 }],
    warn_level: "70",
  },
  holiday_list_missing_years: [2026],
  version: "abc1234",
  storage_policy: { db_soft_limit_mb: 380 },
};

async function mockStatus(page: Page, kind: "ok" | "501" = "ok") {
  await page.route("**/api/v1/admin/status", (route) =>
    kind === "ok"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: STATUS, meta: { as_of: "2026-10-23T10:00:00Z" } }),
        })
      : route.fulfill({
          status: 501,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "NOT_IMPLEMENTED", message: "not built" } }),
        }),
  );
}

test.describe("admin status in a real browser", () => {
  test.use({ bypassCSP: true, reducedMotion: "reduce" });
  for (const kind of ["ok", "501"] as const) {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [375, 1440]) {
        test(`axe (UI-04) ${kind} ${theme} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockStatus(page, kind);
          await page.setViewportSize({ width, height: 900 });
          await page.goto("/admin/status");
          await expect(
            page.getByTestId(kind === "ok" ? "admin-jobs-table" : "admin-status-na-note"),
          ).toBeVisible();
          await setTheme(page, theme);
          await page.addScriptTag({ content: axeSource });
          const result = await page.evaluate(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const axe = (window as any).axe;
            const r = await axe.run(document, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
            });
            return r.violations.map(
              (v: { id: string; impact: string; nodes: { html: string }[] }) =>
                `${v.impact} ${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`,
            );
          });
          expect(result).toEqual([]);
        });
      }
    }
  }

  for (const width of [320, 375, 768, 1024, 1440]) {
    test(`UI-03 no horizontal scroll at ${width} px on /admin/status`, async ({ page }) => {
      await signIn(page);
      await mockStatus(page);
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/admin/status");
      await expect(page.getByTestId("admin-jobs-table")).toBeVisible();
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });
  }

  test("UI-08 a long job name is cut off with its full text as a tooltip", async ({ page }) => {
    await signIn(page);
    await mockStatus(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/admin/status");
    const cell = page.getByTestId("admin-job-row").nth(1).locator("th span");
    await expect(cell).toHaveAttribute("title", /extremely_long_job_name/);
    const clipped = await cell.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(true);
  });

  test("UI-06 offline: the banner appears, the loaded data stays, and it clears when back online", async ({
    page,
    context,
  }) => {
    await signIn(page);
    await mockStatus(page);
    await page.goto("/admin/status");
    await expect(page.getByTestId("admin-coverage")).toBeVisible();
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByTestId("offline-banner")).toContainText("You are offline");
    await expect(page.getByTestId("admin-coverage")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  });

  test("keyboard: the skip link is the first tab stop and reaches the main region", async ({
    page,
  }) => {
    await signIn(page);
    await mockStatus(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/status");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("skip-link")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("main")).toBeFocused();
  });
});

test.describe("PWA files are public and shell-only (PWA-01, PWA-02)", () => {
  test("manifest, icons, worker script and offline page load without a session", async ({
    request,
  }) => {
    const manifest = await request.get("/manifest.json");
    expect(manifest.status()).toBe(200);
    const body = (await manifest.json()) as { display: string; icons: Array<{ src: string }> };
    expect(body.display).toBe("standalone");
    for (const icon of body.icons) {
      const r = await request.get(icon.src);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()["content-type"]).toContain("image/png");
    }
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["content-type"]).toContain("javascript");
    expect(sw.headers()["cache-control"]).toContain("no-cache");
    const offline = await request.get("/offline.html");
    expect(offline.status()).toBe(200);
    expect(await offline.text()).toContain("You are offline");
  });

  test("a protected page still redirects to /login without a session", async ({ request }) => {
    const r = await request.get("/portfolio", { maxRedirects: 0 });
    expect(r.status()).toBe(307);
    expect(r.headers()["location"]).toContain("/login");
  });

  test("the worker registers, precaches only the shell and serves the offline page", async ({
    page,
    context,
  }) => {
    await page.goto("/login");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const out: string[] = [];
      for (const n of names) {
        const c = await caches.open(n);
        for (const req of await c.keys()) out.push(new URL(req.url).pathname);
      }
      return out;
    });
    expect(cached).toEqual(expect.arrayContaining(["/offline.html", "/icons/icon-192.png"]));
    expect(cached).not.toContain("/manifest.json"); // not precached (F15R-S10)
    // Nothing that carries data: no API response and no page HTML.
    expect(cached.some((p) => p.startsWith("/api/") || p === "/login")).toBe(false);
    // Reload while offline: the navigation fails and the worker answers with the offline page.
    await page.reload(); // controlled by the worker from now on
    await context.setOffline(true);
    await page.goto("/login").catch(() => undefined);
    await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe("visual regression (VISUAL=1; baselines are per OS)", () => {
  test.skip(!process.env.VISUAL, "set VISUAL=1 to compare or create baselines");
  for (const theme of ["dark", "light"] as const) {
    test(`admin status ${theme}`, async ({ page }) => {
      await signIn(page);
      await mockStatus(page);
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.goto("/admin/status");
      await expect(page.getByTestId("admin-jobs-table")).toBeVisible();
      await setTheme(page, theme);
      await expect(page).toHaveScreenshot(`admin-status-${theme}.png`, { fullPage: true });
    });
  }
});
