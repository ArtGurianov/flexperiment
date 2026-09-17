import type { Metadata } from "next";
import Link from "next/link";

import Footer from "@/components/Footer";
import Navbar from "@/components/Navbar";
import PaymentNotice from "@/components/PaymentNotice";
import LiveScheduleView from "@/components/LiveScheduleView";
import Section, { SectionLabel } from "@/components/Section";
import { OPEN_GRAPH_BASE, TWITTER_CARD } from "@/lib/seo/site";
import { toScheduleViewModel } from "@/lib/seo/schedule-view-model";
import { publishedRecords } from "@/lib/seo/snapshot-source";

/**
 * The one indexable catalogue of cities and dates.
 *
 * It replaces the home → city → event chain, where /cities/[city] existed
 * mainly as link plumbing between the two pages anyone actually wanted. The
 * chain is now:
 *
 *     /  →  /schedule  →  /events/[slug]
 *
 * and every hop is a real <a href>. The booking CTAs on the home page point
 * here; in PR2 they open this same content in a drawer on soft navigation
 * while remaining ordinary links to a crawler, a middle-click, or a refresh.
 *
 * Rendered from the committed SEO snapshot at build time, so this is static
 * HTML with no request-time work. Live commerce state — seats, sales status,
 * promo, quote — is never read here; it belongs to the client on the event
 * page and in checkout.
 *
 * Unlike the dynamic routes, this one always exists, even with an empty
 * snapshot: it is a fixed route, so there is no generateStaticParams to go
 * empty, and a schedule that honestly says nothing is announced yet is a
 * better answer than a 404.
 */
const TITLE = "Города и даты мастер-классов | FLEXPERIMENT";
const DESCRIPTION =
  "Расписание мастер-классов FLEXPERIMENT по флексингу и experimental dance: " +
  "города, даты, площадки и стоимость участия. Преподаватель — Арт Гурьянов.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/schedule" },
  openGraph: {
    ...OPEN_GRAPH_BASE,
    url: "/schedule",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/opengraph-image.png"],
  },
  twitter: {
    card: TWITTER_CARD,
    title: TITLE,
    description: DESCRIPTION,
    images: ["/twitter-image.png"],
  },
};

export default function SchedulePage() {
  const model = toScheduleViewModel(publishedRecords());

  return (
    <>
      <Navbar />

      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col overflow-x-clip outline-none"
      >
        {/* pt-14 clears the Navbar. That bar is a sticky ZERO-HEIGHT wrapper
            (components/Navbar.tsx) — it reserves no strip and deliberately
            floats over whatever follows, which is right for the home page's
            hero artwork and wrong for a text page, where Section's default
            py-10 left the back link sitting under it. 14 is the same 3.5rem
            SECTION_SHELL already uses for `scroll-mt-14`, the constant this
            codebase uses for exactly this clearance. The legal pages avoid the
            problem only by rendering no Navbar at all. */}
        <Section className="pt-14 pb-[10cqw]">
          <Link
            href="/"
            className="mb-[6cqw] inline-block text-[clamp(0.8rem,3cqw,1rem)] text-acid underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid"
          >
            ← На главную
          </Link>

          <h1 className="font-display text-[clamp(1.5rem,7cqw,2.4rem)] leading-tight text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
            Города × Даты
          </h1>

          <p className="mt-[5cqw] text-[clamp(0.95rem,3.8cqw,1.2rem)] leading-relaxed text-bone/85">
            Изоляции тела, иллюзии в танце, импровизация и поиск собственного
            стиля. Для любого уровня подготовки — растяжка не нужна.
          </p>

          <SectionLabel className="mt-[9cqw] mb-[5cqw]">Расписание</SectionLabel>

          <LiveScheduleView initialModel={model} />
        </Section>
      </main>

      <Footer />

      {/* Navbar and Footer each render a PaymentCta, so the shared failure
          notice is required here as it is on every page that has one. */}
      <PaymentNotice />
    </>
  );
}
