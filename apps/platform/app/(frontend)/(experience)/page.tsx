import type { Metadata } from "next";
import { Suspense } from "react";
import HomeCourseHero, { HomeHero } from "@/components/home/HomeCourseHero";

// A page-level openGraph replaces the layout's entirely, so the shared fields are repeated with og:url.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    type: "website", locale: "ru_RU", siteName: "Flexperiment", url: "/",
    title: "Flexperiment — курсы по флексингу",
    description: "Видео-курсы Арта Гурьянова: техника, музыкальность и личная пластика во флексинге.",
  },
};

export default function HomePage() {
  return <Suspense fallback={<HomeHero />}><HomeCourseHero /></Suspense>;
}
