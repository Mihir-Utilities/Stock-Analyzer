import type { Metadata } from "next";
import { Suspense } from "react";
import { ComparePage } from "@/components/compare/ComparePage";

export const metadata: Metadata = { title: "Compare" };

export default function CompareRoute() {
  return (
    <Suspense fallback={null}>
      <ComparePage />
    </Suspense>
  );
}
