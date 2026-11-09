import type { Metadata } from "next";
import { AlertsPage } from "@/components/alerts/AlertsPage";

export const metadata: Metadata = { title: "Alerts" };

export default function AlertsRoute() {
  return <AlertsPage />;
}
