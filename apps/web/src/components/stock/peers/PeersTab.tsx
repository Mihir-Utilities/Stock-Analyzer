"use client";

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { StockProfile } from "@/lib/stock/schemas";

export const PEERS_NOT_BUILT_REASON =
  "Peer comparison is not available yet: the peers service (task B13) is not built, and it needs the scoring work that is on hold. No peer figures are shown or estimated here.";

export const PEERS_NEEDS_SECTOR =
  "Import sector data to see peers. Peers are chosen from the sector and industry you import for each stock.";

/**
 * Peers tab (docs/06 6.4). `GET /stocks/{symbol}/peers` is not built (B13, D05b held), so the
 * tab does not call it: it says so and points at the import that will feed it (F08-4).
 */
export function PeersTab({ profile }: { profile: StockProfile }) {
  const hasSector = Boolean(profile.sector);
  return (
    <Card title="Peers" testId="peers-card">
      <div data-testid="peers-unavailable">
        <EmptyState
          message={hasSector ? PEERS_NOT_BUILT_REASON : PEERS_NEEDS_SECTOR}
          action={
            <Link
              href="/imports"
              data-testid="peers-import-link"
              className="touch-target inline-flex items-center text-body-sm text-accent underline"
            >
              Import sector data
            </Link>
          }
        />
        {hasSector ? (
          <p className="text-center text-caption text-text-2" data-testid="peers-sector">
            Sector on file: {profile.sector}
            {profile.industry ? `, industry ${profile.industry}` : ""}. {PEERS_NEEDS_SECTOR}
          </p>
        ) : (
          <p className="text-center text-caption text-text-2">{PEERS_NOT_BUILT_REASON}</p>
        )}
      </div>
    </Card>
  );
}
