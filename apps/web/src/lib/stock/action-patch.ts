import { z } from "zod";
import { apiRequest } from "@/lib/api/client";
import { cleanNumber } from "@/lib/imports/entry-validate";
import { formatNumber } from "@/lib/format";
import type { CorporateAction } from "./schemas";

// Confirm / Reject of a detected corporate action (docs/03 section 14, B07-1..6, B07R-1..7). The
// only route used is the live `PATCH /stocks/{symbol}/actions/{id}`; nothing is auto-applied: the
// owner picks split or bonus and types both ratios (docs/06 6.4 Events, decisions D-K, D-W).

const numOrStr = z.union([z.number(), z.string()]).nullable().optional();

export const actionWarningSchema = z.object({
  field: z.string().optional(),
  code: z.string(),
  message: z.string(),
});

export const patchResultSchema = z.object({
  id: z.number(),
  symbol: z.string().optional(),
  ex_date: z.string(),
  action_type: z.string().nullable().optional(),
  status: z.string(),
  ratio_num: numOrStr,
  ratio_den: numOrStr,
  multiplier: numOrStr,
  future_ex_date: z.boolean().optional(),
  changed: z.boolean(),
  warnings: z.array(actionWarningSchema).optional(),
  post_import_job_id: z.number().nullable().optional(),
});
export type PatchResult = z.infer<typeof patchResultSchema>;

const path = (symbol: string, id: number) => `/stocks/${encodeURIComponent(symbol)}/actions/${id}`;

export async function confirmAction(
  symbol: string,
  id: number,
  body: { type: "split" | "bonus"; ratioNum: string; ratioDen: string },
): Promise<PatchResult> {
  const r = await apiRequest(path(symbol, id), {
    method: "PATCH",
    body: {
      status: "confirmed",
      action_type: body.type,
      ratio_num: body.ratioNum,
      ratio_den: body.ratioDen,
    },
    schema: patchResultSchema,
  });
  return r.data;
}

export async function rejectAction(symbol: string, id: number): Promise<PatchResult> {
  const r = await apiRequest(path(symbol, id), {
    method: "PATCH",
    body: { status: "rejected" },
    schema: patchResultSchema,
  });
  return r.data;
}

/** Same convention as the API's `Multiplier`: split num/den, bonus (num + den)/den (ACT-05). */
export function multiplierOf(type: "split" | "bonus", num: number, den: number): number | null {
  if (!(num > 0) || !(den > 0) || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  return type === "split" ? num / den : (num + den) / den;
}

export const TOLERANCE = 0.03;
export const EXTREME_HIGH = 100;
export const EXTREME_LOW = 0.01;

export interface RatioForm {
  type: "split" | "bonus" | "";
  ratioNum: string;
  ratioDen: string;
}

export interface Preview {
  /** Field problems the API would answer with 422 (shown before submit). */
  errors: { type?: string; ratio_num?: string; ratio_den?: string };
  multiplier: number | null;
  /** Same rules and codes as the API's warnings, so the owner sees them before confirming. */
  warnings: Array<{ code: string; message: string }>;
  /** `ratio_num`/`ratio_den` cleaned for the request body. */
  clean: { num: string; den: string } | null;
}

/** The implied multiplier the detector saw, 1/r with r = ratio_num/ratio_den of the candidate. */
export function detectedMultiplier(a: CorporateAction): number | null {
  const n = a.ratio_num;
  const d = a.ratio_den;
  return typeof n === "number" && typeof d === "number" && n > 0 && d > 0 ? d / n : null;
}

const fmt4 = (v: number) => formatNumber(v, { decimals: 4 }).text;

export function previewConfirm(form: RatioForm, candidate: CorporateAction): Preview {
  const errors: Preview["errors"] = {};
  if (form.type === "") errors.type = "Choose split or bonus.";
  const num = cleanNumber(form.ratioNum);
  const den = cleanNumber(form.ratioDen);
  const hint =
    form.type === "bonus"
      ? "new shares (for example 1 for 1:1)"
      : "old face value (for example 10 for 10 to 2)";
  const hintDen =
    form.type === "bonus"
      ? "shares held (for example 1 for 1:1)"
      : "new face value (for example 2 for 10 to 2)";
  if (!num.ok) errors.ratio_num = num.message;
  else if (num.value === null) errors.ratio_num = `Enter the first ratio: ${hint}.`;
  else if (!(Number(num.value) > 0)) errors.ratio_num = "The ratio must be greater than 0.";
  if (!den.ok) errors.ratio_den = den.message;
  else if (den.value === null) errors.ratio_den = `Enter the second ratio: ${hintDen}.`;
  else if (!(Number(den.value) > 0)) errors.ratio_den = "The ratio must be greater than 0.";
  if (
    !errors.ratio_num &&
    !errors.ratio_den &&
    form.type === "split" &&
    num.ok &&
    den.ok &&
    Number(num.value) === Number(den.value)
  ) {
    errors.ratio_num = "A split with equal ratios changes nothing.";
  }
  const bad = Object.keys(errors).length > 0;
  if (bad || form.type === "" || !num.ok || !den.ok || num.value === null || den.value === null) {
    return { errors, multiplier: null, warnings: [], clean: null };
  }
  const mult = multiplierOf(form.type, Number(num.value), Number(den.value));
  const warnings: Preview["warnings"] = [];
  const implied = detectedMultiplier(candidate);
  if (mult !== null && implied !== null && Math.abs(mult - implied) / implied > TOLERANCE) {
    warnings.push({
      code: "RATIO_DISAGREES_WITH_DETECTED",
      message: `The multiplier ${fmt4(mult)} differs by more than 3% from the one implied by the detected price change (${fmt4(implied)}). Check the ratio.`,
    });
  }
  if (mult !== null && (mult > EXTREME_HIGH || mult < EXTREME_LOW)) {
    warnings.push({
      code: "RATIO_EXTREME",
      message: `The multiplier ${fmt4(mult)} is outside 0.01 to 100. Check the ratio.`,
    });
  }
  return { errors, multiplier: mult, warnings, clean: { num: num.value, den: den.value } };
}

/** Plain-language lines for the warning codes the PATCH answer can carry (B07, B07R). */
export const WARNING_COPY: Record<string, string> = {
  POST_IMPORT_NOT_QUEUED:
    "Your decision is saved, but the recalculation could not be queued. Press the same button again to retry.",
  ADJUSTMENT_SKIPPED_SRC_ADJUSTED:
    "The prices around this date were imported as already adjusted, so the history was not changed again. Nothing is adjusted twice.",
  DUPLICATE_EX_DATE_ACTION:
    "Another split or bonus already exists on this ex-date. Only one of them should be confirmed.",
};

export function warningText(w: { code: string; message: string }): string {
  return WARNING_COPY[w.code] ?? w.message;
}

/** Another confirmed split or bonus on the candidate's ex-date (the API answers 409, ACT-27). */
export function twinConfirmed(
  actions: ReadonlyArray<CorporateAction>,
  candidate: CorporateAction,
): CorporateAction | null {
  return (
    actions.find(
      (a) =>
        a.id !== candidate.id &&
        a.ex_date === candidate.ex_date &&
        a.status === "confirmed" &&
        (a.type === "split" || a.type === "bonus"),
    ) ?? null
  );
}
