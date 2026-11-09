import type { Metadata } from "next";
import { StocksBrowse } from "@/components/stocks/StocksBrowse";

export const metadata: Metadata = { title: "Stocks" };

export default function StocksRoute() {
  return <StocksBrowse />;
}
