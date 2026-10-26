import type { Metadata } from "next";
import { WatchlistPage } from "@/components/portfolio/WatchlistPage";

export const metadata: Metadata = { title: "Watchlist" };

export default function WatchlistRoute() {
  return <WatchlistPage />;
}
