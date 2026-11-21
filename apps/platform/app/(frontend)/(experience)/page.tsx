import type { Metadata } from "next";
import { Suspense } from "react";
import HomeCourseHero, { HomeHero } from "@/components/home/HomeCourseHero";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function HomePage() {
  return <Suspense fallback={<HomeHero />}><HomeCourseHero /></Suspense>;
}
