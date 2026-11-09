import type { Metadata } from "next";
import { Suspense } from "react";
import { MfCompare } from "@/components/mf/MfCompare";

export const metadata: Metadata = { title: "Compare funds" };

export default function MfCompareRoute() {
  return (
    <Suspense fallback={null}>
      <MfCompare />
    </Suspense>
  );
}
