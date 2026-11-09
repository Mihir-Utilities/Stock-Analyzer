import type { Metadata } from "next";
import { NotAvailable } from "@/components/shell/NotAvailable";

export const metadata: Metadata = { title: "Admin status" };

export default function AdminStatusRoute() {
  return (
    <NotAvailable
      testId="admin-status-na"
      title="Admin status"
      waitingFor="The status endpoint (task B14) is not built yet, so sources, jobs, coverage and database size cannot be shown."
    />
  );
}
