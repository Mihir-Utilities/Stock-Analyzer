import type { Metadata } from "next";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioRoute() {
  return <PortfolioPage />;
}
