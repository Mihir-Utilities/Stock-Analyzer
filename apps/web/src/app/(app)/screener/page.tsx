import type { Metadata } from "next";
import { ScreenerPage } from "@/components/screener/ScreenerPage";

export const metadata: Metadata = { title: "Screener" };

export default function ScreenerRoute() {
  return <ScreenerPage />;
}
