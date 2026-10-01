import type { Metadata } from "next";
import type { ReactNode } from "react";
import AnalyticsConsentManager, { AnalyticsSettingsButton } from "@/components/analytics/AnalyticsConsent";
import { platformOrigin } from "@/lib/origins";
import "./styles.css";

export const metadata: Metadata = {
  metadataBase: new URL(platformOrigin()),
  title: { default: "Flexperiment — курсы по флексингу", template: "%s — Flexperiment" },
  description: "Видео-курсы Арта Гурьянова: техника, музыкальность и личная пластика во флексинге.",
  openGraph: {
    type: "website",
    locale: "ru_RU",
    siteName: "Flexperiment",
    title: "Flexperiment — курсы по флексингу",
    description: "Видео-курсы Арта Гурьянова: техника, музыкальность и личная пластика во флексинге.",
  },
  verification: process.env.YANDEX_WEBMASTER_VERIFICATION
    ? { yandex: process.env.YANDEX_WEBMASTER_VERIFICATION }
    : undefined,
};

export default function FrontendLayout({ children }: { children: ReactNode }) {
  const origin = platformOrigin();
  const organization = {
    "@context": "https://schema.org", "@type": "Organization",
    name: "Flexperiment", url: origin,
  };
  return <html lang="ru"><body>{children}<footer><span>© Flexperiment</span><AnalyticsSettingsButton /></footer><AnalyticsConsentManager /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organization).replace(/</g, "\\u003c") }} /></body></html>;
}
