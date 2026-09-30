import type { Metadata } from "next";
import type { ReactNode } from "react";
import AnalyticsConsentManager, { AnalyticsSettingsButton } from "@/components/analytics/AnalyticsConsent";
import "./styles.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001"),
  title: { default: "Flexperiment — курсы по флексингу", template: "%s — Flexperiment" },
  description: "Видео-курсы Арта Гурьянова: техника, музыкальность и личная пластика во флексинге.",
};

export default function FrontendLayout({ children }: { children: ReactNode }) {
  const origin = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";
  const organization = {
    "@context": "https://schema.org", "@type": "Organization",
    name: "Flexperiment", url: origin,
  };
  return <html lang="ru"><body>{children}<footer><span>© Flexperiment</span><AnalyticsSettingsButton /></footer><AnalyticsConsentManager /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organization).replace(/</g, "\\u003c") }} /></body></html>;
}
