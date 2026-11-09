"use client";

import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, Drawer } from "@/components/ui/overlays";
import { Fmt } from "@/components/imports/Fmt";
import { useAlertEvents, useAlerts, useDeleteAlert, usePatchAlert } from "@/lib/alerts/api";
import type { AlertItem } from "@/lib/alerts/schemas";
import { STATUS_LABEL, conditionText, lastErrorLabel, targetText } from "@/lib/alerts/text";
import { alertKindLabel, deliveryStatusLabel } from "@/lib/dashboard/labels";
import { formatCount, formatDate, formatDateTime } from "@/lib/format";
import { describeError, isApiError } from "@/lib/imports/errors";
import { useSingleFlight } from "@/lib/imports/single-flight";
import { AlertForm } from "./AlertForm";
import { TelegramCard } from "./TelegramCard";

const BTN =
  "touch-target h-9 rounded-control border border-border px-3 text-body-sm text-text-1 hover:bg-surface-3 disabled:opacity-50";

const FILTERS = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "fired", label: "Fired" },
  { value: "expired", label: "Expired" },
];

function AlertRow({
  alert,
  onEdit,
  onToggle,
  onDelete,
  busy,
}: {
  alert: AlertItem;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const editable = alert.status === "active" || alert.status === "paused";
  return (
    <li
      data-testid="alert-row"
      className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="text-body font-medium text-text-1">
          {targetText(alert.target)}: {alertKindLabel(alert.kind)}
        </p>
        <p className="text-body-sm text-text-2">{conditionText(alert.kind, alert.params)}</p>
        <p className="text-caption text-text-2">
          <span data-testid="alert-status">{STATUS_LABEL[alert.status] ?? alert.status}</span>
          {" | "}
          {alert.one_shot
            ? "One-shot"
            : `Recurring, cooldown ${formatCount(alert.cooldown_minutes).text} min`}
          {alert.expires_on ? (
            <>
              {" | Expires "}
              <Fmt f={formatDate(alert.expires_on)} />
            </>
          ) : null}
          {alert.last_fired_at ? (
            <>
              {" | Last fired "}
              <Fmt f={formatDateTime(alert.last_fired_at)} />
            </>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {editable ? (
          <>
            <button type="button" data-testid="alert-edit" onClick={onEdit} className={BTN}>
              Edit
            </button>
            <button
              type="button"
              data-testid="alert-toggle"
              disabled={busy}
              onClick={onToggle}
              className={BTN}
            >
              {alert.status === "active" ? "Pause" : "Resume"}
            </button>
          </>
        ) : null}
        <button
          type="button"
          data-testid="alert-delete"
          disabled={busy}
          onClick={onDelete}
          className={BTN}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function AlertList({
  onNew,
  onEdit,
  notify,
}: {
  onNew: () => void;
  onEdit: (a: AlertItem) => void;
  notify: (m: string) => void;
}) {
  const [status, setStatus] = useState("");
  const list = useAlerts(status);
  const patch = usePatchAlert();
  const del = useDeleteAlert();
  const [toDelete, setToDelete] = useState<AlertItem | null>(null);
  const once = useSingleFlight();
  const items = list.data?.pages.flatMap((p) => p.data.items) ?? [];
  const actionError = patch.error ?? del.error;

  let state: "loading" | "error" | "empty" | "ready" = "ready";
  if (list.isPending) state = "loading";
  else if (list.isError) state = "error";
  else if (items.length === 0) state = "empty";

  return (
    <Card
      title="Your alerts"
      testId="alerts-card"
      state={state}
      message={
        state === "error"
          ? isApiError(list.error, "NOT_IMPLEMENTED")
            ? "Alerts are not available on the server yet."
            : describeError(list.error)
          : status
            ? "No alerts with this status."
            : "No alerts yet. Create one to be told when a price or a filing changes."
      }
      onRetry={() => void list.refetch()}
      actions={
        <>
          <label className="sr-only" htmlFor="alert-filter">
            Show alerts with status
          </label>
          <select
            id="alert-filter"
            data-testid="alert-filter"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 touch-target rounded-control border border-border bg-surface-1 px-2 text-body-sm text-text-1"
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <button type="button" data-testid="alert-new" onClick={onNew} className={BTN}>
            New alert
          </button>
        </>
      }
    >
      <p className="mb-2 text-body-sm text-text-2" data-testid="alert-limit-note">
        Up to 200 alerts can be active at once. Paused, fired and expired alerts do not count.
      </p>
      {actionError ? (
        <div className="mb-2">
          <Banner tone="error" testId="alert-action-error">
            {isApiError(actionError, "CONFLICT")
              ? "This alert cannot be changed: the 200 active alert limit is reached, or the alert already fired or expired."
              : describeError(actionError)}
          </Banner>
        </div>
      ) : null}
      <ul>
        {items.map((a) => (
          <AlertRow
            key={a.id}
            alert={a}
            busy={patch.isPending || del.isPending}
            onEdit={() => onEdit(a)}
            onToggle={() =>
              once(async () => {
                await patch.mutateAsync({
                  id: a.id,
                  body: { status: a.status === "active" ? "paused" : "active" },
                });
                notify(a.status === "active" ? "Alert paused." : "Alert resumed.");
              })
            }
            onDelete={() => {
              del.reset();
              setToDelete(a);
            }}
          />
        ))}
      </ul>
      {list.hasNextPage ? (
        <button
          type="button"
          data-testid="alert-more"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
          className={`${BTN} mt-2`}
        >
          {list.isFetchingNextPage ? "Loading" : "Show more"}
        </button>
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this alert?"
        message="The alert and its history are removed. This cannot be undone."
        confirmLabel="Delete"
        danger
        busy={del.isPending}
        onConfirm={() =>
          once(async () => {
            if (!toDelete) return;
            await del.mutateAsync(toDelete.id);
            setToDelete(null);
            notify("Alert deleted.");
          })
        }
        onCancel={() => setToDelete(null)}
      />
    </Card>
  );
}

function History() {
  const q = useAlertEvents();
  const items = q.data?.pages.flatMap((p) => p.data.items) ?? [];
  let state: "loading" | "error" | "empty" | "ready" = "ready";
  if (q.isPending) state = "loading";
  else if (q.isError) state = "error";
  else if (items.length === 0) state = "empty";
  return (
    <Card
      title="Alert history"
      testId="alert-history"
      state={state}
      message={
        state === "error"
          ? isApiError(q.error, "NOT_IMPLEMENTED")
            ? "Alert history is not available on the server yet."
            : describeError(q.error)
          : "No alert has fired yet."
      }
      onRetry={() => void q.refetch()}
    >
      <ul>
        {items.map((e) => {
          const err = lastErrorLabel(e.last_error);
          return (
            <li
              key={e.id}
              data-testid="alert-event"
              className="border-b border-border py-2 text-body-sm last:border-b-0"
            >
              <p className="text-text-1">
                {targetText(e.target)}: {alertKindLabel(e.kind)}
              </p>
              <p className="text-caption text-text-2">
                Fired <Fmt f={formatDateTime(e.fired_at)} />
                {" | "}
                <span data-testid="alert-delivery">{deliveryStatusLabel(e.delivery_status)}</span>
                {e.delivered_at ? (
                  <>
                    {" "}
                    <Fmt f={formatDateTime(e.delivered_at)} />
                  </>
                ) : null}
                {e.delivery_attempts > 0
                  ? ` | ${formatCount(e.delivery_attempts).text} attempts`
                  : ""}
                {err ? ` | ${err}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
      {q.hasNextPage ? (
        <button
          type="button"
          data-testid="alert-events-more"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
          className={`${BTN} mt-2`}
        >
          {q.isFetchingNextPage ? "Loading" : "Show more"}
        </button>
      ) : null}
    </Card>
  );
}

/** Quiet hours are stored (`app_user.quiet_hours`) but no route reads or writes them yet (F12-1). */
function QuietHours() {
  return (
    <Card
      title="Quiet hours"
      testId="quiet-hours-card"
      state="empty"
      message="Not available yet: the server has no route to read or change quiet hours, so they cannot be edited here. Messages held for quiet hours show as held in the history."
    />
  );
}

export function AlertsPage() {
  const [drawer, setDrawer] = useState<{ edit: AlertItem | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (note) noteRef.current?.focus();
  }, [note]);
  return (
    <div className="flex flex-col gap-4" data-testid="alerts-page">
      <h1 className="text-page font-semibold text-text-1">Alerts</h1>
      <Banner tone="info" testId="alerts-basis-note">
        Alerts are checked against the last price import (after each import and at the evening run),
        not against live prices.
      </Banner>
      <p
        ref={noteRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        data-testid="alerts-result"
        className="text-body-sm text-text-1 outline-none"
      >
        {note ?? ""}
      </p>
      <AlertList
        onNew={() => setDrawer({ edit: null })}
        onEdit={(a) => setDrawer({ edit: a })}
        notify={setNote}
      />
      <Drawer
        open={drawer !== null}
        title={drawer?.edit ? "Edit alert" : "New alert"}
        onClose={() => setDrawer(null)}
      >
        {drawer ? (
          <AlertForm
            key={drawer.edit?.id ?? "new"}
            initial={drawer.edit ?? undefined}
            onDone={(m) => {
              setDrawer(null);
              setNote(m);
            }}
          />
        ) : null}
      </Drawer>
      <History />
      <QuietHours />
      <TelegramCard />
    </div>
  );
}
