import Image from "next/image";

import Section, { SectionLabel } from "@/components/Section";
import price from "@/public/price.webp";
import ScheduleLink from "@/components/ScheduleLink";

/**
 * The price section, restored to its original composition.
 *
 * An earlier SEO pass replaced the artwork's caption with separate, visibly
 * typeset «3 800 ₽» and «3 500 ₽» blocks so the figures would exist as crawlable
 * text. That worked, and it also redesigned the section — which was not a
 * change SEO had any business making. The artwork plus one caption is the
 * design; it is back.
 *
 * The readable-text requirement is met by `alt` instead, which is where it
 * belonged. `price.webp` genuinely depicts those two figures, so the alt below
 * is an honest text equivalent of the image — not keyword copy smuggled into an
 * attribute. (Contrast HeroSiberia, whose alt once asserted a season and a year
 * the artwork does not show; that one was keyword stuffing and stays fixed.)
 *
 * These figures are editorial. Commerce is the sole authority on what any given
 * date costs — /schedule and /events/[slug] render each occurrence's own
 * `price_kopecks`, and there is deliberately no fallback in either direction.
 */
export const Price = () => {
  return (
    <Section>
      <SectionLabel className="mb-[5cqw]">Стоимость участия</SectionLabel>

      <Image
        src={price}
        alt="3500 ₽ с действующим промокодом; 3800 ₽ без промокода"
        sizes="(min-width: 512px) 512px, 100vw"
        className="h-auto w-full"
      />

      <p className="mt-[2cqw] text-center text-[clamp(0.9rem,3.5cqw,1.1rem)] text-bone">
        *при применении действующего промокода или 3800р
      </p>

      <div className="flex justify-center">
        {/* A real <a href="/schedule">, intercepted into a drawer on the home
            page and ordinary navigation everywhere else. Deliberately not full
            width — the CTA's narrowness against the near-edge-to-edge accordion
            below is what carries the composition. */}
        <ScheduleLink className="w-fit max-w-full px-[6cqw] text-[clamp(1.25rem,6cqw,2.25rem)] mt-6">
          Забронировать место
        </ScheduleLink>
      </div>
    </Section>
  );
};
