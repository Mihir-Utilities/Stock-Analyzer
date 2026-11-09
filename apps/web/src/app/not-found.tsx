import Link from "next/link";
import { AppShell } from "@/components/shell/AppShell";

const LINK =
  "touch-target inline-flex h-11 items-center rounded-control border border-border bg-surface-2 px-4 text-body-sm font-medium text-text-1 no-underline hover:bg-surface-3";

// Unknown route. Rendered inside the shell so the footer disclaimer is on every page (SAF-03);
// the symbol-specific not-found with search (docs/06 section 2) comes with the stock screens.
export default function NotFound() {
  return (
    <AppShell>
      <h1 data-testid="not-found-title" className="text-page font-semibold text-text-1">
        Page not found
      </h1>
      <p className="mt-2 text-body text-text-2">
        This page does not exist or is not built yet. Use Search to find a stock or fund.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link href="/" data-testid="not-found-home" className={LINK}>
          Go to Home
        </Link>
        <Link href="/stocks" data-testid="not-found-stocks" className={LINK}>
          Browse Stocks
        </Link>
      </div>
    </AppShell>
  );
}
