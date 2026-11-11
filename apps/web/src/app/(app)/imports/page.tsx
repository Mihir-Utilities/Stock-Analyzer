import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { ImportCenter } from "@/components/imports/ImportCenter";

export const metadata: Metadata = { title: "Import center" };

// useSearchParams (?kind=mf_statement) needs a Suspense boundary in the app router.
export default function ImportsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" label="Loading import center" />}>
      <ImportCenter />
    </Suspense>
  );
}
