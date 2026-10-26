import { apiRequest } from "@/lib/api/client";
import {
  adjustmentCheckSchema,
  batchListSchema,
  manualDeleteSchema,
  manualResultSchema,
  undoResultSchema,
  adminDbSchema,
  commitResultSchema,
  deletePreviewSchema,
  deleteResultSchema,
  instrumentCreatedSchema,
  pricesAdjustmentSchema,
  stockIndexSchema,
  trimPreviewSchema,
  trimResultSchema,
  validateResultSchema,
  type ImportKind,
} from "./schemas";

// Thin typed wrappers over the shared client (CSRF header on every non-GET, envelope validation).

export async function validateUpload(kind: ImportKind, file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append("file", file);
  const r = await apiRequest(`/imports/${kind}/validate`, {
    method: "POST",
    body: form,
    schema: validateResultSchema,
    signal,
  });
  return r.data;
}

export async function commitUpload(kind: ImportKind, uploadId: string, note: string) {
  const body: { upload_id: string; note?: string } = { upload_id: uploadId };
  if (note.trim()) body.note = note.trim();
  const r = await apiRequest(`/imports/${kind}/commit`, {
    method: "POST",
    body,
    schema: commitResultSchema,
  });
  return r.data;
}

export async function setPricesAdjustment(value: boolean, confirm: boolean) {
  const r = await apiRequest("/settings/prices-adjustment", {
    method: "PUT",
    body: confirm ? { value, confirm: true } : { value },
    schema: pricesAdjustmentSchema,
  });
  return r.data;
}

export async function runAdjustmentCheck(input: {
  uploadId: string;
  symbol: string;
  exDate: string;
  ratio: { num: number; den: number } | null;
}) {
  const r = await apiRequest("/imports/prices/adjustment-check", {
    method: "POST",
    body: {
      upload_id: input.uploadId,
      symbol: input.symbol,
      ex_date: input.exDate,
      ...(input.ratio ? { expected_ratio: input.ratio } : {}),
    },
    schema: adjustmentCheckSchema,
  });
  return r.data;
}

export async function addStock(input: { symbol: string; name: string; isin: string }) {
  const body: { symbol: string; name: string; isin?: string } = {
    symbol: input.symbol.trim(),
    name: input.name.trim(),
  };
  if (input.isin.trim()) body.isin = input.isin.trim();
  const r = await apiRequest("/instruments", {
    method: "POST",
    body,
    schema: instrumentCreatedSchema,
  });
  return r.data;
}

export async function previewDeletePrices(symbol: string, from: string, to: string) {
  const r = await apiRequest(`/stocks/${encodeURIComponent(symbol)}/prices/delete-preview`, {
    method: "POST",
    query: { from, to },
    schema: deletePreviewSchema,
  });
  return r.data;
}

export async function deletePrices(symbol: string, from: string, to: string) {
  const r = await apiRequest(`/stocks/${encodeURIComponent(symbol)}/prices`, {
    method: "DELETE",
    query: { from, to },
    body: { confirm: true },
    schema: deleteResultSchema,
  });
  return r.data;
}

export async function previewTrim(symbols: string[], before: string) {
  const r = await apiRequest("/prices/trim/preview", {
    method: "POST",
    body: { symbols, before },
    schema: trimPreviewSchema,
  });
  return r.data;
}

export async function trimHistory(symbols: string[], before: string) {
  const r = await apiRequest("/prices/trim", {
    method: "POST",
    body: { symbols, before, confirm: true },
    schema: trimResultSchema,
  });
  return r.data;
}

export async function fetchStockIndex() {
  const r = await apiRequest("/stocks/index", { schema: stockIndexSchema });
  return r.data.items;
}

export async function fetchDbStatus() {
  const r = await apiRequest("/admin/status", { schema: adminDbSchema });
  return { db: r.data.db, asOf: r.meta?.as_of ?? null };
}

export async function fetchBatches(limit = 50) {
  const r = await apiRequest("/imports/batches", { query: { limit }, schema: batchListSchema });
  return r.data.items;
}

export async function undoBatch(id: number) {
  const r = await apiRequest(`/imports/batches/${id}/undo`, {
    method: "POST",
    schema: undoResultSchema,
  });
  return r.data;
}

const stockPath = (symbol: string, tail: string) =>
  `/stocks/${encodeURIComponent(symbol.trim())}/${tail}`;

export async function postResults(symbol: string, body: Record<string, unknown>) {
  const r = await apiRequest(stockPath(symbol, "results"), {
    method: "POST",
    body,
    schema: manualResultSchema,
  });
  return r.data;
}

export async function postShareholding(symbol: string, body: Record<string, unknown>) {
  const r = await apiRequest(stockPath(symbol, "shareholding"), {
    method: "POST",
    body,
    schema: manualResultSchema,
  });
  return r.data;
}

export async function postAction(symbol: string, body: Record<string, unknown>) {
  const r = await apiRequest(stockPath(symbol, "actions"), {
    method: "POST",
    body,
    schema: manualResultSchema,
  });
  return r.data;
}

export async function deleteManualResults(
  symbol: string,
  period: { periodType: string; periodEnd: string; basis: string },
) {
  const r = await apiRequest(stockPath(symbol, "results"), {
    method: "DELETE",
    query: {
      period_type: period.periodType,
      period_end: period.periodEnd,
      basis: period.basis,
    },
    schema: manualDeleteSchema,
  });
  return r.data;
}
