import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AlertsPage } from "@/components/alerts/AlertsPage";
import { TelegramCard } from "@/components/alerts/TelegramCard";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { SessionMenu } from "@/components/shell/SessionMenu";
import { apiRequest, setUnauthorizedHandler } from "@/lib/api/client";
import { signOut } from "@/lib/auth/session";
import { RECENT_KEY } from "@/lib/search/store";
import { fail, ok } from "../mocks/imports-fixtures";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import "./dom-matchers";

// Review of F12 (F12R-1..F12R-6). Fixed instants only; timers are faked.
const NOW = "2026-10-24T09:00:00Z";
const EXPIRES = "2026-10-24T09:15:00Z";
const me = (linked: boolean) => ok({ authenticated: true, telegram_linked: linked, prefs: {} });
const linkCode = () =>
  ok({
    code: "A7K9-Q2XM",
    expires_at: EXPIRES,
    bot_username: "my_bot",
    deep_link: "https://t.me/my_bot?start=A7K9Q2XM",
  });

function renderWith(ui: React.ReactElement, routes: Record<string, Handler>) {
  const mock = createMockFetch({
    "GET /alerts": ok({ items: [], next_cursor: null }),
    "GET /alerts/events": ok({ items: [], next_cursor: null }),
    "GET /auth/me": me(false),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { mock, client, view };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe("F12R-3 link-code polling", () => {
  it("a new code restarts the 2 minute polling window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    const { mock } = renderWith(<TelegramCard />, { "POST /telegram/link-code": linkCode() });
    fireEvent.click(await screen.findByTestId("telegram-make-code"));
    await screen.findByTestId("telegram-code");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(110_000);
    });
    fireEvent.click(screen.getByTestId("telegram-make-code")); // second code at 1:50
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.path === "/telegram/link-code")).toHaveLength(2),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000); // 2:50 since the first code, 1:00 since the second
    });
    expect(screen.getByTestId("telegram-waiting")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000); // past 2:00 since the second code
    });
    expect(screen.queryByTestId("telegram-waiting")).toBeNull();
    expect(screen.getByTestId("telegram-check-again")).toBeInTheDocument();
  });

  it("stops asking /auth/me when the card unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    const { mock, view } = renderWith(<TelegramCard />, {
      "POST /telegram/link-code": linkCode(),
    });
    fireEvent.click(await screen.findByTestId("telegram-make-code"));
    await screen.findByTestId("telegram-code");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    view.unmount();
    const before = mock.calls.filter((c) => c.path === "/auth/me").length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mock.calls.filter((c) => c.path === "/auth/me")).toHaveLength(before);
  });

  it("announces the link and explains that a second chat cannot take over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    let n = 0;
    renderWith(<TelegramCard />, {
      "POST /telegram/link-code": linkCode(),
      "GET /auth/me": () => me(++n >= 2),
    });
    fireEvent.click(await screen.findByTestId("telegram-make-code"));
    await screen.findByTestId("telegram-code");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByTestId("telegram-linked")).toBeInTheDocument();
    expect(screen.getByTestId("telegram-note")).toHaveTextContent(/now linked/);
    expect(screen.getByTestId("telegram-one-chat")).toHaveTextContent(/unlink this one first/);
  });
});

describe("F12R-1/2 sign-out data handling", () => {
  it("clears recent searches and silences late 401 redirects once the server agreed", async () => {
    localStorage.setItem(RECENT_KEY, '[{"kind":"stock","key":"TCS"}]');
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const go = vi.fn();
    await signOut(false, {
      request: (async () => ({ ok: true })) as never,
      clear: () => undefined,
      go,
    });
    expect(localStorage.getItem(RECENT_KEY)).toBeNull();
    expect(go).toHaveBeenCalledWith("/login");
    // A request that fails with 401 afterwards must not call the (now silenced) handler.
    vi.stubGlobal(
      "fetch",
      createMockFetch({ "GET /x": fail(401, "UNAUTHENTICATED", "gone") }).impl,
    );
    await apiRequest("/x", { schema: z.unknown() }).catch(() => undefined);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a failed sign-out keeps recents and the handler", async () => {
    localStorage.setItem(RECENT_KEY, "[]");
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(
      signOut(false, {
        request: (async () => Promise.reject(new Error("net"))) as never,
        clear: () => undefined,
        go: () => undefined,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(localStorage.getItem(RECENT_KEY)).toBe("[]");
    vi.stubGlobal(
      "fetch",
      createMockFetch({ "GET /x": fail(401, "UNAUTHENTICATED", "gone") }).impl,
    );
    await apiRequest("/x", { schema: z.unknown() }).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("F12R-5 account menu keyboard", () => {
  it("Escape closes the menu and returns focus to its button; a press outside closes it", async () => {
    renderWith(<SessionMenu />, {});
    const user = userEvent.setup();
    const button = screen.getByTestId("session-menu-button");
    await user.click(button);
    expect(button).toHaveAttribute("aria-controls", "session-menu");
    expect(screen.getByTestId("session-menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("session-menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("session-menu")).toBeNull();
  });

  it("Sign out everywhere moves focus to Cancel and back to the opener", async () => {
    renderWith(<SessionMenu />, {});
    const user = userEvent.setup();
    await user.click(screen.getByTestId("session-menu-button"));
    await user.click(screen.getByTestId("logout-all"));
    expect(document.activeElement).toBe(screen.getByTestId("logout-all-cancel"));
    await user.click(screen.getByTestId("logout-all-cancel"));
    expect(document.activeElement).toBe(screen.getByTestId("logout-all"));
  });

  it("a failed Sign out everywhere in Settings closes the dialog so the error is visible", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderWith(<SettingsPage />, { "POST /auth/logout-all": fail(500, "INTERNAL", "boom") });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("settings-logout-all"));
    const dialog = await waitFor(() => {
      const d = document.querySelector('dialog[data-testid="confirm-dialog"][open]');
      if (!d) throw new Error("no dialog");
      return d as HTMLElement;
    });
    await user.click(within(dialog).getByTestId("confirm-ok"));
    expect(await screen.findByTestId("settings-logout-error")).toBeInTheDocument();
    expect(document.querySelector('dialog[data-testid="confirm-dialog"][open]')).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("F12R-6 focus moves to the first invalid field", () => {
  it("alert form", async () => {
    renderWith(<AlertsPage />, {});
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("alert-new"));
    await user.click(await screen.findByTestId("alert-submit"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("alert-symbol")));
  });

  it("password form", async () => {
    renderWith(<SettingsPage />, {});
    const user = userEvent.setup();
    await user.click(screen.getByTestId("password-submit"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("password-current")),
    );
  });
});
