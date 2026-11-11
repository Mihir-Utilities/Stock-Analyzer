import type { Metadata } from "next";
import { AdminStatus } from "@/components/admin/AdminStatus";

export const metadata: Metadata = { title: "Admin status" };

export default function AdminStatusRoute() {
  return <AdminStatus />;
}
