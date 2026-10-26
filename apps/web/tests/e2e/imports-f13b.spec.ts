import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { commitOk, dbStatus, ok, stockIndex, type MockReply } from "../mocks/imports-fixtures";

// F13b: remaining wizards, manual forms and the Batches tab. The API is not running in e2e; every
// /api/v1 call is answered from contract-shaped fixtures (docs/03 section 14).

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

const validResults = {
  upload_id: "55555555-5555-4555-8555-555555555555",
  upload_group: null,
  rows: 12,
  preview: [{ symbol: "TCS", basis: "consolidated", period_end: "2026-09-30", revenue: 1000 }],
  errors: [],
  warnings: [],
  error_count: 0,
  warning_count: 0,
  estimated_growth_mb: null,
  prices_already_adjusted: null,
};

const manualOk = { batch_id: 21, inserted: 3, updated: 1, warnings: [], post_import_job_id: 5 };

async function mockApi(page: Page) {
  const counts: Record<string, number> = {};
  let undone = false;
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const key = `${req.method()} ${path}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const now = new Date().toISOString();
    switch (key) {
      case "GET /admin/status":
        return reply(route, dbStatus(100));
      case "GET /stocks/index":
        return reply(route, stockIndex);
      case "POST /imports/results_quarterly/validate":
      case "POST /imports/holidays/validate":
        return reply(route, ok(validResults));
      case "POST /imports/results_quarterly/commit":
        await new Promise((r) => setTimeout(r, 300));
        return reply(route, ok(commitOk));
      case "GET /imports/batches":
        return reply(
          route,
          ok({
            items: [
              {
                id: 9,
                kind: "results_quarterly",
                upload_group: null,
                row_count: 24,
                warning_count: 0,
                note: "as per filing dated 2026-10-12",
                created_at: now,
                undone_at: undone ? now : null,
              },
              {
                id: 8,
                kind: "prices",
                upload_group: null,
                row_count: 900,
                warning_count: 0,
                note: null,
                created_at: now,
                undone_at: null,
              },
              {
                id: 7,
                kind: "manual_form",
                upload_group: null,
                row_count: 3,
                warning_count: 0,
                note: null,
                created_at: now,
                undone_at: null,
              },
            ],
            next_cursor: null,
          }),
        );
      case "POST /imports/batches/9/undo":
        await new Promise((r) => setTimeout(r, 300));
        undone = true;
        return reply(
          route,
          ok({
            batch_id: 9,
            removed: 24,
            post_import_job_id: 3,
            warnings: ["UNDO_REMOVES_EARLIER_IMPORT"],
            earlier_batch_ids: [4],
          }),
        );
      case "POST /stocks/TCS/results":
      case "POST /stocks/TCS/shareholding":
      case "POST /stocks/TCS/actions":
        await new Promise((r) => setTimeout(r, 300));
        return reply(route, ok(manualOk, 201));
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
  name: "results.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("symbol,basis,period_end,revenue\nTCS,consolidated,2026-09-30,1000\n"),
};

test("results wizard, commit, then undo from the Batches tab (IMP-14, IMP-44)", async ({
  page,
}) => {
  await signIn(page);
  const counts = await mockApi(page);
  await page.goto("/imports");
  await page.getByTestId("import-kind-results_quarterly").check();
  await page.getByTestId("import-file").setInputFiles(csv);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("import-summary").waitFor();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-commit").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("You can undo it for 30 days");
  await page.getByTestId("confirm-ok").dblclick();
  await expect(page.getByTestId("import-result-heading")).toBeFocused();
  await expect(page.getByTestId("result-undo-note")).toContainText("Batches tab");
  expect(counts["POST /imports/results_quarterly/commit"]).toBe(1);

  await page.getByTestId("tab-batches").click();
  await page.getByTestId("batches-table").waitFor();
  await expect(page.getByTestId("batch-undo-9")).toBeVisible();
  await expect(page.getByTestId("batch-undo-8")).toHaveCount(0);
  await expect(page.getByTestId("batch-undo-7")).toHaveCount(0);
  await page.getByTestId("batch-undo-9").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("not restored");
  await page.getByTestId("confirm-ok").dblclick();
  await expect(page.getByTestId("undo-result-heading")).toBeFocused();
  await expect(page.getByTestId("undo-warning-UNDO_REMOVES_EARLIER_IMPORT")).toContainText(
    "Earlier batches: 4",
  );
  expect(counts["POST /imports/batches/9/undo"]).toBe(1);
  await expect(page.getByTestId("batch-undone-9")).toBeVisible();
});

async function tabTo(page: Page, testId: string) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    if (id === testId) return;
  }
  throw new Error(`Tab never reached ${testId}`);
}

test("the manual results form is completable with the keyboard alone; a double Enter saves once", async ({
  page,
}) => {
  await signIn(page);
  const counts = await mockApi(page);
  await page.goto("/imports");
  await tabTo(page, "tab-upload");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("tab-forms")).toBeFocused();
  await page.keyboard.press("Enter");
  await tabTo(page, "tab-stock");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("tab-results")).toBeFocused();
  await page.keyboard.press("Enter");
  await tabTo(page, "results-symbol");
  await page.keyboard.type("TCS");
  await tabTo(page, "results-period-end");
  await page.keyboard.type("30-Sep-2026");
  await tabTo(page, "results-revenue");
  await page.keyboard.type("1,234.5");
  await tabTo(page, "results-submit");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("results-saved-heading")).toBeFocused();
  expect(counts["POST /stocks/TCS/results"]).toBe(1);
});

test("a decimal comma is refused in the browser with the offending value", async ({ page }) => {
  await signIn(page);
  const counts = await mockApi(page);
  await page.goto("/imports");
  await page.getByTestId("tab-forms").click();
  await page.getByTestId("tab-results").click();
  await page.getByTestId("results-symbol").fill("TCS");
  await page.getByTestId("results-period-end").fill("2026-09-30");
  await page.getByTestId("results-revenue").fill("1234,56");
  await page.getByTestId("results-submit").click();
  await expect(page.getByTestId("form-field-error").first()).toContainText('"1234,56"');
  expect(counts["POST /stocks/TCS/results"]).toBeUndefined();
});

// ---- UI-41 touch targets (extends UI-31) and axe on the new screens -------------------------

test.describe("UI-41 touch targets on the F13b screens at 375 px", () => {
  test.use({ viewport: { width: 375, height: 900 } });
  const measure = (page: Page) =>
    page.evaluate(() => {
      const small = (r: DOMRect) =>
        r.width > 0 && r.height > 0 && (r.width < 43.5 || r.height < 43.5);
      const out: string[] = [];
      for (const el of Array.from(
        document.querySelectorAll("button[data-testid], a[data-testid]"),
      )) {
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

  test("upload kinds, templates, every manual form with a saved result", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/imports");
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("tab-templates").click();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("tab-forms").click();
    for (const [tab, form] of [
      ["results", "results"],
      ["shareholding", "shareholding"],
      ["action", "action"],
    ] as const) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.getByTestId(`${form}-symbol`).fill("TCS");
      expect(await measure(page)).toEqual([]);
    }
    await page.getByTestId("tab-results").click();
    await page.getByTestId("results-symbol").fill("TCS");
    await page.getByTestId("results-period-end").fill("2026-09-30");
    await page.getByTestId("results-revenue").fill("100");
    await page.getByTestId("results-submit").click();
    await page.getByTestId("results-saved").waitFor();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("results-delete").click();
    expect(await measure(page)).toEqual([]);
  });

  test("batches tab, undo dialog and undo result", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/imports");
    await page.getByTestId("tab-batches").click();
    await page.getByTestId("batches-table").waitFor();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("batch-undo-9").click();
    expect(await measure(page)).toEqual([]);
    await page.getByTestId("confirm-ok").click();
    await page.getByTestId("undo-result").waitFor();
    expect(await measure(page)).toEqual([]);
  });

  test("holidays and results wizard review and result", async ({ page }) => {
    await signIn(page);
    await mockApi(page);
    await page.goto("/imports");
    await page.getByTestId("import-kind-holidays").check();
    await page.getByTestId("import-file").setInputFiles(csv);
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("import-holidays-note").waitFor();
    expect(await measure(page)).toEqual([]);
  });
});

test.describe("axe on the F13b screens", () => {
  test.use({ bypassCSP: true });
  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      for (const state of ["results-form", "action-form", "batches", "undo-result"] as const) {
        test(`${theme} ${state} at ${width}`, async ({ page }) => {
          await signIn(page);
          await mockApi(page);
          await page.setViewportSize({ width, height: 900 });
          await page.goto("/imports");
          await page.evaluate((t) => {
            localStorage.setItem("analyzer-theme", t);
            document.documentElement.setAttribute("data-theme", t);
          }, theme);
          if (state === "results-form" || state === "action-form") {
            await page.getByTestId("tab-forms").click();
            await page
              .getByTestId(`tab-${state === "results-form" ? "results" : "action"}`)
              .click();
            await page.getByTestId(state).waitFor();
            if (state === "results-form") {
              await page.getByTestId("results-submit").click();
              await page.getByTestId("results-values-error").waitFor();
            }
          } else {
            await page.getByTestId("tab-batches").click();
            await page.getByTestId("batches-table").waitFor();
            if (state === "undo-result") {
              await page.getByTestId("batch-undo-9").click();
              await page.getByTestId("confirm-ok").click();
              await page.getByTestId("undo-result").waitFor();
            }
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
