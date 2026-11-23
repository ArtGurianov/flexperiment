import type { Metadata } from "next";
import Link from "next/link";
import AccountClient from "@/components/auth/AccountClient";
import { Suspense } from "react";
import { enrollmentAccountPath, parseEnrollmentIntent } from "@/components/courses/freeEnrollment";

export const metadata: Metadata = { title: "Мои курсы", robots: { index: false, follow: false } };

type AccountSearch = { next?: string; enroll?: string; lesson?: string };

async function AccountContent({ searchParams }: { searchParams: Promise<AccountSearch> }) {
  const query = await searchParams;
  const requested = query.next;
  // FLEX-128: the chosen course and lesson survive the magic-link login inside the callback URL itself.
  const enrollIntent = parseEnrollmentIntent(query.enroll, query.lesson);
  const nextPath = enrollIntent ? enrollmentAccountPath(enrollIntent)
    : typeof requested === "string" && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/account";
  // searchParams already makes this subtree request-rendered. Only the public key crosses RSC.
  const captchaSiteKey = process.env.SMARTCAPTCHA_CLIENT_KEY || process.env.NEXT_PUBLIC_SMARTCAPTCHA_CLIENT_KEY;
  return <main className="accountPage"><nav className="nav"><Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link><Link href="/courses">← Курсы</Link></nav><AccountClient nextPath={nextPath} captchaSiteKey={captchaSiteKey} enrollIntent={enrollIntent ?? undefined} /></main>;
}

export default function AccountPage(props: { searchParams: Promise<AccountSearch> }) {
  return <Suspense fallback={<main className="accountPage"><p>Загружаем вход…</p></main>}><AccountContent {...props} /></Suspense>;
}
