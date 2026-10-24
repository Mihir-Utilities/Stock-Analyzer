import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Review findings for F01/F02 (docs/07 UI-26..UI-29): touch targets, dialog focus, forwarded host,
// reduced motion. Component checks run against the static Storybook build.

const SB = "http://127.0.0.1:6100";
const indexPath = join(process.cwd(), "storybook-static/index.json");
interface Entry {
  id: string;
  type: string;
  title: string;
}
const stories: Entry[] = existsSync(indexPath)
  ? Object.values(
      (JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Record<string, Entry> }).entries,
    ).filter(
      (e) => e.type === "story" && (e.title === "UI/Components" || e.title === "Charts/ChartFrame"),
    )
  : [];
const url = (id: string) => `${SB}/iframe.html?id=${id}&viewMode=story&globals=theme:dark`;

async function ready(page: Page) {
  await page.waitForSelector("#storybook-root > :not(style)");
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[data-testid="chart-canvas"]')).every(
      (el) => el.getAttribute("data-ready") === "true",
    ),
  );
}

// UI-26: every button / link with a data-testid is at least 44 x 44 px at 375 px width.
// Justified exclusion: the visually hidden skip-link (1x1 until focused, WCAG 2.4.1 pattern). Non-interactive elements with a testid (e.g. the
// column-resize handle, a div) are not matched by the selector.
test.describe("UI-26 touch targets are at least 44 px at 375 px width", () => {
  test.use({ viewport: { width: 375, height: 800 } });
  test("Storybook has stories to check", () => {
    expect(stories.length).toBeGreaterThan(30);
  });
  const measure = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("button[data-testid], a[data-testid]"))
        .filter((el) => el.getAttribute("data-testid") !== "skip-link")
        .map((el) => ({ id: el.getAttribute("data-testid"), r: el.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5))
        .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
    );
  for (const path of ["/", "/login", "/mf"]) {
    test(`shell page ${path}`, async ({ page }) => {
      await page
        .context()
        .addCookies([{ name: "session", value: "e2e-placeholder", url: "http://127.0.0.1:3100" }]);
      await page.goto(`http://127.0.0.1:3100${path}`);
      expect(await measure(page)).toEqual([]);
    });
  }
  for (const s of stories) {
    test(s.id, async ({ page }) => {
      await page.goto(url(s.id));
      await ready(page);
      expect(await measure(page)).toEqual([]);
    });
  }
});

// UI-27: dialog and drawer focus handling.
test.describe("UI-27 dialog and drawer focus", () => {
  const overlays = "ui-components--overlays";

  for (const [name, trigger, dialog] of [
    ["ConfirmDialog", "open-confirm", "confirm-dialog"],
    ["Drawer", "open-drawer", "drawer"],
  ] as const) {
    test(`${name}: Tab ten times stays inside, Escape returns focus to the trigger`, async ({
      page,
    }) => {
      await page.goto(url(overlays));
      await ready(page);
      await page.getByTestId(trigger).focus();
      await page.getByTestId(trigger).press("Enter");
      await expect(page.locator(`dialog[data-testid="${dialog}"]`).first()).toHaveAttribute(
        "open",
        "",
      );
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(
          (id) =>
            // Inside the dialog, or handed to the browser UI (body): never to the inert page behind.
            document.activeElement === document.body ||
            (document
              .querySelector(`dialog[data-testid="${id}"]`)
              ?.contains(document.activeElement) ??
              false),
          dialog,
        );
        expect(inside, `focus left the ${name} on Tab ${i + 1}`).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(page.locator(`dialog[data-testid="${dialog}"]`).first()).not.toHaveAttribute(
        "open",
        "",
      );
      await expect(page.getByTestId(trigger)).toBeFocused();
    });
  }

  test("backdrop click does not dismiss a confirmation (destructive actions need a button)", async ({
    page,
  }) => {
    await page.goto(url(overlays));
    await ready(page);
    await page.getByTestId("open-confirm").click();
    await expect(page.locator('dialog[data-testid="confirm-dialog"]').first()).toHaveAttribute(
      "open",
      "",
    );
    await page.mouse.click(5, 5);
    await expect(page.locator('dialog[data-testid="confirm-dialog"]').first()).toHaveAttribute(
      "open",
      "",
    );
  });

  test("a parent that ignores onCancel never leaves the dialog closed while open is true", async ({
    page,
  }) => {
    await page.goto(url(overlays));
    await ready(page);
    await page.getByTestId("open-stuck").click();
    const dlg = page.locator("dialog", { hasText: "Cannot dismiss" });
    await expect(dlg).toHaveAttribute("open", "");
    // Cancel button, then Escape twice (the second Escape is not cancelable in Chromium).
    await dlg.getByTestId("confirm-cancel").click();
    await expect(dlg).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await expect(dlg).toHaveAttribute("open", "");
    // And it still closes when the parent agrees.
    await dlg.getByTestId("confirm-ok").click();
    await expect(dlg).not.toHaveAttribute("open", "");
  });
});

// UI-28: redirect behind a proxy never carries an internal or forwarded host.
test("UI-28 login redirect Location is host-free even with forwarded host headers", async ({
  request,
}) => {
  const res = await request.get("http://127.0.0.1:3100/stocks/M%26M", {
    maxRedirects: 0,
    headers: { "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" },
  });
  expect(res.status()).toBe(307);
  const location = res.headers()["location"] ?? "";
  expect(location).toMatch(/^\/login\?next=/);
  expect(location).not.toContain("example.com");
});

// UI-29: reduced motion switches CSS transitions and animations off.
test.describe("UI-29 reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("transition and animation durations collapse to ~0", async ({ page }) => {
    await page.goto(url("ui-components--overlays"));
    await ready(page);
    const d = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('[data-testid="open-confirm"]')!);
      return { t: cs.transitionDuration, a: cs.animationDuration };
    });
    expect(parseFloat(d.t)).toBeLessThan(0.001);
    expect(parseFloat(d.a)).toBeLessThan(0.001);
  });
});
