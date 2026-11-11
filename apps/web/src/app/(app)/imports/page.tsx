import type { Metadata } from "next";
import { Suspense } from "react";
import { ImportCenter } from "@/components/imports/ImportCenter";

export const metadata: Metadata = { title: "Import center" };

// useSearchParams (?kind=mf_statement) needs a Suspense boundary in the app router.
export default function ImportsPage() {
  return (
    <Suspense fallback={null}>
      <ImportCenter />
    </Suspense>
  );
}
