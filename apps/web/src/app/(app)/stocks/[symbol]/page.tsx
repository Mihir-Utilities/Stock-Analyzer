import type { Metadata } from "next";
import { Suspense } from "react";
import { StockPage } from "@/components/stock/StockPage";

type Props = { params: Promise<{ symbol: string }> };

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { symbol } = await params;
  return { title: decode(symbol).toUpperCase() };
}

export default async function StockDetailPage({ params }: Props) {
  const { symbol } = await params;
  return (
    <Suspense fallback={null}>
      <StockPage symbol={decode(symbol)} />
    </Suspense>
  );
}
