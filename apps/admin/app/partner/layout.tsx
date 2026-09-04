import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "FLEXPERIMENT / partner portal",
  robots: { index: false, follow: false },
};

export default function PartnerLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
