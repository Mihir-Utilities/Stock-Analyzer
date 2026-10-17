import { act, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockPath = "/";
vi.mock("next/navigation", () => ({ usePathname: () => mockPath }));
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

import LoginPage from "@/app/login/page";
import { WAKING_MESSAGE, WakingTracker } from "@/lib/api/waking";
import { ApiError } from "@/lib/api/client";
import { AppShell } from "@/components/shell/AppShell";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";
import { DISCLAIMER, Footer, MF_ATTRIBUTION } from "@/components/shell/Footer";
import { moreNav, primaryNav } from "@/components/shell/nav";
import { WakingBanner } from "@/components/shell/WakingBanner";
import { THEME_STORAGE_KEY } from "@/lib/theme/use-theme";

beforeEach(() => {
  mockPath = "/";
  document.documentElement.setAttribute("data-theme", "dark");
  localStorage.clear();
});

// SAF-03: footer/disclaimer on every page; MF pages show the AMFI/mfapi attribution.
describe("footer disclaimer (SAF-03)", () => {
  it("uses the exact copy from docs/06 section 9", () => {
    expect(DISCLAIMER).toBe(
      "Personal research tool. Data may be delayed, incomplete or wrong. Not investment advice.",
    );
    expect(MF_ATTRIBUTION).toBe("NAV data: AMFI via mfapi.in.");
  });

  it.each([
    "/",
    "/stocks",
    "/stocks/M%26M",
    "/portfolio",
    "/settings",
    "/admin/status",
    "/imports",
  ])("is present inside the shell on %s without MF attribution", (path) => {
    mockPath = path;
    render(<AppShell>content</AppShell>);
    expect(screen.getByTestId("app-disclaimer").textContent).toBe(DISCLAIMER);
    expect(screen.queryByTestId("mf-attribution")).toBeNull();
  });

  it.each(["/mf", "/mf/119551", "/mf/compare"])(
    "shows the AMFI/mfapi attribution on %s",
    (path) => {
      mockPath = path;
      render(<AppShell>content</AppShell>);
      expect(screen.getByTestId("app-disclaimer")).toBeTruthy();
      expect(screen.getByTestId("mf-attribution").textContent).toBe(MF_ATTRIBUTION);
    },
  );

  it("does not treat /mfx as an MF page", () => {
    render(<Footer pathname="/mfx" />);
    expect(screen.queryByTestId("mf-attribution")).toBeNull();
  });

  it("is present on the login page, which has no shell", () => {
    render(<LoginPage />);
    expect(screen.getByTestId("app-disclaimer").textContent).toBe(DISCLAIMER);
  });
});

describe("shell navigation (docs/06 section 2)", () => {
  it("lists every route in the sidebar and the bottom tabs", () => {
    render(<AppShell>content</AppShell>);
    const sidebar = screen.getByTestId("sidebar");
    for (const item of [...primaryNav, ...moreNav]) {
      expect(within(sidebar).getByTestId(`sidebar-${item.testId}`).getAttribute("href")).toBe(
        item.href,
      );
    }
    const tabs = screen.getByTestId("bottom-tabs");
    for (const item of primaryNav) {
      expect(within(tabs).getByTestId(`tab-${item.testId}`).getAttribute("href")).toBe(item.href);
    }
    expect(within(tabs).getByTestId("tab-more")).toBeTruthy();
  });

  it("opens the More menu with the remaining routes", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.queryByTestId("more-menu")).toBeNull();
    fireEvent.click(screen.getByTestId("tab-more"));
    const menu = screen.getByTestId("more-menu");
    for (const item of moreNav) {
      expect(within(menu).getByTestId(`more-${item.testId}`).getAttribute("href")).toBe(item.href);
    }
  });

  it("marks the current route and nested routes", () => {
    mockPath = "/stocks/TCS";
    render(<AppShell>content</AppShell>);
    expect(screen.getByTestId("sidebar-nav-stocks").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("sidebar-nav-home").getAttribute("aria-current")).toBeNull();
  });

  it("shows the market status placeholder as unknown, not a guess", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.getByTestId("market-status-pill").textContent).toContain("—");
  });

  it("collapses and expands the sidebar and remembers it", () => {
    render(<AppShell>content</AppShell>);
    const btn = screen.getByTestId("sidebar-collapse");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(screen.getByTestId("sidebar-collapse").getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("analyzer-sidebar-collapsed")).toBe("1");
  });
});

describe("theme toggle", () => {
  it("switches data-theme and stores the choice", () => {
    render(<AppShell>content</AppShell>);
    fireEvent.click(screen.getByTestId("theme-toggle"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    fireEvent.click(screen.getByTestId("theme-toggle"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("waking banner (UI-01)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("appears after 3 s with the exact copy and elapsed seconds, then disappears", () => {
    const tracker = new WakingTracker();
    render(<WakingBanner tracker={tracker} />);
    expect(screen.queryByTestId("waking-banner")).toBeNull();
    let done = () => undefined as void;
    act(() => {
      done = tracker.begin();
    });
    act(() => {
      vi.advanceTimersByTime(2_900);
    });
    expect(screen.queryByTestId("waking-banner")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    const banner = screen.getByTestId("waking-banner");
    expect(banner.textContent).toContain(WAKING_MESSAGE);
    expect(WAKING_MESSAGE).toBe(
      "Waking up the server. This can take up to a minute on the free plan.",
    );
    expect(screen.getByTestId("waking-elapsed").textContent).toBe("5 s");
    act(() => done());
    expect(screen.queryByTestId("waking-banner")).toBeNull();
  });
});

describe("error boundary", () => {
  function Boom({ error }: { error: Error }): ReactNode {
    throw error;
  }

  it("shows message, request id and Retry, and recovers on Retry", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let fail = true;
    function Flaky() {
      if (fail) throw new ApiError("INTERNAL", "Server error", 500, undefined, "req-77");
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary label="Price card">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Price card could not be shown.");
    expect(screen.getByTestId("error-request-id").textContent).toBe("req-77");
    fail = false;
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(screen.getByText("recovered")).toBeTruthy();
    spy.mockRestore();
  });

  it("does not echo the raw message of an unexpected exception", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom error={new Error("token=abc123 secret")} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).not.toContain("abc123");
    spy.mockRestore();
  });

  it("one failing card leaves its sibling intact", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <>
        <ErrorBoundary label="A">
          <Boom error={new Error("x")} />
        </ErrorBoundary>
        <ErrorBoundary label="B">
          <p>sibling ok</p>
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByText("sibling ok")).toBeTruthy();
    spy.mockRestore();
  });
});

describe("interactive elements carry data-testid (CLAUDE.md section 3)", () => {
  it("every button and link in the shell has one", () => {
    render(<AppShell>content</AppShell>);
    fireEvent.click(screen.getByTestId("tab-more"));
    const els = [...document.querySelectorAll("a, button")];
    expect(els.length).toBeGreaterThan(10);
    expect(els.filter((e) => !e.getAttribute("data-testid")).map((e) => e.outerHTML)).toEqual([]);
  });
});

// Structural a11y in jsdom (no layout, so colour contrast is checked from tokens in theme.test.ts
// and in a real browser in tests/e2e). UI-04 / Lighthouse proxy.
describe("axe (structure) in both themes", () => {
  it.each(["dark", "light"])("%s theme has no violations", async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.lang = "en";
    document.title = "Test";
    render(<AppShell>content</AppShell>);
    fireEvent.click(screen.getByTestId("tab-more"));
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`),
    ).toEqual([]);
  });
});
