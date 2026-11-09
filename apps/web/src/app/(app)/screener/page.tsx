import type { Metadata } from "next";
import { NotAvailable } from "@/components/shell/NotAvailable";

export const metadata: Metadata = { title: "Screener" };

export default function ScreenerRoute() {
  return (
    <NotAvailable
      testId="screener-na"
      title="Screener"
      waitingFor="The screener needs scores, valuation and sector percentiles from analytics step D05b, which is on hold."
    />
  );
}
