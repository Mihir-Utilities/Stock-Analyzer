import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertsPage } from "@/components/alerts/AlertsPage";
import { TelegramCard } from "@/components/alerts/TelegramCard";
import { SessionMenu } from "@/components/shell/SessionMenu";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { fail, ok } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler, type RecordedCall } from "../mocks/mock-fetch";
import "./dom-matchers";

const NOW = "2026-10-24T09:00:00Z";
const EXPIRES = "2026-10-24T09:15:00Z";

const alertRow = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});
const page = (items: unknown[]) => ok({ items, next_cursor: null });
const me = (linked: boolean) => ok({ authenticated: true, telegram_linked: linked, prefs: {} });
const linkCode = (botConfigured = true) =>
  ok({
    code: "A7K9-Q2XM",
    expires_at: EXPIRES,
    bot_username: botConfigured ? "my_bot" : null,
    deep_link: botConfigured ? "https://t.me/my_bot?start=A7K9Q2XM" : null,
  });

function renderWith(ui: React.ReactElement, routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /alerts": page([alertRow()]),
    "GET /alerts/events": page([]),
    "GET /auth/me": me(false),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { mock, client, view };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The confirm button of the dialog that is open (closed dialogs stay in the DOM). */
function openConfirm(): HTMLElement {
  const d = document.querySelector('dialog[data-testid="confirm-dialog"][open]');
  if (!d) throw new Error("no open confirm dialog");
  return within(d as HTMLElement).getByTestId("confirm-ok");
}

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("alert-new"));
  return screen.findByTestId("alert-form");
}

describe("ALR-01 create alert and THRESHOLD_ALREADY_MET", () => {
  it("shows the list with mapped labels and decimal-safe condition text", async () => {
    renderWith(<AlertsPage />, {});
    const row = await screen.findByTestId("alert-row");
    expect(row).toHaveTextContent("TCS: Price above");
    expect(row).toHaveTextContent("Price at or above ₹4,000.50");
    expect(row).not.toHaveTextContent(/price_above|one_shot/);
    expect(screen.getByTestId("alerts-basis-note")).toHaveTextContent(/last price import/);
    expect(screen.getByTestId("alert-limit-note")).toHaveTextContent(/200/);
  });

  it("sends the typed price as an exact JSON number and the CSRF header", async () => {
    const { mock } = renderWith(<AlertsPage />, { "POST /alerts": ok(alertRow(), 201) });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByTestId("alert-symbol"), "TCS");
    await user.type(screen.getByTestId("alert-param-price"), "4000.1");
    await user.click(screen.getByTestId("alert-submit"));
    await waitFor(() => expect(mock.calls.some((c) => c.method === "POST")).toBe(true));
    const post = mock.calls.find(
      (c) => c.method === "POST" && c.path === "/alerts",
    ) as RecordedCall;
    expect(post.body).toEqual({
      target: { type: "stock", symbol: "TCS" },
      kind: "price_above",
      params: { price: 4000.1 },
      one_shot: true,
    });
    expect(post.headers.get("X-Requested-With")).toBe("fetch");
    await waitFor(() =>
      expect(screen.getByTestId("alerts-result")).toHaveTextContent("Alert created."),
    );
    expect(document.activeElement).toBe(screen.getByTestId("alerts-result"));
  });

  it("shows THRESHOLD_ALREADY_MET inline at the price field", async () => {
    renderWith(<AlertsPage />, {
      "POST /alerts": fail(422, "THRESHOLD_ALREADY_MET", "Threshold already true", {
        kind: "price_above",
        threshold: 4000,
        value: 4123.5,
        as_of: "2026-10-23",
      }),
    });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByTestId("alert-symbol"), "TCS");
    await user.type(screen.getByTestId("alert-param-price"), "4000");
    await user.click(screen.getByTestId("alert-submit"));
    const err = await screen.findByTestId("form-field-error");
    expect(err).toHaveTextContent("last imported bar of 23 Oct 2026");
    expect(err).toHaveTextContent("₹4,123.50");
    expect(screen.getByTestId("alert-param-price")).toHaveAttribute("aria-invalid", "true");
  });

  it("blocks bad input locally and never calls the API", async () => {
    const { mock } = renderWith(<AlertsPage />, {});
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByTestId("alert-param-price"), "abc");
    await user.click(screen.getByTestId("alert-submit"));
    const errs = await screen.findAllByTestId("form-field-error");
    expect(errs.length).toBe(2); // symbol and price
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("shows the 200-active limit for a 409 CONFLICT", async () => {
    renderWith(<AlertsPage />, { "POST /alerts": fail(409, "CONFLICT", "limit") });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByTestId("alert-symbol"), "TCS");
    await user.type(screen.getByTestId("alert-param-price"), "4000");
    await user.click(screen.getByTestId("alert-submit"));
    expect(await screen.findByTestId("alert-form-error")).toHaveTextContent(/200 active alerts/);
  });

  it("changes the fields with the kind and uses a scheme code for NAV alerts", async () => {
    renderWith(<AlertsPage />, {});
    const user = userEvent.setup();
    await openCreate(user);
    await user.selectOptions(screen.getByTestId("alert-kind"), "ma_cross");
    expect(screen.getByTestId("alert-param-fast")).toBeInTheDocument();
    expect(screen.getByTestId("alert-param-direction")).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId("alert-kind"), "wk52_high");
    expect(screen.getByTestId("alert-no-params")).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId("alert-kind"), "nav_above");
    expect(screen.getByTestId("alert-code")).toBeInTheDocument();
    expect(screen.queryByTestId("alert-symbol")).toBeNull();
  });

  it("a double click on Create sends one request", async () => {
    let n = 0;
    const { mock } = renderWith(<AlertsPage />, {
      "POST /alerts": () => {
        n += 1;
        return ok(alertRow(), 201);
      },
    });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByTestId("alert-symbol"), "TCS");
    await user.type(screen.getByTestId("alert-param-price"), "4000");
    const submit = screen.getByTestId("alert-submit");
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(n).toBe(1));
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("alert list actions", () => {
  it("pauses an active alert and deletes with a confirmation", async () => {
    const { mock } = renderWith(<AlertsPage />, {
      "PATCH /alerts/7": ok(alertRow({ status: "paused" })),
      "DELETE /alerts/7": ok({ ok: true }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("alert-toggle"));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "paused" }),
    );
    await user.click(screen.getByTestId("alert-delete"));
    await waitFor(() => openConfirm());
    await user.click(openConfirm());
    await waitFor(() => expect(mock.calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("edit changes only the parameters", async () => {
    const { mock } = renderWith(<AlertsPage />, { "PATCH /alerts/7": ok(alertRow()) });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("alert-edit"));
    const price = (await screen.findByTestId("alert-param-price")) as HTMLInputElement;
    expect(price.value).toBe("4000.5");
    expect(screen.getByTestId("alert-kind")).toBeDisabled();
    await user.clear(price);
    await user.type(price, "4200");
    await user.click(screen.getByTestId("alert-submit"));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PATCH")?.body).toEqual({
        params: { price: 4200 },
      }),
    );
  });

  it("history maps delivery statuses and held reasons, and quiet hours say not available", async () => {
    renderWith(<AlertsPage />, {
      "GET /alerts/events": page([
        {
          id: 1,
          alert_id: 7,
          kind: "price_above",
          target: { type: "stock", symbol: "TCS" },
          fired_at: "2026-10-23T14:00:00Z",
          payload: {},
          delivery_status: "skipped_quiet_hours",
          delivery_attempts: 0,
          delivered_at: null,
          last_error: "quiet_hours",
        },
      ]),
    });
    const ev = await screen.findByTestId("alert-event");
    expect(ev).toHaveTextContent("Skipped (quiet hours)");
    expect(ev).toHaveTextContent("Held until quiet hours end");
    expect(ev).not.toHaveTextContent(/skipped_quiet_hours|quiet_hours/);
    expect(screen.getByTestId("quiet-hours-card")).toHaveTextContent(/Not available yet/);
  });

  it("shows an honest state when alerts are a 501 stub", async () => {
    renderWith(<AlertsPage />, { "GET /alerts": fail(501, "NOT_IMPLEMENTED", "stub") });
    expect(await screen.findByText(/not available on the server yet/)).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { view } = renderWith(<AlertsPage />, {});
    await screen.findByTestId("alert-row");
    const r = await axe.run(view.container, {
      rules: { "color-contrast": { enabled: false }, "heading-order": { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("ALR-05 / ALR-16 Telegram card", () => {
  it("not linked, bot not configured: code shown without deep link and says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    renderWith(<TelegramCard />, { "POST /telegram/link-code": linkCode(false) });
    fireEvent.click(await screen.findByTestId("telegram-make-code"));
    expect(await screen.findByTestId("telegram-code")).toHaveTextContent("A7K9-Q2XM");
    expect(screen.getByTestId("telegram-bot-missing")).toHaveTextContent(/bot is not set up/);
    expect(screen.queryByTestId("telegram-deep-link")).toBeNull();
    expect(screen.getByTestId("telegram-countdown")).toHaveTextContent(/Expires in (15:00|14:59)/);
    expect(document.activeElement).toBe(screen.getByTestId("telegram-code-heading"));
  });

  it("countdown ticks locally without extra requests and the code disappears at expiry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    const { mock } = renderWith(<TelegramCard />, { "POST /telegram/link-code": linkCode() });
    fireEvent.click(await screen.findByTestId("telegram-make-code"));
    expect(await screen.findByTestId("telegram-deep-link")).toHaveAttribute(
      "href",
      "https://t.me/my_bot?start=A7K9Q2XM",
    );
    expect(screen.getByTestId("telegram-deep-link")).toHaveAttribute("rel", "noopener noreferrer");
    await act(async () => {
      vi.setSystemTime(new Date("2026-10-24T09:05:01Z"));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("telegram-countdown")).toHaveTextContent(
      /Expires in (10:00|9:5[89])/,
    );
    await act(async () => {
      vi.setSystemTime(new Date("2026-10-24T09:15:01Z"));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByTestId("telegram-code")).toBeNull();
    expect(screen.getByTestId("telegram-not-linked")).toHaveTextContent(/code expired/);
    // Only /auth/me polling runs (every 3 s), never a link-code call per tick.
    expect(mock.calls.filter((c) => c.path === "/telegram/link-code")).toHaveLength(1);
  });

  it("polls /auth/me every 3 s and switches to linked, dropping the code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    let meCalls = 0;
    renderWith(<TelegramCard />, {
      "POST /telegram/link-code": linkCode(),
      "GET /auth/me": () => {
        meCalls += 1;
        return me(meCalls >= 3);
      },
    });
    fireEvent.click(await screen.findByTestId("telegram-make-code"));
    await screen.findByTestId("telegram-code");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(screen.getByTestId("telegram-code")).toBeInTheDocument(); // still waiting
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByTestId("telegram-linked")).toBeInTheDocument();
    expect(screen.queryByTestId("telegram-code")).toBeNull();
  });

  it("keeps waiting through a failed poll (cold start) and offers Check again after 2 minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    let meCalls = 0;
    renderWith(<TelegramCard />, {
      "POST /telegram/link-code": linkCode(),
      "GET /auth/me": () => {
        meCalls += 1;
        return meCalls === 2 ? fail(503, "SOURCE_DOWN", "waking") : me(false);
      },
    });
    fireEvent.click(await screen.findByTestId("telegram-make-code"));
    await screen.findByTestId("telegram-code");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6200);
    });
    expect(screen.getByTestId("telegram-code")).toBeInTheDocument();
    expect(screen.queryByTestId("telegram-me-error")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121_000);
    });
    // 2 minutes passed: polling stopped (code may have expired at 15 min only later).
    expect(screen.getByTestId("telegram-check-again")).toBeInTheDocument();
  });

  it("linked: test message, rate limit text, and unlink with confirmation", async () => {
    let tests = 0;
    const { mock } = renderWith(<TelegramCard />, {
      "GET /auth/me": me(true),
      "POST /telegram/test": () => {
        tests += 1;
        return tests === 1 ? ok({ ok: true }) : fail(429, "RATE_LIMITED", "slow", undefined);
      },
      "DELETE /telegram/link": ok({ ok: true }),
    });
    const user = userEvent.setup();
    await screen.findByTestId("telegram-linked");
    await user.click(screen.getByTestId("telegram-test"));
    await waitFor(() =>
      expect(screen.getByTestId("telegram-note")).toHaveTextContent(/Test message sent/),
    );
    await user.click(screen.getByTestId("telegram-test"));
    expect(await screen.findByTestId("telegram-test-error")).toHaveTextContent(/Try again/);
    await user.click(screen.getByTestId("telegram-unlink"));
    await waitFor(() => openConfirm());
    await user.click(openConfirm());
    await waitFor(() => expect(mock.calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(mock.calls.find((c) => c.method === "DELETE")?.headers.get("X-Requested-With")).toBe(
      "fetch",
    );
  });

  it("the code is never written to storage or the console", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    renderWith(<TelegramCard />, { "POST /telegram/link-code": linkCode() });
    fireEvent.click(await screen.findByTestId("telegram-make-code"));
    await screen.findByTestId("telegram-code");
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("A7K9");
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});

describe("settings and sign-out (SEC)", () => {
  it("password change: policy errors locally, success clears the fields and focuses the result", async () => {
    const { mock } = renderWith(<SettingsPage />, {
      "POST /auth/change-password": ok({ ok: true }),
    });
    const user = userEvent.setup();
    await user.type(screen.getByTestId("password-current"), "old-password-1");
    await user.type(screen.getByTestId("password-new"), "short");
    await user.type(screen.getByTestId("password-confirm"), "short");
    await user.click(screen.getByTestId("password-submit"));
    expect(await screen.findAllByTestId("form-field-error")).not.toHaveLength(0);
    expect(mock.calls.filter((c) => c.path === "/auth/change-password")).toHaveLength(0);
    await user.clear(screen.getByTestId("password-new"));
    await user.clear(screen.getByTestId("password-confirm"));
    await user.type(screen.getByTestId("password-new"), "new-password-12");
    await user.type(screen.getByTestId("password-confirm"), "new-password-12");
    await user.click(screen.getByTestId("password-submit"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("password-result-heading")),
    );
    expect(mock.calls.find((c) => c.path === "/auth/change-password")?.body).toEqual({
      current: "old-password-1",
      new: "new-password-12",
    });
    expect((screen.getByTestId("password-current") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("password-new") as HTMLInputElement).value).toBe("");
  });

  it("wrong current password shows the server's field error", async () => {
    renderWith(<SettingsPage />, {
      "POST /auth/change-password": fail(422, "VALIDATION_ERROR", "bad", {
        fields: [{ field: "current", message: "Current password is wrong" }],
      }),
    });
    const user = userEvent.setup();
    await user.type(screen.getByTestId("password-current"), "wrong");
    await user.type(screen.getByTestId("password-new"), "new-password-12");
    await user.type(screen.getByTestId("password-confirm"), "new-password-12");
    await user.click(screen.getByTestId("password-submit"));
    expect(await screen.findByText("Current password is wrong")).toBeInTheDocument();
  });

  it("settings lists unavailable features with a reason, never a fake control", async () => {
    renderWith(<SettingsPage />, {});
    expect(screen.getByTestId("sessions-unavailable")).toHaveTextContent(/not available yet/);
    expect(screen.getByTestId("export-card")).toHaveTextContent(/Not available yet/);
    expect(screen.getByTestId("display-unavailable")).toHaveTextContent(/not available yet/);
    expect(screen.queryByText(/broker/i)).toBeNull();
  });

  it("logout posts with the CSRF header, clears the cache and goes to /login", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { mock, client } = renderWith(<SessionMenu />, { "POST /auth/logout": ok({ ok: true }) });
    client.setQueryData(["secret"], "x");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("session-menu-button"));
    await user.click(screen.getByTestId("logout"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    const call = mock.calls.find((c) => c.path === "/auth/logout") as RecordedCall;
    expect(call.method).toBe("POST");
    expect(call.headers.get("X-Requested-With")).toBe("fetch");
    expect(client.getQueryData(["secret"])).toBeUndefined();
  });

  it("logout-all asks first, then signs out everywhere; a 401 still ends at /login", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { mock } = renderWith(<SessionMenu />, {
      "POST /auth/logout-all": fail(401, "UNAUTHENTICATED", "gone"),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("session-menu-button"));
    await user.click(screen.getByTestId("logout-all"));
    expect(await screen.findByTestId("logout-all-confirm")).toBeInTheDocument();
    expect(mock.calls.filter((c) => c.path === "/auth/logout-all")).toHaveLength(0);
    await user.click(screen.getByTestId("logout-all-confirm"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("a failed logout stays on the page and says so", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderWith(<SessionMenu />, { "POST /auth/logout": fail(500, "INTERNAL", "boom") });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("session-menu-button"));
    await user.click(screen.getByTestId("logout"));
    expect(await screen.findByTestId("logout-error")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
