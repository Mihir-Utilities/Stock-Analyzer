"use client";

import { useRef, useState } from "react";
import { AlertForm } from "@/components/alerts/AlertForm";
import { Card } from "@/components/ui/Card";
import { Drawer, useToast } from "@/components/ui/overlays";
import { prefillFor, shortcutRows, type ShortcutKey } from "@/lib/alerts/levels";
import type { Block, InvBlocks, Position } from "@/lib/stock/inv-schemas";
import type { SwingDips } from "@/lib/stock/swing-schemas";
import type { IndicatorsData } from "@/lib/stock/schemas";
import type { Load } from "@/lib/stock/load";

type IndLoad = Load<IndicatorsData>;

const BUTTON =
  "touch-target inline-flex items-center rounded-control border border-border px-3 py-2 text-left text-body-sm hover:bg-surface-3";

function Rows({
  symbol,
  position,
  swing,
}: {
  symbol: string;
  position: Position;
  swing: Block<SwingDips> | undefined;
}) {
  const toast = useToast();
  const rows = shortcutRows(position, swing);
  const [open, setOpen] = useState<ShortcutKey | null>(null);
  const triggers = useRef<Partial<Record<ShortcutKey, HTMLButtonElement | null>>>({});
  const current = rows.find((r) => r.key === open) ?? null;
  const prefill = current ? prefillFor(symbol, current) : null;

  const close = () => {
    const key = open;
    setOpen(null);
    if (key) setTimeout(() => triggers.current[key]?.focus(), 0);
  };

  return (
    <>
      <ul className="flex flex-col gap-3" data-testid="als-list">
        {rows.map((r) => (
          <li
            key={r.key}
            data-testid={`als-row-${r.key}`}
            className="flex flex-col gap-1 rounded-control border border-border p-3"
          >
            <p className="text-body-sm font-medium text-text-1" data-testid={`als-label-${r.key}`}>
              {r.label}
              {r.action ? `: ${r.action.level}` : ""}
            </p>
            {r.source ? (
              <p className="text-caption text-text-2" data-testid={`als-source-${r.key}`}>
                {r.source}
              </p>
            ) : null}
            {r.action ? (
              <button
                type="button"
                ref={(el) => {
                  triggers.current[r.key] = el;
                }}
                data-testid={`als-btn-${r.key}`}
                className={BUTTON}
                onClick={() => setOpen(r.key)}
              >
                {r.action.button}
              </button>
            ) : (
              <p className="text-body-sm text-text-2" data-testid={`als-reason-${r.key}`}>
                {r.reason}
              </p>
            )}
          </li>
        ))}
      </ul>
      <Drawer open={open !== null} title="Create alert" onClose={close}>
        <div data-testid="als-drawer">
          {open !== null && prefill ? (
            <AlertForm
              key={open}
              prefill={prefill}
              onDone={(message) => {
                toast(message);
                close();
              }}
            />
          ) : null}
        </div>
      </Drawer>
    </>
  );
}

/**
 * Alert shortcuts (docs/06 6.4b): levels taken from facts already on this tab. The buttons open the
 * normal create-alert form with the level filled in; the server rules (THRESHOLD_ALREADY_MET, the
 * 200 active limit) are the ones of a hand-typed alert.
 */
export function AlertShortcuts({
  symbol,
  load,
  blocks,
  swing,
}: {
  symbol: string;
  load: IndLoad;
  blocks: Pick<InvBlocks, "position">;
  /** The swing-dips block (item A) for the dip-low row; absent means not computed. */
  swing?: Block<SwingDips>;
}) {
  const block: Block<Position> = blocks.position;
  const common = { title: "Alert at a level", testId: "als-card" } as const;
  if (load.state === "loading") return <Card {...common} state="loading" />;
  if (load.state === "error") {
    return <Card {...common} state="error" message={load.message} onRetry={load.retry} />;
  }
  if (load.state === "unavailable") {
    return <Card {...common} state="empty" message={`Not available: ${load.reason}.`} />;
  }
  if (block.kind === "missing") {
    return (
      <Card
        {...common}
        state="empty"
        message="Not computed yet. Import prices again or run the post-import job for this stock."
      />
    );
  }
  if (block.kind === "error") {
    return (
      <Card
        {...common}
        state="error"
        message="The price position came back in an unexpected shape, so no levels can be offered."
      />
    );
  }
  return (
    <Card
      {...common}
      source="your imported prices"
      asOf={block.value.as_of ?? null}
      stale={load.stale}
    >
      <p className="mb-3 text-caption text-text-2" data-testid="als-note">
        Opens the alert form with the level filled in. You still choose to create it. Alerts are
        checked against the last price import, not live prices.
      </p>
      <Rows symbol={symbol} position={block.value} swing={swing} />
    </Card>
  );
}
