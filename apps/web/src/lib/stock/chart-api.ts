import { apiRequest } from "@/lib/api/client";
import { pricesSchema } from "./schemas";

// Chart tab price requests (docs/03 section 4): the range and adjusted flag are part of the key so
// switching either refetches; the Overview keeps its own 1Y adjusted key in api.ts.

export const chartPriceKey = (symbol: string, range: string, adjusted: boolean) =>
  ["stocks", symbol, "chart-prices", range, adjusted] as const;

export const getChartPrices = (symbol: string, range: string, adjusted: boolean) =>
  apiRequest(`/stocks/${encodeURIComponent(symbol)}/prices`, {
    schema: pricesSchema,
    query: { range, adjusted },
  });
