"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { STALE_TIME } from "@/components/shell/Providers";
import { Banner } from "@/components/ui/banners";
import { Card } from "@/components/ui/Card";
import { inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/overlays";
import { ApiError } from "@/lib/api/client";
import { describeError } from "@/lib/dashboard/state";
import { formatDate } from "@/lib/format";
import { deleteScreen, getSaved, saveScreen, screenerKeys } from "@/lib/screener/api";
import { SCREENER_LIMITS } from "@/lib/screener/metrics";
import type { ScreenSpec } from "@/lib/screener/schemas";
import { SAVED_NAME_LOWER, savedNameError, type SavedSpec } from "@/lib/screener/spec";
import { BTN } from "./parts";

export function saveErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    return `You already have ${SCREENER_LIMITS.saved} saved screens. Delete one, then save again.`;
  }
  if (e instanceof ApiError && e.status === 422)
    return `The screen could not be saved: ${e.message}.`;
  return describeError(e, "Saving the screen").message;
}

/** Presets (from the server) and saved screens: load, save or replace by name, delete. */
export function SavedScreens({
  buildSpec,
  onLoad,
}: {
  /** The current builder state as a saved spec, or null when it has errors (shown by the page). */
  buildSpec: () => SavedSpec | null;
  onLoad: (name: string, spec: ScreenSpec) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: screenerKeys.saved,
    queryFn: () => getSaved(),
    staleTime: STALE_TIME.profile,
  });
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [replacing, setReplacing] = useState<SavedSpec | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (spec: SavedSpec) => saveScreen({ name: name.trim(), spec }),
    onSuccess: (saved) => {
      setStatus(`Saved screen ${saved.name}.`);
      setReplacing(null);
      void qc.invalidateQueries({ queryKey: screenerKeys.saved });
    },
    onError: () => setReplacing(null),
  });
  const del = useMutation({
    mutationFn: (n: string) => deleteScreen(n),
    onSuccess: (_r, n) => {
      setStatus(`Deleted screen ${n}.`);
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: screenerKeys.saved });
    },
    onError: () => setDeleting(null),
  });

  const items = q.data?.items ?? [];
  const max = q.data?.max_saved ?? SCREENER_LIMITS.saved;
  const existing = items.find((s) => SAVED_NAME_LOWER(s.name) === SAVED_NAME_LOWER(name));
  const full = !existing && items.length >= max;

  const onSave = () => {
    setStatus("");
    save.reset();
    const err = savedNameError(name);
    setNameError(err);
    if (err) return;
    const spec = buildSpec();
    if (!spec) return;
    if (existing) setReplacing(spec);
    else save.mutate(spec);
  };

  return (
    <Card title="Presets and saved screens" testId="screener-saved-card">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="text-lead font-semibold text-text-1">Presets</h3>
          {q.isPending ? (
            <p className="text-body-sm text-text-2">Loading presets</p>
          ) : q.isError ? (
            <div className="flex flex-col items-start gap-2">
              <Banner tone="error" testId="screener-saved-error">
                {describeError(q.error, "Presets and saved screens").message}
              </Banner>
              <button
                type="button"
                data-testid="screener-saved-retry"
                onClick={() => void q.refetch()}
                className={BTN}
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Presets">
              {q.data.presets.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  data-testid={`screener-preset-${p.name}`}
                  onClick={() => onLoad(p.name, p.spec)}
                  className={BTN}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-lead font-semibold text-text-1">
            Saved screens ({items.length} of {max})
          </h3>
          {q.isSuccess && items.length === 0 ? (
            <p className="text-body-sm text-text-2" data-testid="screener-saved-empty">
              No saved screens yet.
            </p>
          ) : null}
          {items.length > 0 ? (
            <ul className="flex flex-col" aria-label="Saved screens">
              {items.map((s) => (
                <li
                  key={s.name}
                  data-testid={`screener-saved-${s.name}`}
                  className="flex flex-wrap items-center gap-2 border-t border-border py-1"
                >
                  <span className="min-w-0 flex-1 break-words text-body-sm text-text-1">
                    {s.name}
                    {s.saved_at ? (
                      <span className="text-caption text-text-2">
                        {" "}
                        saved {formatDate(s.saved_at).text}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    data-testid={`screener-load-${s.name}`}
                    aria-label={`Load screen ${s.name}`}
                    onClick={() => onLoad(s.name, s.spec)}
                    className={BTN}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    data-testid={`screener-delete-${s.name}`}
                    aria-label={`Delete screen ${s.name}`}
                    onClick={() => setDeleting(s.name)}
                    className={BTN}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-caption font-medium text-text-1">
            Screen name
            <input
              type="text"
              data-testid="screener-save-name"
              value={name}
              maxLength={60}
              aria-invalid={nameError !== null}
              aria-describedby="screener-save-hint"
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              className={inputClass}
            />
          </label>
          <p id="screener-save-hint" className="text-caption text-text-2">
            {nameError ? (
              <span data-testid="screener-save-name-error">
                <span className="font-medium text-down">Error: </span>
                {nameError}
              </span>
            ) : existing ? (
              "A screen with this name exists. Saving replaces it."
            ) : full ? (
              `Saving is off: ${max} screens are saved. Delete one first, or use the name of an existing screen to replace it.`
            ) : (
              "Letters, digits, spaces and _ . ( ) - are allowed."
            )}
          </p>
          <div>
            <button
              type="button"
              data-testid="screener-save"
              disabled={save.isPending || full}
              aria-describedby="screener-save-hint"
              onClick={onSave}
              className={BTN}
            >
              {save.isPending ? "Saving" : existing ? "Replace saved screen" : "Save screen"}
            </button>
          </div>
        </div>

        <div
          aria-live="polite"
          data-testid="screener-saved-status"
          className="text-caption text-text-2"
        >
          {status}
        </div>
        {save.isError ? (
          <Banner tone="error" testId="screener-save-error">
            {saveErrorText(save.error)}
          </Banner>
        ) : null}
        {del.isError ? (
          <Banner tone="error" testId="screener-delete-error">
            {describeError(del.error, "Deleting the screen").message}
          </Banner>
        ) : null}
      </div>

      <ConfirmDialog
        open={replacing !== null || deleting !== null}
        title={deleting !== null ? "Delete saved screen?" : "Replace saved screen?"}
        message={
          deleting !== null
            ? `Delete the screen named ${deleting}. This cannot be undone.`
            : `A screen named ${existing?.name ?? name.trim()} already exists. Its filters, sort and columns are replaced.`
        }
        confirmLabel={deleting !== null ? "Delete" : "Replace"}
        danger={deleting !== null}
        busy={save.isPending || del.isPending}
        onConfirm={() => {
          if (deleting !== null) del.mutate(deleting);
          else if (replacing) save.mutate(replacing);
        }}
        onCancel={() => {
          setReplacing(null);
          setDeleting(null);
        }}
      />
    </Card>
  );
}
