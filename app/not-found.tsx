import type { Metadata } from "next";
import Link from "next/link";

import Footer from "@/components/Footer";
import Section, { SectionLabel } from "@/components/Section";
import { LEGAL_DOCUMENTS } from "@/lib/legal";
import { SITE_LINKS } from "@/lib/navigation";

/**
 * There was no not-found.tsx, so `out/404.html` was Next's stock page — served
 * on a site whose nginx did not even route unknown URLs to it, and carrying the
 * home page's canonical and description inherited from the root layout.
 *
 * Deliberately noindex without a canonical: a 404 is not a duplicate of
 * anything, so there is no other URL to point at.
 *
 * Next emits its own `noindex` for the not-found route, so the built HTML
 * carries two identical directives. The declaration is kept anyway: it states
 * the intent in the file that owns the page rather than relying on a framework
 * default that a future version could change.
 */
export const metadata: Metadata = {
  title: "Страница не найдена | FLEXPERIMENT",
  description: "Запрошенная страница не найдена на flexperiment.ru.",
  robots: { index: false },
};

const LINK =
  "text-acid underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid";

/**
 * Mirrors the legal pages' chrome rather than the home page's: Section plus
 * Footer, no Navbar and no AssetPreloader. The preloader is home-page-only by
 * design (it gates on [data-hero-video]), and a 404 that sat behind a loading
 * overlay would be the worst version of this page.
 *
 * No <PaymentNotice /> is needed here because nothing on this page renders a
 * PaymentCta — except the Footer, which does. So it is mounted below.
 */
export default function NotFound() {
  return (
    <>
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col overflow-x-clip outline-none"
      >
        <Section className="pb-[10cqw]">
          <SectionLabel className="mb-[6cqw]">404</SectionLabel>

          <h1 className="font-display text-[clamp(1.4rem,6.5cqw,2.2rem)] leading-tight text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
            Такой страницы нет
          </h1>

          <p className="mt-[5cqw] text-[clamp(0.9rem,3.6cqw,1.15rem)] leading-relaxed text-bone/85">
            Возможно, ссылка устарела или в адресе опечатка.
          </p>

          <nav
            aria-label="Куда перейти"
            className="mt-[7cqw] flex flex-col items-start gap-[2.5cqw] text-[clamp(0.9rem,3.6cqw,1.15rem)]"
          >
            <Link href="/" className={LINK}>
              На главную
            </Link>
            {SITE_LINKS.map(({ label, href }) => (
              <a key={href} href={href} className={LINK}>
                {label}
              </a>
            ))}
          </nav>

          <nav
            aria-label="Правовые документы"
            className="mt-[7cqw] flex flex-col items-start gap-[2cqw] font-mono text-[clamp(0.7rem,2.9cqw,0.85rem)]"
          >
            {LEGAL_DOCUMENTS.map(({ slug, label }) => (
              <a key={slug} href={`/legal/${slug}`} className={LINK}>
                {label}
              </a>
            ))}
          </nav>
        </Section>
      </main>

      <Footer />
    </>
  );
}
