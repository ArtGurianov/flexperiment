import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "FLEXPERIMENT / control room",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#10100e" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="ru"><body><Providers>{children}</Providers></body></html>;
}
