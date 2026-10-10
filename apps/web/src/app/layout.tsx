import type { ReactNode } from "react";

export const metadata = {
  title: "India Stock & MF Analyzer",
  description: "Personal research tool. Not investment advice.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
