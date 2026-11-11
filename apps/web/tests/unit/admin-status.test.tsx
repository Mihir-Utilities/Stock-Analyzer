import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./dom-matchers";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import AdminStatusRoute from "@/app/(app)/admin/status/page";
import { AdminStatus } from "@/components/admin/AdminStatus";
import { createQueryClient } from "@/components/shell/Providers";
import {
  adminStatusFullSchema,
  extraSources,
  holidayWarning,
  isPaused,
  recentErrors,
  runDurationMs,
} from "@/lib/admin/schemas";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";

const ok = (data: unknown, meta: Record<string, unknown> = { as_of: "2026-10-23T10:00:00Z" }) => ({
  status: 200,
  body: { data, meta, warnings: [] },
});
const err = (status: number, code: string) => ({
  status,
  body: { error: { code, message: code } },
  headers: { "X-Request-Id": "req-9" },
});

const full = {
  sources: [
    {
      source: "mfapi",
      checked_at: "2026-10-23T09:00:00Z",
      ok: true,
      latency_ms: 850,
      consecutive_failures: 0,
      disabled_until: null,
      note: null,
    },
    {
      source: "amfi",
      checked_at: "2026-10-23T09:00:00Z",
      ok: false,
      latency_ms: 61_000,
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
      items_total: 100,
      items_failed: 0,
      error: null,
    },
    {
      job: "compute_analysis_for_a_really_long_job_name_that_must_be_cut_with_a_tooltip",
      started_at: "2026-10-23T08:00:00Z",
      finished_at: "2026-10-23T08:00:10Z",
      status: "failed",
      rows_written: 0,
      items_total: 5,
      items_failed: 5,
      error: "<img src=x onerror=alert(1)> boom",
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
    tables: [{ name: "price_daily", mb: 210.4, rows: 1_500_000 }],
    warn_level: "70",
  },
  holiday_list_missing_years: [2026, 2027],
  version: "abc1234",
  storage_policy: { db_soft_limit_mb: 380, note: "x", nested: { a: 1 } },
};

function mount(
  routes: Record<string, Handler>,
  ui: ReactNode = <AdminStatusRoute />,
  client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const mock = createMockFetch(routes);
  vi.stubGlobal("fetch", mock.impl);
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...view, mock };
}

// The instant the screen treats as "now" (before the amfi pause in `full` ends).
const NOW = Date.parse("2026-10-23T10:30:00Z");

afterEach(() => vi.unstubAllGlobals());

describe("Admin status screen (docs/06 section 6.12)", () => {
  it("loading state, then 501 says not available yet (B14) and never shows a number", async () => {
    mount({ "GET /admin/status": err(501, "NOT_IMPLEMENTED") });
    expect(screen.getByTestId("admin-loading")).toBeTruthy();
    const note = await screen.findByTestId("admin-status-na-note");
    expect(note).toHaveTextContent("Not available yet");
    expect(note).toHaveTextContent("B14");
    expect(screen.queryByTestId("admin-db")).toBeNull();
    expect(screen.getByTestId("admin-status-na-home")).toHaveAttribute("href", "/");
  });

  it("a 501 is asked once with the app default client (no retries) and shows at once (F15R-S2)", async () => {
    const t0 = Date.now();
    const { mock } = mount(
      { "GET /admin/status": err(501, "NOT_IMPLEMENTED") },
      undefined,
      createQueryClient(),
    );
    await screen.findByTestId("admin-status-na-note");
    expect(Date.now() - t0).toBeLessThan(900); // a retry would wait 1 s first
    expect(mock.calls).toHaveLength(1);
  });

  it("another failure shows an error card with the request id and a working retry", async () => {
    const { mock } = mount({ "GET /admin/status": err(500, "INTERNAL") });
    const card = await screen.findByTestId("admin-error");
    expect(card).toHaveTextContent("could not be loaded");
    expect(card).toHaveTextContent("req-9");
    expect(mock.calls).toHaveLength(1);
    screen.getByTestId("card-retry").click();
    await waitFor(() => expect(mock.calls).toHaveLength(2));
  });

  it("renders per-source cards, a card for a source without a row, and formats units", async () => {
    mount({ "GET /admin/status": ok(full) });
    const mf = await screen.findByTestId("admin-source-mfapi");
    expect(mf).toHaveTextContent("850 ms");
    // F15R-S4: the amfi pause ended on 23 Oct 2026 12:00Z; the default clock is later than that.
    expect(screen.getByTestId("admin-source-amfi")).toHaveTextContent("Not paused");
    expect(mf).toHaveTextContent("Not paused");
    const amfi = screen.getByTestId("admin-source-amfi");
    expect(amfi).toHaveTextContent("Failing");
    expect(amfi).toHaveTextContent("1 min 01 s");
    expect(amfi).toHaveTextContent("circuit open");
    // No row for telegram: an honest empty card, not zeros.
    expect(screen.getByTestId("admin-source-telegram")).toHaveTextContent(
      "No health check has been recorded",
    );
    // Source and as-of chips on a card.
    expect(mf).toHaveTextContent("API /admin/status");
    expect(mf).toHaveTextContent("As of 23 Oct 2026, 14:30 IST");
  });

  it("shows a persistent holiday warning per year with the exact copy", async () => {
    mount({ "GET /admin/status": ok(full) });
    await screen.findByTestId("admin-holidays");
    const warns = screen.getAllByTestId("admin-holiday-warning").map((n) => n.textContent);
    expect(warns).toEqual([
      "Holiday list missing for 2026: weekends only; import holidays.csv",
      "Holiday list missing for 2027: weekends only; import holidays.csv",
    ]);
    expect(holidayWarning(2026)).toBe(warns[0]);
    expect(screen.getAllByTestId("admin-holiday-import")[0]).toHaveAttribute("href", "/imports");
  });

  it("shows no holiday warning when every year has a list", async () => {
    mount({ "GET /admin/status": ok({ ...full, holiday_list_missing_years: [] }) });
    expect(await screen.findByTestId("admin-holidays-ok")).toBeTruthy();
    expect(screen.queryByTestId("admin-holiday-warning")).toBeNull();
  });

  it("coverage, DB meter with warn level, job rows and storage policy", async () => {
    mount({ "GET /admin/status": ok(full) });
    const cov = await screen.findByTestId("admin-coverage");
    expect(cov).toHaveTextContent("2,231");
    expect(cov).toHaveTextContent("401");
    const text = screen.getByTestId("admin-db-text");
    expect(text).toHaveTextContent("300.0 MB of 380 MB");
    expect(text).toHaveTextContent("78.9%");
    expect(text).toHaveTextContent("Warning level: 70%");
    const bar = screen.getByTestId("admin-db-bar");
    expect(bar).toHaveAttribute("data-level", "70");
    expect(bar).toHaveAttribute("aria-valuetext", "300.0 MB of 380 MB");
    expect(screen.getByTestId("admin-db-tables")).toHaveTextContent("210.4 MB");
    const rows = screen.getAllByTestId("admin-job-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("2 min 05 s");
    expect(rows[0]).toHaveTextContent("12,345");
    const policy = screen.getByTestId("admin-policy");
    expect(policy).toHaveTextContent("db_soft_limit_mb");
    expect(policy).toHaveTextContent("380");
    expect(policy.textContent).not.toContain("[object Object]");
    expect(screen.getByTestId("admin-version")).toHaveTextContent("abc1234");
  });

  it("computes the warning level itself when the server omits warn_level", async () => {
    mount({
      "GET /admin/status": ok({ ...full, db: { size_mb: 365, tables: [] } }),
    });
    const bar = await screen.findByTestId("admin-db-bar");
    expect(bar).toHaveAttribute("data-level", "95");
  });

  it("missing numbers show a dash with a reason, never 0, NaN or Infinity (UI-02)", async () => {
    mount({
      "GET /admin/status": ok({
        sources: [{ source: "mfapi" }],
        jobs: [{ job: "j", status: "running", started_at: "2026-10-23T08:00:00Z" }],
        coverage: { instruments: null },
        db: {},
        version: null,
      }),
    });
    const mf = await screen.findByTestId("admin-source-mfapi");
    expect(mf).toHaveTextContent("—");
    expect(mf.querySelector('[title="not reported by the server"]')).toBeTruthy();
    const row = screen.getByTestId("admin-job-row");
    expect(row.querySelector('[title="still running"]')).toBeTruthy();
    const covValues = [...screen.getByTestId("admin-coverage").querySelectorAll("dd")].map(
      (n) => n.textContent,
    );
    expect(covValues).toEqual(["—", "—", "—", "—", "—"]);
    expect(screen.getByTestId("admin-db")).toHaveTextContent("did not report the database size");
    expect(screen.getByTestId("admin-version")).toHaveTextContent("not reported by the server");
    const all = screen.getByTestId("admin-status").textContent ?? "";
    expect(all).not.toMatch(/NaN|Infinity|undefined|null/);
  });

  it("recent errors list failed runs and escape server text (SEC-11)", async () => {
    mount({ "GET /admin/status": ok(full) });
    const text = await screen.findByTestId("admin-error-text");
    expect(text.textContent).toBe("<img src=x onerror=alert(1)> boom");
    expect(text.querySelector("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("UI-08: a long job name is truncated with its full text as a tooltip", async () => {
    mount({ "GET /admin/status": ok(full) });
    await screen.findByTestId("admin-jobs-table");
    const long = within(screen.getByTestId("admin-jobs-table")).getByText(/^compute_analysis_for/);
    expect(long.className).toContain("truncate");
    expect(long.getAttribute("title")).toBe(long.textContent);
  });

  it("has no run-job buttons (v1) and no axe violations in the loaded state", async () => {
    const { container } = mount({ "GET /admin/status": ok(full) });
    await screen.findByTestId("admin-jobs-table");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("F15R-B1 wildcard-mapped admin fields really render their value", () => {
  // Each `GET /admin/status` field that docs/field-map.json maps to a wildcard id (admin-source-*)
  // must show its own value inside that card, not just own a matching test id.
  const EXPECT: Record<string, string> = {
    sources: "Source: amfi",
    "sources[].source": "Source: amfi",
    "sources[].checked_at": "As of 23 Oct 2026, 14:30 IST",
    "sources[].ok": "Failing",
    "sources[].latency_ms": "1 min 01 s",
    "sources[].consecutive_failures": "3",
    "sources[].disabled_until": "23 Oct 2026, 17:30 IST",
    "sources[].note": "circuit open",
  };

  it("every wildcard-mapped field is covered by this table and its text appears", async () => {
    const map = JSON.parse(
      readFileSync(join(process.cwd(), "../../docs/field-map.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    const wildcard = Object.entries(map["GET /admin/status"] ?? {})
      .filter(([, id]) => id.split("|")[0]!.includes("*"))
      .map(([field]) => field);
    expect(wildcard.sort()).toEqual(Object.keys(EXPECT).sort());
    mount({ "GET /admin/status": ok(full) }, <AdminStatus now={NOW} />);
    const card = await screen.findByTestId("admin-source-amfi");
    for (const [field, text] of Object.entries(EXPECT)) {
      expect(card.textContent, field).toContain(text);
    }
  });
});

describe("F15R-S4 Paused until only while the pause is in the future", () => {
  it("shows the date while disabled_until is after now and Not paused once it has passed", async () => {
    mount({ "GET /admin/status": ok(full) }, <AdminStatus now={NOW} />);
    const amfi = await screen.findByTestId("admin-source-amfi");
    expect(amfi).toHaveTextContent("Paused until");
    expect(amfi).toHaveTextContent("23 Oct 2026, 17:30 IST");
    expect(amfi).not.toHaveTextContent("Not paused");
    cleanup();
    mount(
      { "GET /admin/status": ok(full) },
      <AdminStatus now={Date.parse("2026-10-23T12:00:01Z")} />,
    );
    expect(await screen.findByTestId("admin-source-amfi")).toHaveTextContent("Not paused");
  });

  it("isPaused is false for null, a bad date and a past date", () => {
    expect(isPaused(null, NOW)).toBe(false);
    expect(isPaused("not a date", NOW)).toBe(false);
    expect(isPaused("2026-10-23T10:30:00Z", NOW)).toBe(false);
    expect(isPaused("2026-10-23T10:30:01Z", NOW)).toBe(true);
  });
});

describe("F15R-S3 one unexpected value does not blank the page", () => {
  it("an unknown warn_level, a string latency and a broken job row degrade only their own part", async () => {
    mount({
      "GET /admin/status": ok({
        ...full,
        db: { size_mb: 300, warn_level: "critical", tables: [{ name: "t", mb: "x", rows: 1 }, 7] },
        sources: [
          { source: "mfapi", latency_ms: "fast", ok: true },
          { source: "broker", ok: false, note: "dormant", consecutive_failures: 2 },
          "garbage",
        ],
        jobs: [{ job: "ok_job", status: "ok", rows_written: 5 }, { status: "ok" }],
      }),
    });
    const db = await screen.findByTestId("admin-db-bar");
    expect(db).toHaveAttribute("data-level", "70"); // derived from 300 / 380
    expect(screen.getByTestId("admin-source-mfapi")).toHaveTextContent("Status");
    expect(screen.getAllByTestId("admin-job-row")).toHaveLength(1);
    // The broker row is kept and shown as its own card.
    const broker = screen.getByTestId("admin-source-broker");
    expect(broker).toHaveTextContent("Failing");
    expect(broker).toHaveTextContent("dormant");
    expect(screen.queryByTestId("admin-error")).toBeNull();
  });

  it("a wrong type for a whole block (coverage as a string) shows that card's empty state only", async () => {
    mount({ "GET /admin/status": ok({ ...full, coverage: "oops", jobs: 5 }) });
    expect(await screen.findByTestId("admin-coverage")).toHaveTextContent(
      "did not report coverage",
    );
    expect(screen.getByTestId("admin-jobs")).toHaveTextContent("No job has run yet");
    expect(screen.getByTestId("admin-db-text")).toBeTruthy();
  });

  it("the schema keeps unknown sources", () => {
    const r = adminStatusFullSchema.parse({ sources: [{ source: "broker" }, { source: "mfapi" }] });
    expect(extraSources(r.sources ?? []).map((x) => x.source)).toEqual(["broker"]);
  });
});

describe("F15R nits", () => {
  it("the server db_soft_limit_mb drives the meter; the largest tables are sorted and capped", async () => {
    const tables = Array.from({ length: 14 }, (_, i) => ({ name: `t${i}`, mb: i, rows: i }));
    mount({
      "GET /admin/status": ok({
        ...full,
        db: { size_mb: 200, tables },
        storage_policy: { db_soft_limit_mb: 400 },
      }),
    });
    const text = await screen.findByTestId("admin-db-text");
    expect(text).toHaveTextContent("200.0 MB of 400 MB (50.0%)");
    const names = [...screen.getByTestId("admin-db-tables").querySelectorAll("tbody th")].map(
      (n) => n.textContent,
    );
    expect(names).toHaveLength(10);
    expect(names[0]).toBe("t13");
    expect(names[9]).toBe("t4");
  });

  it("a long error text is cut to 500 characters", async () => {
    const long = "x".repeat(900);
    const jobs = [{ job: "j", status: "failed", error: long, finished_at: "2026-10-23T08:00:00Z" }];
    mount({ "GET /admin/status": ok({ ...full, jobs }) });
    const t = await screen.findByTestId("admin-error-text");
    expect(t.textContent).toHaveLength(501);
    expect(t.textContent?.endsWith("…")).toBe(true);
  });

  it("the loading and error states keep heading levels h1, h2, h3 in order", async () => {
    mount({ "GET /admin/status": err(500, "INTERNAL") });
    expect(screen.getByRole("heading", { level: 2, name: "Data health" })).toBeTruthy();
    await screen.findByTestId("admin-error");
    const levels = screen.getAllByRole("heading").map((h) => h.tagName);
    expect(levels).toEqual(["H1", "H2", "H3"]);
  });

  it("recentErrors orders by real time, not by string, across offsets", () => {
    const out = recentErrors([
      { job: "early", status: "failed", error: "e", finished_at: "2026-01-01T10:00:00+05:30" },
      { job: "late", status: "failed", error: "e", finished_at: "2026-01-01T06:00:00Z" },
    ]);
    // 10:00 IST is 04:30Z, so "late" (06:00Z) is newer although its string sorts lower.
    expect(out.map((j) => j.job)).toEqual(["late", "early"]);
  });
});

describe("admin helpers", () => {
  it("runDurationMs needs both timestamps and a non-negative span", () => {
    expect(runDurationMs({ job: "a", started_at: "2026-01-01T00:00:00Z" })).toBeNull();
    expect(
      runDurationMs({
        job: "a",
        started_at: "2026-01-01T00:00:10Z",
        finished_at: "2026-01-01T00:00:00Z",
      }),
    ).toBeNull();
    expect(
      runDurationMs({
        job: "a",
        started_at: "2026-01-01T00:00:00Z",
        finished_at: "2026-01-01T00:00:02Z",
      }),
    ).toBe(2000);
  });
  it("recentErrors keeps failed or partial runs with an error text, newest first, at most 50", () => {
    const jobs = Array.from({ length: 60 }, (_, i) => ({
      job: `j${i}`,
      status: "failed",
      error: "e",
      finished_at: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
    }));
    const out = recentErrors([...jobs, { job: "ok", status: "ok", error: "ignored" }]);
    expect(out).toHaveLength(50);
    expect(out[0]?.job).toBe("j59");
  });
});
