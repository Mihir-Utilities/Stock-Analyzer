"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import { z } from "zod";
import type { PortfolioView } from "./view";

// One read for the whole Portfolio risk section (docs/03 section 12b). The UI sends `view`
// explicitly. The data is read raw here and validated block by block by readRisk, so a wrong value in
// one block never rejects the whole answer. Every portfolio write invalidates the ["portfolio"] prefix.

export const riskKeys = {
  view: (view: PortfolioView) => ["portfolio", "risk", view] as const,
};

export function usePortfolioRisk(view: PortfolioView, enabled: boolean) {
  return useQuery({
    queryKey: riskKeys.view(view),
    enabled,
    // `forView` is the view this answer was asked for: while the next view loads, the previous answer
    // stays on screen and must never be labelled with the new view.
    queryFn: async ({ signal }) => {
      const r = await apiRequest("/portfolio/risk", {
        schema: z.unknown(),
        query: { view },
        signal,
      });
      return { ...r, forView: view };
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}
