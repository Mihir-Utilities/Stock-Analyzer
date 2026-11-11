import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";

export const metadata: Metadata = { title: "Portfolio" };

// useSearchParams (the ?view= switcher) needs a Suspense boundary in the app router.
export default function PortfolioRoute() {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" label="Loading portfolio" />}>
      <PortfolioPage />
    </Suspense>
  );
}
