import PaymentCta from "@/components/PaymentCta";
import AnalyticsSettingsButton from "@/components/AnalyticsSettingsButton";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { LEGAL_DOCUMENTS } from "@/lib/legal";
import { BOOKING_LABEL, SITE_LINKS } from "@/lib/navigation";

const LINK =
  "w-fit underline-offset-4 transition-colors duration-200 motion-reduce:transition-none hover:text-acid hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid";

/** Announced by screen readers, never shown — see the legal links below. */
const NEW_TAB_HINT = " (откроется в новой вкладке)";

/**
 * The two informational columns: document titles and company details.
 *
 * Mono rather than the display face, which is a poster type — at footer size it
 * turns a 40-character legal title into a smear and gives a 13-digit ОГРНИП no
 * figure separation at all. The step down in size is what pays for mono's
 * wider advance, so the columns wrap no more than they did before.
 */
const PLAIN = "font-mono text-[clamp(0.62rem,2.4cqw,0.78rem)] tracking-tight";

/**
 * The site footer, rendered at the end of every route.
 *
 * `@container` rather than the section's: the footer spans the full column
 * while a section's container is inset by its padding, so sizing against the
 * parent would make the same text a step smaller here than in the navbar. It
 * also lets the three columns collapse to one on the narrowest phones, where
 * splitting ~290px three ways leaves the legal titles unreadable.
 */
export default function Footer({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        "@container relative z-30 w-full bg-panel px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))] font-display leading-tight text-bone uppercase",
        className,
      )}
    >
      {/* The type lives on this wrapper, not on <footer>. cqw resolves against
          the nearest ancestor container and an element is never its own, so a
          clamp on the container element itself would have measured the
          viewport instead of the footer. */}
      <div className="text-[clamp(0.7rem,2.7cqw,0.9rem)]">
        <div className="grid grid-cols-1 gap-x-[4cqw] gap-y-6 @xs:grid-cols-3">
        <nav
          aria-label="Разделы сайта"
          className="flex flex-col items-center gap-2"
        >
          {/* text-[1em] rather than the CTA's own sizing so the button tracks
              the footer's clamp instead of introducing a third type step. */}
          <PaymentCta className="mb-1 border-2 px-2 py-1.5 text-[1em]">
            {BOOKING_LABEL}
          </PaymentCta>

          {SITE_LINKS.map(({ label, href }) => (
            <a key={href} href={href} className={LINK}>
              {label}
            </a>
          ))}
          <Link href="/refund" className={LINK}>Отмена и возврат</Link>
        </nav>

        {/* Opened in a new tab on purpose: these are most often reached from a
            checkout or consent step, and losing that state to read the offer is
            worse than an extra tab. Sighted users get the cue from the tab
            appearing; the hidden suffix is what gives everyone else the same
            warning before they activate the link. */}
        <nav
          aria-label="Правовые документы"
          className={cn("flex flex-col items-start gap-2", PLAIN)}
        >
          {LEGAL_DOCUMENTS.map(({ slug, label }) => (
            <a
              key={slug}
              href={`/legal/${slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK}
            >
              {label}
              <span className="sr-only">{NEW_TAB_HINT}</span>
            </a>
          ))}
        </nav>

        {/* not-italic because a UA stylesheet italicises <address>, and an
            oblique mono here would read as emphasis on the company details. */}
        <div className={cn("flex flex-col items-start gap-1", PLAIN)}>
          <address className="flex flex-col items-start gap-1 not-italic">
            <span>ИП Гурьянов Арт Артурович</span>
            <span>ИНН 420539506224</span>
            <span>ОГРНИП 324420500074591</span>
            <a href="tel:+79267280420" className={LINK}>
              +7 926 728-04-20
            </a>
            {/* normal-case only here: an uppercased address reads as a different
                string, and people do retype what a footer shows. */}
            <a
              href="mailto:art@flexperiment.ru"
              className={cn(LINK, "normal-case")}
            >
              art@flexperiment.ru
            </a>
          </address>
          <AnalyticsSettingsButton className={cn(LINK, "mt-1 text-left")} />
        </div>
        </div>

        <p className="mt-6 border-t border-bone/15 pt-3 text-center text-bone/60">
          © 2026 flexperiment.ru
        </p>
      </div>
    </footer>
  );
}
