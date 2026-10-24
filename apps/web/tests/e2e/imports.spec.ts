import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  adjustmentRawLikely,
  commitOk,
  dbStatus,
  invalidPrices,
  ok,
  stockIndex,
  trimPreview,
  validPrices,
  type MockReply,
} from "../mocks/imports-fixtures";

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

/** The API is not running in e2e; every /api/v1 call is answered from the contract fixtures. */
async function mockApi(page: Page, prices: unknown = validPrices) {
  const counts: Record<string, number> = {};
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    counts[key] = (counts[key] ?? 0) + 1;
    switch (key) {
      case "POST /imports/prices/adjustment-check":
        return reply(route, ok(adjustmentRawLikely));
      case "POST /stocks/TCS/prices/delete-preview":
        return reply(route, ok({ rows: 120 }));
      case "GET /admin/status":
        return reply(route, dbStatus(330));
      case "POST /imports/prices/validate":
        return reply(route, ok(prices));
      case "PUT /settings/prices-adjustment":
        return reply(route, ok({ value: false, set_at: "2026-10-24T09:00:00Z" }));
      case "POST /imports/prices/commit":
        // Slow enough for a double click to land while the first request is in flight.
        await new Promise((r) => setTimeout(r, 400));
        return reply(route, ok(commitOk));
      case "GET /stocks/index":
        return reply(route, stockIndex);
      case "POST /prices/trim/preview":
        return reply(route, ok(trimPreview));
      default:
        return reply(route, {
          status: 501,
          body: { error: { code: "NOT_IMPLEMENTED", message: key } },
        });
    }
  });
  return counts;
}

const csv = {
  name: "prices.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("symbol,date\nTCS,2026-10-20\n"),
};

test("prices wizard end to end: upload, review, choose raw, commit, no undo (IMP-11, IMP-14, IMP-25)", async ({
  page,
}) => {
  await signIn(page);
  await mockApi(page);
  await page.goto("/imports");
  await page.getByTestId("import-file").setInputFiles(csv);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("import-summary")).toContainText("2 rows read, 0 errors");
  await expect(page.getByRole("heading", { name: "Review the file" })).toBeFocused();
  await expect(page.getByTestId("wizard-next")).toBeDisabled();
  await page.getByTestId("adjustment-raw").check();
  await expect(page.getByTestId("wizard-next")).toBeEnabled();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-commit").click();
  await expect(page.getByTestId("confirm-cancel")).toBeFocused();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("import-result")).toContainText("batch 7");
  await expect(page.getByTestId("result-undo-note")).toContainText("cannot be undone");
});

test("row errors block the commit and name row and column (IMP-11, D-P)", async ({ page }) => {
  await signIn(page);
  await mockApi(page, invalidPrices);
  await page.goto("/imports");
  await page.getByTestId("import-file").setInputFiles(csv);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("import-error-row")).toHaveCount(2);
  await expect(page.getByTestId("import-error-row").first()).toContainText("close");
  await expect(page.getByTestId("wizard-next")).toBeDisabled();
});

test.describe("axe in a real browser on the Import center", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      for (const state of ["review", "storage"] as const) {
        test(`${theme} ${state} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page, invalidPrices);
          await page.setViewportSize({ width, height: 900 });
          await page.goto("/imports");
          await page.evaluate((t) => {
            localStorage.setItem("analyzer-theme", t);
            document.documentElement.setAttribute("data-theme", t);
          }, theme);
          if (state === "review") {
            await page.getByTestId("import-file").setInputFiles(csv);
            await page.getByTestId("wizard-next").click();
            await page.getByTestId("import-errors").waitFor();
          } else {
            await page.getByTestId("tab-storage").click();
            await page.getByTestId("storage-size-text").waitFor();
            await page.getByTestId("trim-stock-TCS").waitFor();
          }
          await page.addScriptTag({ content: axeSource });
          const result = await page.evaluate(async () => {
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
          expect(result).toEqual([]);
        });
      }
    }
  }
});

// ---- review fixes (docs/07 UI-30, UI-31, UI-32) ------------------------------------------------

async function tabTo(page: Page, testId: string) {
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    if (id === testId) return;
  }
  throw new Error(`Tab never reached ${testId}`);
}

test("UI-30: the prices wizard is completable with the keyboard and focus lands on the result", async ({
  page,
}) => {
  await signIn(page);
  await mockApi(page);
  await page.goto("/imports");
  // The native file chooser is outside the page, so the file is attached programmatically.
  await page.getByTestId("import-file").setInputFiles(csv);
  await page.getByTestId("import-file").focus();
  await tabTo(page, "wizard-next");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Review the file" })).toBeFocused();
  await page.getByTestId("adjustment-raw").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("wizard-next")).toBeEnabled();
  await expect(page.getByTestId("adjustment-raw")).toBeFocused(); // focus survives the save
  await tabTo(page, "wizard-next");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Commit" })).toBeFocused();
  await tabTo(page, "wizard-commit");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("confirm-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("confirm-ok")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("import-result-heading")).toBeFocused();
  await expect(page.getByTestId("import-announce")).toContainText("batch 7");
});

test("UI-32: a double click on Commit sends exactly one POST and never shows 'expired'", async ({
  page,
}) => {
  await signIn(page);
  const counts = await mockApi(page);
  await page.goto("/imports");
  await page.getByTestId("import-file").setInputFiles(csv);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("adjustment-raw").check();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-commit").click();
  await page.getByTestId("confirm-ok").dblclick();
  await expect(page.getByTestId("import-result")).toContainText("batch 7");
  expect(counts["POST /imports/prices/commit"]).toBe(1);
  await expect(page.getByTestId("import-expired")).toHaveCount(0);
});

// UI-31: touch targets on /imports at 375 px, every tab and wizard state. Buttons and links with a
// data-testid must be 44 x 44; a radio or checkbox counts through its label (the hit area).
test.describe("UI-31 touch targets on the Import center at 375 px", () => {
  test.use({ viewport: { width: 375, height: 900 } });
  const measure = (page: Page) =>
    page.evaluate(() => {
      const small = (r: DOMRect) =>
        r.width > 0 && r.height > 0 && (r.width < 43.5 || r.height < 43.5);
      const out: string[] = [];
      for (const el of Array.from(
        document.querySelectorAll("button[data-testid], a[data-testid]"),
      )) {
        // Same justified exclusion as UI-26: the visually hidden skip link.
        if (el.getAttribute("data-testid") === "skip-link") continue;
        const r = el.getBoundingClientRect();
        if (small(r)) {
          out.push(
            `${el.getAttribute("data-testid")}: ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        }
      }
      for (const el of Array.from(
        document.querySelectorAll('input[type="radio"], input[type="checkbox"]'),
      )) {
        const label = el.closest("label");
        const r = (label ?? el).getBoundingClientRect();
        if (!label || small(r)) {
          out.push(`${el.getAttribute("data-testid")}: label ${Math.round(r.height)}px`);
        }
      }
      return out;
    });

  test("upload, templates, manual forms", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/imports");
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("tab-templates").click();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("tab-forms").click();
    expect(await measure(page)).toEqual([]);
  });

  test("storage tab with trim and delete previews", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/imports");
    await page.getByTestId("tab-storage").click();
    await page.getByTestId("trim-stock-TCS").waitFor();
    await page.getByTestId("trim-stock-TCS").check();
    await page.getByTestId("trim-before").fill("2021-01-01");
    await page.getByTestId("trim-preview").click();
    await page.getByTestId("trim-open-confirm").waitFor();
    await page.getByTestId("delete-symbol").fill("TCS");
    await page.getByTestId("delete-from").fill("2020-01-01");
    await page.getByTestId("delete-to").fill("2020-12-31");
    await page.getByTestId("delete-preview").click();
    await page.getByTestId("delete-open-confirm").waitFor();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("delete-open-confirm").click();
    expect(await measure(page)).toEqual([]);
  });

  test("review with the adjustment check, commit step, dialog and result", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/imports");
    await page.getByTestId("import-file").setInputFiles(csv);
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("adjustment-unknown").check();
    await page.getByTestId("check-run").waitFor();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("adjustment-raw").check();
    await expect(page.getByTestId("wizard-next")).toBeEnabled();
    await page.getByTestId("wizard-next").click();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("wizard-commit").click();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("confirm-ok").click();
    await page.getByTestId("import-another").waitFor();
    expect(await measure(page)).toEqual([]);
  });
});
