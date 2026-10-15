import Link from "next/link";
import AccountClient from "@/components/auth/AccountClient";
import { Suspense } from "react";

async function AccountContent({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const requested = (await searchParams).next;
  const nextPath = typeof requested === "string" && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/account";
  // searchParams already makes this subtree request-rendered. Only the public key crosses RSC.
  const captchaSiteKey = process.env.SMARTCAPTCHA_CLIENT_KEY || process.env.NEXT_PUBLIC_SMARTCAPTCHA_CLIENT_KEY;
  return <main className="accountPage"><nav className="nav"><Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link><Link href="/courses">← Курсы</Link></nav><AccountClient nextPath={nextPath} captchaSiteKey={captchaSiteKey} /></main>;
}

export default function AccountPage(props: { searchParams: Promise<{ next?: string }> }) {
  return <Suspense fallback={<main className="accountPage"><p>Загружаем вход…</p></main>}><AccountContent {...props} /></Suspense>;
}
