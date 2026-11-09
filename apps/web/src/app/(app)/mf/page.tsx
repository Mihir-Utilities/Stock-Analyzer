import type { Metadata } from "next";
import { MfBrowse } from "@/components/mf/MfBrowse";

export const metadata: Metadata = { title: "Mutual funds" };

export default function MfRoute() {
  return <MfBrowse />;
}
