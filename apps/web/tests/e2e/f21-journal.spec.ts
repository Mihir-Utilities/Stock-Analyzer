import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { setTheme } from "./theme";
import * as ix from "../mocks/inv-fixtures";
import type { MockReply } from "../mocks/imports-fixtures";
import { ok } from "../mocks/imports-fixtures";
import * as fx from "../mocks/stock-fixtures";

// F21 (JRN-30, ALS-09): the Journal tab and the alert shortcuts in a real browser, API mocked:
// axe in both themes at 375 and 1440 px, keyboard-only paths, no horizontal page scroll. No clock
// dependence: the mock decides what is due and what "today" is.

const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");

async function signIn(page: Page) {
  await page
    .context()
    .addCookies([{ name: "session", value: "e2e-placeholder", domain: "127.0.0.1", path: "/" }]);
}

function reply(route: Route, r: MockReply, extra: Record<string, string> = {}) {
  return route.fulfill({
    status: r.status,
    contentType: "application/json",
    headers: extra,
    body: JSON.stringify(r.body),
  });
}

type Row = Record<string, unknown>;

const baseNote = (id: number, over: Row = {}): Row => ({
  id,
  symbol: "TCS",
  noted_on: "2026-11-01",
  note: `Bought because margins recover. <b>not bold</b> note ${id}`,
  price_at_note: "3500.0000",
  price_as_of: "2026-10-30",
  price_source: "your imported prices",
  price_reason: null,
  review_on: "2026-11-10",
  status: "open",
  reviewed_at: null,
  review_due: true,
  portfolio_txn_id: 42,
  txn: { id: 42, side: "buy", qty: "10.0000", price: "3500.0000", trade_date: "2026-09-01" },
  ...over,
});

interface Calls {
  journalPosts: Row[];
  patches: Row[];
  deletes: string[];
  alertPosts: Row[];
}

async function mockApi(page: Page, opts: { notes?: Row[] } = {}): Promise<Calls> {
  const calls: Calls = { journalPosts: [], patches: [], deletes: [], alertPosts: [] };
  let notes = opts.notes ?? [baseNote(2), baseNote(1, { review_due: false, review_on: null })];
  let nextId = 10;
  await page.route("**/api/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    const method = req.method();
    const body = req.postData() ? (JSON.parse(req.postData() ?? "{}") as Row) : {};
    if (method === "GET" && path === "/stocks/TCS/journal") {
      return reply(
        route,
        ok({
          items: notes,
          next_cursor: null,
          today: "2026-11-12",
          review_due_count: notes.filter((n) => n["review_due"] === true).length,
        }),
      );
    }
    if (method === "POST" && path === "/stocks/TCS/journal") {
      calls.journalPosts.push({ ...body, key: req.headers()["idempotency-key"] ?? "" });
      const created = baseNote(nextId++, {
        note: body["note"],
        review_on: body["review_on"] ?? null,
        review_due: false,
        portfolio_txn_id: null,
        txn: null,
        noted_on: "2026-11-12",
      });
      notes = [created, ...notes];
      return reply(route, ok(created, 201));
    }
    const m = /^\/journal\/(\d+)$/.exec(path);
    if (m && method === "PATCH") {
      calls.patches.push(body);
      const id = Number(m[1]);
      notes = notes.map((n) =>
        n["id"] === id
          ? {
              ...n,
              ...body,
              review_due: false,
              reviewed_at: body["status"] === "reviewed" ? "2026-11-12T10:00:00Z" : null,
            }
          : n,
      );
      return reply(route, ok(notes.find((n) => n["id"] === id)));
    }
    if (m && method === "DELETE") {
      calls.deletes.push(m[1] ?? "");
      notes = notes.filter((n) => String(n["id"]) !== m[1]);
      return reply(route, ok({ id: Number(m[1]), deleted: true }));
    }
    if (method === "POST" && path === "/alerts") {
      calls.alertPosts.push(body);
      return reply(
        route,
        ok(
          {
            id: 1,
            target: { type: "stock", symbol: "TCS", name: "TCS" },
            kind: body["kind"],
            params: body["params"],
            status: "active",
            one_shot: true,
            cooldown_minutes: 1440,
            expires_on: null,
            last_fired_at: null,
            created_at: "2026-11-12T04:00:00Z",
          },
          201,
        ),
      );
    }
    const routes: Record<string, MockReply> = {
      "GET /stocks/TCS": fx.profile(),
      "GET /stocks/TCS/prices": fx.prices({ n: 70 }),
      "GET /stocks/TCS/indicators": ix.indicatorsWithInv(),
      "GET /stocks/TCS/events": fx.events,
      "GET /stocks/TCS/links": fx.links,
      "GET /stocks/TCS/fundamentals": fx.fundamentalsNotComputed,
      "GET /portfolio/txns": ok({
        items: [
          {
            id: 42,
            symbol: "TCS",
            name: "TCS",
            side: "buy",
            qty: "10.0000",
            price: "3500.0000",
            fees: "0.0000",
            trade_date: "2026-09-01",
            note: null,
          },
        ],
        next_cursor: null,
      }),
      "GET /alerts/events": ok({ items: [], next_cursor: null }),
      "GET /broker/status": ok({ enabled: false, mode: "manual" }),
    };
    const key = `${method} ${path}`;
    return reply(
      route,
      routes[key] ?? { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: key } } },
    );
  });
  return calls;
}

async function axeViolations(page: Page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
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
}

async function noPageScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

async function smallTargets(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "button[data-testid], a[data-testid], input[data-testid], select[data-testid], textarea[data-testid]",
      ),
    )
      .filter((el) => el.getAttribute("data-testid") !== "skip-link")
      .map((el) => ({ id: el.getAttribute("data-testid"), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 43.5 || x.r.height < 43.5))
      .map((x) => `${x.id}: ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
  );
}

const activeId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");

test.describe("Journal tab", () => {
  test.use({ bypassCSP: true });

  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`axe, list and open form: ${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/stocks/TCS?tab=journal");
        await setTheme(page, theme);
        await expect(page.getByTestId("jrn-list")).toBeVisible();
        await expect(page.getByTestId("jrn-due-count")).toContainText("1 review due");
        // hostile text is shown as text
        await expect(page.getByTestId("jrn-text-2")).toContainText("<b>not bold</b>");
        expect(await page.locator('[data-testid="jrn-text-2"] b').count()).toBe(0);
        expect(await axeViolations(page)).toEqual([]);
        await page.getByTestId("jrn-add").click();
        await expect(page.getByTestId("jrn-form")).toBeVisible();
        await setTheme(page, theme);
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) {
          await noPageScroll(page);
          expect(await smallTargets(page)).toEqual([]);
        }
      });

      test(`axe, empty state: ${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page, { notes: [] });
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/stocks/TCS?tab=journal");
        await setTheme(page, theme);
        await expect(page.getByTestId("jrn-empty")).toBeVisible();
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) {
          await noPageScroll(page);
          expect(await smallTargets(page)).toEqual([]);
        }
      });
    }
  }

  test("keyboard path: add a note, mark it reviewed, delete it with the confirmation", async ({
    page,
  }) => {
    await signIn(page);
    const calls = await mockApi(page, { notes: [] });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stocks/TCS?tab=journal");
    await expect(page.getByTestId("jrn-empty")).toBeVisible();

    await page.getByTestId("jrn-add").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("jrn-form")).toBeVisible();
    expect(await activeId(page)).toBe("jrn-note");
    await page.keyboard.type("Quality franchise, buying the dip");
    await page.keyboard.press("Tab"); // review date
    expect(await activeId(page)).toBe("jrn-review-on");
    await page.keyboard.type("12122026"); // native date input, month-day-year segments
    await page.getByTestId("jrn-submit").focus();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("jrn-list")).toBeVisible();
    await expect(page.getByTestId("jrn-live")).toContainText("Note added");
    expect(await activeId(page)).toBe("jrn-add");
    expect(calls.journalPosts).toHaveLength(1);
    expect(calls.journalPosts[0]!["note"]).toBe("Quality franchise, buying the dip");
    expect(String(calls.journalPosts[0]!["key"])).toMatch(/^[0-9a-f-]{36}$/);

    const id = 10;
    await page.getByTestId(`jrn-toggle-${id}`).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId(`jrn-status-${id}`)).toContainText("Reviewed");
    await expect(page.getByTestId("jrn-live")).toContainText("Marked reviewed");
    expect(await activeId(page)).toBe(`jrn-toggle-${id}`);

    await page.getByTestId(`jrn-delete-${id}`).focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator('dialog[data-testid="confirm-dialog"][open]');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("confirm-ok").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("jrn-empty")).toBeVisible();
    expect(calls.deletes).toEqual(["10"]);
    await expect(page.getByTestId("jrn-live")).toContainText("Note deleted");
    await expect.poll(() => activeId(page)).toBe("jrn-add");
  });
});

test.describe("Alert shortcuts in the Analysis tab", () => {
  test.use({ bypassCSP: true });

  for (const theme of ["dark", "light"] as const) {
    for (const width of [375, 1440]) {
      test(`axe, card and open form: ${theme} at ${width}`, async ({ page }) => {
        await signIn(page);
        await mockApi(page);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/stocks/TCS?tab=analysis");
        await setTheme(page, theme);
        await expect(page.getByTestId("als-card")).toHaveAttribute("data-state", "ready");
        await expect(page.getByTestId("als-btn-below-10")).toBeVisible();
        for (const c of await page.getByTestId("chart-canvas").all()) {
          await expect(c).toHaveAttribute("data-ready", "true");
        }
        await setTheme(page, theme);
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) expect(await smallTargets(page)).toEqual([]); // the card, before the drawer
        await page.getByTestId("als-btn-below-10").click();
        await expect(page.getByTestId("alert-form")).toBeVisible();
        await setTheme(page, theme);
        expect(await axeViolations(page)).toEqual([]);
        if (width === 375) await noPageScroll(page);
      });
    }
  }

  test("keyboard path: Enter opens the form with the level, Enter creates, Escape cancels", async ({
    page,
  }) => {
    await signIn(page);
    const calls = await mockApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stocks/TCS?tab=analysis");
    const btn = page.getByTestId("als-btn-below-10");
    await expect(btn).toBeVisible();

    await btn.focus();
    await page.keyboard.press("Enter");
    const form = page.getByTestId("alert-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("alert-symbol")).toHaveValue("TCS");
    await expect(page.getByTestId("alert-kind")).toHaveValue("price_below");
    await expect(page.getByTestId("alert-param-price")).toHaveValue("13.50");
    await page.keyboard.press("Escape");
    await expect(form).toBeHidden();
    expect(calls.alertPosts).toHaveLength(0);
    await expect.poll(() => activeId(page)).toBe("als-btn-below-10");

    await page.keyboard.press("Enter");
    await expect(form).toBeVisible();
    await page.getByTestId("alert-submit").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Alert created.")).toBeVisible();
    await expect(form).toBeHidden();
    expect(calls.alertPosts).toEqual([
      {
        target: { type: "stock", symbol: "TCS" },
        kind: "price_below",
        params: { price: 13.5 },
        one_shot: true,
      },
    ]);
    await expect.poll(() => activeId(page)).toBe("als-btn-below-10");
  });
});
