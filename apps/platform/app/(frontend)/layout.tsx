import Navbar from "@/components/navbar/Navbar";
import { storefrontMyOrigin } from "../../../../lib/my-storefront";
import { connection } from "next/server";
import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
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

async function RuntimeNavbar() {
  await connection();
  const myOrigin = storefrontMyOrigin(process.env);
  return myOrigin ? <Navbar myOrigin={myOrigin} /> : null;
}

export default function FrontendLayout({ children }: { children: ReactNode }) {
  const origin = platformOrigin();
  const organization = {
    "@context": "https://schema.org", "@type": "Organization",
    name: "Flexperiment", url: origin,
  };
  return <html lang="ru"><body><Suspense fallback={null}><RuntimeNavbar /></Suspense>{children}<footer><span>© Flexperiment</span><AnalyticsSettingsButton /></footer><Suspense fallback={null}><AnalyticsConsentManager /></Suspense><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organization).replace(/</g, "\\u003c") }} /></body></html>;
}
