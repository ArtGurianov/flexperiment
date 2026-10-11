import type { Metadata } from "next";
import "./styles.css";
export const metadata: Metadata = { title: "Flexperiment LAB · Canary", robots: { index: false, follow: false } };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="ru"><body>{children}</body></html>;
}
