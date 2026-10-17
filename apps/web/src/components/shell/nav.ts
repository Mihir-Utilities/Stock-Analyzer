// Navigation model (docs/06-frontend-spec.md section 2): desktop sidebar / mobile bottom tabs.

export interface NavItem {
  href: string;
  label: string;
  testId: string;
  icon:
    | "home"
    | "stocks"
    | "funds"
    | "portfolio"
    | "compare"
    | "screener"
    | "alerts"
    | "watchlist"
    | "imports"
    | "settings"
    | "admin";
}

/** Primary entries: the four bottom tabs plus "More". */
export const primaryNav: readonly NavItem[] = [
  { href: "/", label: "Home", testId: "nav-home", icon: "home" },
  { href: "/stocks", label: "Stocks", testId: "nav-stocks", icon: "stocks" },
  { href: "/mf", label: "Funds", testId: "nav-funds", icon: "funds" },
  { href: "/portfolio", label: "Portfolio", testId: "nav-portfolio", icon: "portfolio" },
];

/** Behind the "More" tab on mobile; listed in full in the desktop sidebar. */
export const moreNav: readonly NavItem[] = [
  { href: "/compare", label: "Compare", testId: "nav-compare", icon: "compare" },
  { href: "/screener", label: "Screener", testId: "nav-screener", icon: "screener" },
  { href: "/alerts", label: "Alerts", testId: "nav-alerts", icon: "alerts" },
  { href: "/watchlist", label: "Watchlist", testId: "nav-watchlist", icon: "watchlist" },
  { href: "/imports", label: "Imports", testId: "nav-imports", icon: "imports" },
  { href: "/settings", label: "Settings", testId: "nav-settings", icon: "settings" },
  { href: "/admin/status", label: "Admin", testId: "nav-admin", icon: "admin" },
];

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
