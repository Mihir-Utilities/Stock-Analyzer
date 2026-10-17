"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Footer } from "./Footer";
import { icons, NavIcon } from "./icons";
import { MarketStatusPill } from "./MarketStatusPill";
import { isActive, moreNav, primaryNav, type NavItem } from "./nav";
import { ThemeToggle } from "./ThemeToggle";
import { WakingBanner } from "./WakingBanner";

// Responsive shell, docs/06a section 3.4. Desktop (>= 1024): sidebar 232 px (collapsible to 64),
// top bar 56 px. Below that: top bar 52 px plus a 56 px bottom tab bar with safe-area insets.

const COLLAPSE_KEY = "analyzer-sidebar-collapsed";

function NavLink({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const active = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      data-testid={`sidebar-${item.testId}`}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={`flex h-10 items-center gap-3 rounded-control px-3 text-body ${
        active
          ? "bg-accent-weak font-medium text-text-1"
          : "text-text-2 hover:bg-surface-2 hover:text-text-1"
      } ${collapsed ? "justify-center" : ""}`}
    >
      {/* Accent only on the icon: accent text on accent-weak is below 4.5:1 in the light theme (OQ-16). */}
      <span className={active ? "text-accent" : ""}>
        <NavIcon name={item.icon} />
      </span>
      <span className={collapsed ? "sr-only" : ""}>{item.label}</span>
    </Link>
  );
}

function Sidebar({ pathname }: { pathname: string }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      // Restoring a saved preference after hydration; no external subscription is involved.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* storage blocked */
    }
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* storage blocked */
      }
      return !c;
    });
  };
  const Toggle = collapsed ? icons.PanelLeftOpen : icons.PanelLeftClose;
  return (
    <aside
      data-testid="sidebar"
      className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-surface-1 desktop:flex ${
        collapsed ? "w-16" : "w-58"
      }`}
    >
      <div className="flex h-14 items-center px-4 text-section font-semibold text-text-1">
        <span className={collapsed ? "sr-only" : ""}>Analyzer</span>
      </div>
      <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {[...primaryNav, ...moreNav].map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
        ))}
      </nav>
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        data-testid="sidebar-collapse"
        className="m-2 flex h-10 items-center justify-center rounded-control text-text-2 hover:bg-surface-2 hover:text-text-1"
      >
        <Toggle size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </aside>
  );
}

function BottomTabs({ pathname }: { pathname: string }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = moreNav.some((i) => isActive(pathname, i.href));
  const tab = (active: boolean) =>
    `flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-caption ${
      active ? "text-accent" : "text-text-2"
    }`;
  return (
    <>
      {moreOpen ? (
        <div
          data-testid="more-menu"
          className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-surface-1 p-2 desktop:hidden"
        >
          <ul className="grid grid-cols-2 gap-1">
            {moreNav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  data-testid={`more-${item.testId}`}
                  onClick={() => setMoreOpen(false)}
                  aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  className="flex h-11 items-center gap-2 rounded-control px-3 text-body text-text-1 hover:bg-surface-2"
                >
                  <NavIcon name={item.icon} />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <nav
        aria-label="Primary"
        data-testid="bottom-tabs"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface-1 pb-[env(safe-area-inset-bottom)] desktop:hidden"
      >
        {primaryNav.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={`tab-${item.testId}`}
              aria-current={active ? "page" : undefined}
              className={tab(active)}
            >
              <NavIcon name={item.icon} />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          data-testid="tab-more"
          className={tab(moreActive || moreOpen)}
        >
          <icons.Ellipsis size={20} strokeWidth={1.75} aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        data-testid="skip-link"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-surface-1 focus:px-3 focus:py-2 focus:text-text-1"
      >
        Skip to content
      </a>
      <Sidebar pathname={pathname} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-testid="topbar"
          className="sticky top-0 z-20 flex h-13 items-center justify-between gap-2 border-b border-border bg-surface-1 px-4 desktop:h-14 desktop:px-6"
        >
          <span className="truncate text-section font-semibold text-text-1 desktop:invisible">
            Analyzer
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <MarketStatusPill />
            <ThemeToggle />
          </div>
        </header>
        <WakingBanner />
        <main
          id="main"
          tabIndex={-1}
          data-testid="main"
          className="mx-auto w-full max-w-[1440px] min-w-0 flex-1 px-4 py-4 pb-24 desktop:px-6 desktop:py-6 desktop:pb-6"
        >
          {children}
        </main>
        <div className="pb-16 desktop:pb-0">
          <Footer pathname={pathname} />
        </div>
      </div>
      <BottomTabs pathname={pathname} />
    </div>
  );
}
