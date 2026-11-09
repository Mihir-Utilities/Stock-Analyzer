import type { Metadata } from "next";
import { NotAvailable } from "@/components/shell/NotAvailable";

export const metadata: Metadata = { title: "Compare" };

export default function CompareRoute() {
  return (
    <NotAvailable
      testId="compare-na"
      title="Compare"
      waitingFor="Comparing stocks needs peers and scores from analytics step D05b, which is on hold. Fund comparison is available under Funds."
    />
  );
}
