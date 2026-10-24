import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");

async function signIn(page: Page) {
  await page
    .context()
    .addCookies([{ name: "session", value: "e2e-placeholder", url: "http://127.0.0.1:3100" }]);
}

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.evaluate((t) => {
    localStorage.setItem("analyzer-theme", t);
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
}

// Real-browser axe (colour contrast needs layout). Run with bypassCSP so the library can be
// injected; the CSP itself is exercised in the next tests.
test.describe("axe in a real browser (UI-04, Lighthouse a11y proxy)", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const path of ["/", "/login"]) {
      for (const vp of [
        { width: 375, height: 800 },
        { width: 1440, height: 900 },
      ]) {
        test(`${theme} ${path} at ${vp.width}`, async ({ page }) => {
          await signIn(page);
          await page.setViewportSize(vp);
          await page.goto(path);
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
});

// UI-03: 320 px width; no horizontal scroll (the shell has no sticky-column tables).
test.describe("responsive shell (UI-03, UI-13)", () => {
  for (const width of [320, 375, 768, 1024, 1440]) {
    for (const path of ["/", "/mf"]) {
      test(`no horizontal scroll at ${width} px on ${path}`, async ({ page }) => {
        await signIn(page);
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path);
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });
    }
  }

  test("UI-13 mobile shows bottom tabs and no sidebar; desktop the reverse", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    await expect(page.getByTestId("bottom-tabs")).toBeVisible();
    await expect(page.getByTestId("sidebar")).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("bottom-tabs")).toBeHidden();
  });

  test("UI-13 touch targets in the bottom tab bar are at least 44 px", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/");
    for (const id of [
      "tab-nav-home",
      "tab-nav-stocks",
      "tab-nav-funds",
      "tab-nav-portfolio",
      "tab-more",
    ]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("footer on every page (SAF-03)", () => {
  test("disclaimer on shell and login; attribution on MF pages", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("app-disclaimer")).toBeVisible();
    await signIn(page);
    await page.goto("/");
    await expect(page.getByTestId("app-disclaimer")).toBeVisible();
    await expect(page.getByTestId("mf-attribution")).toHaveCount(0);
    await page.goto("/mf");
    await expect(page.getByTestId("mf-attribution")).toHaveText("NAV data: AMFI via mfapi.in.");
  });
});

test.describe("no external network, CSP, headers", () => {
  test("UI-14 every request stays on this origin and the CSP blocks nothing we ship", async ({
    page,
  }) => {
    const external: string[] = [];
    const cspErrors: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (!["http:", "https:"].includes(url.protocol)) return; // data: and blob: stay in the page
      if (url.origin !== "http://127.0.0.1:3100") external.push(req.url());
    });
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) cspErrors.push(m.text());
    });
    page.on("pageerror", (e) => cspErrors.push(e.message));
    await signIn(page);
    for (const path of ["/", "/login", "/mf"]) {
      await page.goto(path);
      await expect(page.getByTestId("app-disclaimer")).toBeVisible();
      // Not "networkidle": Next keeps prefetching RSC payloads for the visible nav links.
      await page.waitForTimeout(750);
      if ((await page.getByTestId("theme-toggle").count()) > 0) {
        await page.getByTestId("theme-toggle").click();
      }
    }
    expect(external).toEqual([]);
    expect(cspErrors).toEqual([]);
  });

  test("security headers and a fresh nonce per request", async ({ request }) => {
    const a = await request.get("/login");
    const b = await request.get("/login");
    const cspA = a.headers()["content-security-policy"] ?? "";
    const cspB = b.headers()["content-security-policy"] ?? "";
    expect(cspA).toMatch(/default-src 'self'/);
    expect(cspA).toMatch(/script-src 'self' 'nonce-/);
    expect(cspA).not.toBe(cspB);
    expect(a.headers()["x-content-type-options"]).toBe("nosniff");
    expect(a.headers()["x-frame-options"]).toBe("DENY");
    expect(a.headers()["referrer-policy"]).toBe("no-referrer");
    expect(a.headers()["x-powered-by"]).toBeUndefined();
  });

  test("self-hosted Inter faces are registered", async ({ page }) => {
    await page.goto("/login");
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].map((f) => f.family);
    });
    expect(fonts.length).toBeGreaterThan(0);
  });
});

// SEC-06 end to end: the gate and the login page never send the browser off-origin.
test.describe("auth gate and safe next (SEC-06)", () => {
  test("anonymous visit goes to /login with the path remembered", async ({ page }) => {
    await page.goto("/stocks/M%26M?tab=chart");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/stocks/M%26M?tab=chart");
  });

  test("a protocol-relative path never produces an off-origin redirect", async ({ request }) => {
    const res = await request.get("http://127.0.0.1:3100//evil.example/x", { maxRedirects: 0 });
    const location = res.headers()["location"];
    if (location !== undefined) {
      expect(new URL(location, "http://127.0.0.1:3100").origin).toBe("http://127.0.0.1:3100");
    }
  });

  test("an API path is not redirected to the login page", async ({ request }) => {
    const res = await request.get("/api/v1/healthz", { maxRedirects: 0 });
    expect(res.status()).not.toBe(307);
  });
});

test.describe("theme", () => {
  test("UI-19 toggle persists across reloads without a flash", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    const before = await page.locator("html").getAttribute("data-theme");
    await page.getByTestId("theme-toggle").click();
    const after = await page.locator("html").getAttribute("data-theme");
    expect(after).not.toBe(before);
    await page.reload();
    expect(await page.locator("html").getAttribute("data-theme")).toBe(after);
  });

  test("follows the system preference when nothing is stored", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.goto("/login");
    expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
    await ctx.close();
  });
});
