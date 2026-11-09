import Link from "next/link";

const LINK =
  "touch-target inline-flex h-11 items-center rounded-control border border-border bg-surface-2 px-4 text-body-sm font-medium text-text-1 no-underline hover:bg-surface-3";

/**
 * Honest placeholder for a screen whose server side is not built. It makes no request, so it can
 * never show fake data or call an endpoint that answers 501.
 */
export function NotAvailable({
  testId,
  title,
  waitingFor,
}: {
  testId: string;
  title: string;
  /** Exactly what this screen waits for. */
  waitingFor: string;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <h1 className="text-title font-semibold text-text-1" data-testid={`${testId}-title`}>
        {title}
      </h1>
      <p className="max-w-prose text-body text-text-2" role="status" data-testid={`${testId}-note`}>
        Not available yet. {waitingFor}
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/" data-testid={`${testId}-home`} className={LINK}>
          Go to Home
        </Link>
        <Link href="/stocks" data-testid={`${testId}-stocks`} className={LINK}>
          Browse Stocks
        </Link>
      </div>
    </div>
  );
}
