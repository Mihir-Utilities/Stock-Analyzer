import type { Metadata } from "next";
import { MfDetail } from "@/components/mf/MfDetail";

type Props = { params: Promise<{ code: string }> };

export const metadata: Metadata = { title: "Fund" };

export default async function MfDetailRoute({ params }: Props) {
  const { code } = await params;
  return <MfDetail code={code} />;
}
