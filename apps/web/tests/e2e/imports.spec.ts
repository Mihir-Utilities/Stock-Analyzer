import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
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
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    switch (key) {
      case "GET /admin/status":
        return reply(route, dbStatus(330));
      case "POST /imports/prices/validate":
        return reply(route, ok(prices));
      case "PUT /settings/prices-adjustment":
        return reply(route, ok({ value: false, set_at: "2026-10-24T09:00:00Z" }));
      case "POST /imports/prices/commit":
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
