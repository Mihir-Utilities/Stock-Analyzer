import type { Metadata } from "next";
import { ImportCenter } from "@/components/imports/ImportCenter";

export const metadata: Metadata = { title: "Import center" };

export default function ImportsPage() {
  return <ImportCenter />;
}
