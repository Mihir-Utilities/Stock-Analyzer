"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { CellInput } from "@/components/imports/ManualCommon";
import { Banner } from "@/components/ui/banners";
import { FormField, inputClass } from "@/components/ui/FormField";
import { ConfirmDialog } from "@/components/ui/overlays";
import { ApiError } from "@/lib/api/client";
import { formatDate, formatNumber } from "@/lib/format";
import { describeError, fieldMessage } from "@/lib/imports/errors";
import { useSingleFlight } from "@/lib/imports/single-flight";
import {
  confirmAction,
  detectedMultiplier,
  previewConfirm,
  rejectAction,
  twinConfirmed,
  warningText,
  type PatchResult,
  type RatioForm,
} from "@/lib/stock/action-patch";
import { actionTitle } from "@/lib/stock/events-view";
import type { CorporateAction } from "@/lib/stock/schemas";

const button =
  "touch-target inline-flex h-9 items-center rounded-control border px-3 text-body-sm font-medium text-text-1 hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60";

type Pending = "confirm" | "reject" | null;

/**
 * Confirm or Reject one detected candidate (ACT-03, ACT-04). Confirming needs the owner's choice
 * of split or bonus and both ratios (B07-1); nothing is pre-filled or applied by the app. The
 * route is `PATCH /stocks/{symbol}/actions/{id}` and every submit is single-flight.
 */
export function DetectedActionCard({
  symbol,
  action,
  allActions,
  onDone,
}: {
  symbol: string;
  action: CorporateAction;
  allActions: ReadonlyArray<CorporateAction>;
  onDone: (r: PatchResult, verb: "confirmed" | "rejected") => void;
}) {
  const qc = useQueryClient();
  const once = useSingleFlight();
  const uid = useId();
  const [form, setForm] = useState<RatioForm>({ type: "", ratioNum: "", ratioDen: "" });
  const [touched, setTouched] = useState(false);
  const [asking, setAsking] = useState<Pending>(null);
  const preview = previewConfirm(form, action);
  const twin = twinConfirmed(allActions, action);
  const implied = detectedMultiplier(action);
  const when = formatDate(action.ex_date).text;

  const finish = (r: PatchResult, verb: "confirmed" | "rejected") => {
    setAsking(null);
    onDone(r, verb);
    void qc.invalidateQueries({ queryKey: ["stocks", symbol] });
  };
  const confirm = useMutation({
    mutationFn: () => {
      if (!preview.clean || form.type === "") throw new Error("form is not valid");
      return confirmAction(symbol, action.id, {
        type: form.type,
        ratioNum: preview.clean.num,
        ratioDen: preview.clean.den,
      });
    },
    onMutate: (): void => {
      reject.reset();
    },
    onSuccess: (r) => finish(r, "confirmed"),
    onError: (e) => {
      setAsking(null);
      // The action is gone or was changed elsewhere: reload the list so the page tells the truth.
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
        void qc.invalidateQueries({ queryKey: ["stocks", symbol, "events"] });
      }
    },
  });
  const reject = useMutation({
    mutationFn: () => rejectAction(symbol, action.id),
    onMutate: (): void => {
      confirm.reset();
    },
    onSuccess: (r) => finish(r, "rejected"),
    onError: (e) => {
      setAsking(null);
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
        void qc.invalidateQueries({ queryKey: ["stocks", symbol, "events"] });
      }
    },
  });
  const busy = confirm.isPending || reject.isPending;
  const error = confirm.error ?? reject.error;
  const reasonId = `${uid}-reason`;
  const invalid = Object.keys(preview.errors).length > 0;

  const isBonus = form.type === "bonus";
  const labelNum = isBonus ? "New shares" : "Old face value";
  const labelDen = isBonus ? "Shares held" : "New face value";
  const err = (k: "type" | "ratio_num" | "ratio_den") =>
    fieldMessage(confirm.error, k) ?? (touched ? (preview.errors[k] ?? null) : null);

  return (
    <article
      data-testid="detected-action"
      data-action-id={action.id}
      aria-labelledby={`${uid}-title`}
      className="flex flex-col gap-3 rounded-card border border-warn bg-surface-1 p-3"
    >
      <div>
        <h3 id={`${uid}-title`} className="text-body font-semibold text-text-1">
          Possible split or bonus on {when}
        </h3>
        <p className="text-body-sm text-text-2" data-testid="detected-summary">
          {actionTitle(action)}. The app only found this from the price history; nothing has been
          adjusted. Choose what it was and enter both ratios to confirm, or reject it if the move
          was real.
        </p>
        {implied !== null ? (
          <p className="text-caption text-text-2" data-testid="detected-implied">
            Multiplier implied by the price change: {formatNumber(implied, { decimals: 4 }).text}.
          </p>
        ) : null}
      </div>
      {twin ? (
        <Banner tone="warn" testId="twin-warning">
          A confirmed {twin.type} already exists on {when}. Confirming this candidate too would
          adjust the history twice, so the server will refuse it. Reject this candidate instead.
        </Banner>
      ) : null}
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!invalid && !busy) setAsking("confirm");
        }}
      >
        <FormField label="What was it" error={err("type")} required>
          {(p) => (
            <select
              {...p}
              data-testid="confirm-type"
              className={inputClass}
              value={form.type}
              onChange={(e) => {
                const v = e.target.value;
                setForm({ ...form, type: v === "split" || v === "bonus" ? v : "" });
              }}
            >
              <option value="">Choose</option>
              <option value="split">Split</option>
              <option value="bonus">Bonus</option>
            </select>
          )}
        </FormField>
        <CellInput
          label={labelNum}
          hint={isBonus ? "1 for a 1:1 bonus" : "10 for a split from 10 to 2"}
          testId="confirm-ratio-num"
          value={form.ratioNum}
          onChange={(v) => setForm({ ...form, ratioNum: v })}
          error={err("ratio_num")}
          required
        />
        <CellInput
          label={labelDen}
          hint={isBonus ? "1 for a 1:1 bonus" : "2 for a split from 10 to 2"}
          testId="confirm-ratio-den"
          value={form.ratioDen}
          onChange={(v) => setForm({ ...form, ratioDen: v })}
          error={err("ratio_den")}
          required
        />
        <div className="sm:col-span-3" data-testid="confirm-preview" aria-live="polite">
          {preview.multiplier !== null ? (
            <p className="text-body-sm text-text-1">
              Implied multiplier:{" "}
              <strong className="num">
                {formatNumber(preview.multiplier, { decimals: 4 }).text}
              </strong>
              . Share counts are multiplied by it and prices before {when} are divided by it.
            </p>
          ) : (
            <p className="text-body-sm text-text-2">
              Enter the type and both ratios to see the multiplier.
            </p>
          )}
          {preview.warnings.map((w) => (
            <Banner key={w.code} tone="warn" testId={`preview-warning-${w.code}`}>
              {w.message}
            </Banner>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
          <button
            type="submit"
            data-testid="action-confirm"
            disabled={busy}
            aria-describedby={invalid && touched ? reasonId : undefined}
            className={`${button} border-accent`}
          >
            {confirm.isPending ? "Confirming" : "Confirm"}
          </button>
          <button
            type="button"
            data-testid="action-reject"
            disabled={busy}
            onClick={() => setAsking("reject")}
            className={`${button} border-border`}
          >
            {reject.isPending ? "Rejecting" : "Reject"}
          </button>
          {invalid && touched ? (
            <span id={reasonId} data-testid="confirm-reason" className="text-caption text-text-2">
              Fix the fields marked above to confirm.
            </span>
          ) : null}
        </div>
      </form>
      {error ? (
        <Banner tone="error" testId="action-error">
          {error instanceof ApiError && error.status === 409
            ? `${error.message} The list was reloaded.`
            : error instanceof ApiError && error.status === 404
              ? "This action no longer exists for this stock. The list was reloaded."
              : describeError(error)}
          {error instanceof ApiError && error.requestId ? ` (request ${error.requestId})` : ""}
        </Banner>
      ) : null}
      <ConfirmDialog
        open={asking === "confirm"}
        title={`Confirm ${form.type === "bonus" ? "bonus" : "split"} on ${when}`}
        busy={busy}
        confirmLabel="Confirm and adjust history"
        message={
          <>
            Prices before {when} will be recalculated with the multiplier{" "}
            {formatNumber(preview.multiplier, { decimals: 4, reason: "not set" }).text}, and
            indicators and portfolio holdings follow. This is your decision: the app never applies
            it by itself, and a confirmed action cannot be changed from this page.
          </>
        }
        onCancel={() => setAsking(null)}
        onConfirm={() => once(() => confirm.mutateAsync())}
      />
      <ConfirmDialog
        open={asking === "reject"}
        title={`Reject the candidate on ${when}`}
        busy={busy}
        danger
        confirmLabel="Reject candidate"
        message="The candidate is marked rejected, nothing is adjusted and it is not detected again for this date. If it turns out to be real, add the action yourself."
        onCancel={() => setAsking(null)}
        onConfirm={() => once(() => reject.mutateAsync())}
      />
    </article>
  );
}

/** Sentences for a saved decision (B07: changed, future ex-date, warnings, queue state). */
export function decisionLines(r: PatchResult, verb: "confirmed" | "rejected"): string[] {
  const lines: string[] = [];
  const when = formatDate(r.ex_date).text;
  if (!r.changed) {
    lines.push(`The candidate on ${when} was already ${r.status}; nothing changed.`);
  } else if (verb === "rejected") {
    lines.push(`Rejected the candidate on ${when}. It will not be detected again for this date.`);
  } else {
    const m = r.multiplier === null || r.multiplier === undefined ? null : Number(r.multiplier);
    lines.push(
      `Confirmed ${r.action_type ?? "action"} on ${when}${
        m !== null && Number.isFinite(m)
          ? ` with multiplier ${formatNumber(m, { decimals: 4 }).text}`
          : ""
      }.`,
    );
  }
  if (r.future_ex_date) {
    lines.push("The ex-date is in the future: nothing is applied to prices until it arrives.");
  }
  if (r.post_import_job_id !== null && r.post_import_job_id !== undefined) {
    lines.push(`Recalculation queued (job ${r.post_import_job_id}); the page refreshes by itself.`);
  }
  for (const w of r.warnings ?? []) lines.push(warningText(w));
  return lines;
}
