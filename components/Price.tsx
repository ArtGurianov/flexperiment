import Image from "next/image";

import Section, { SectionLabel } from "@/components/Section";
import price from "@/public/price.webp";
import PaymentCta from "./PaymentCta";

/**
 * The price, as real HTML text.
 *
 * `price.webp` is 328KB — the second-heaviest asset on the site — and it used
 * to be the *only* representation of the price: the figure existed nowhere a
 * crawler, a screen reader or a text selection could reach it, and its alt text
 * said "3500р*", which is not what the base price is. The artwork stays as
 * decoration; the numbers below it are now the actual content.
 *
 * These figures are editorial, not occurrence-derived, and that is deliberate.
 * Commerce remains the sole authority on what any given date actually costs —
 * a quote comes from /v1/public/checkout-context, never from here. This is the
 * headline «from» price the page has always advertised, labelled as such, and
 * it must never be used as a fallback for a real occurrence's price in an event
 * page, in checkout or in JSON-LD. Equally, this section is never hidden
 * because inventory is empty: it is a statement about the workshop, not about
 * today's availability.
 */
export const Price = () => {
  return (
    <Section>
      <SectionLabel className="mb-[5cqw]">Стоимость участия</SectionLabel>

      <Image
        src={price}
        // aria-hidden with an empty alt: the figures below say everything this
        // says, and announcing them twice is worse than not announcing the
        // artwork at all.
        alt=""
        aria-hidden="true"
        sizes="(min-width: 512px) 512px, 100vw"
        className="h-auto w-full"
      />

      <p className="mt-[4cqw] text-center text-[clamp(0.85rem,3.2cqw,1rem)] text-bone/70">
        Базовая стоимость участия
      </p>

      <p className="mt-[1cqw] text-center font-display text-[clamp(1.6rem,7cqw,2.4rem)] leading-none text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
        <strong className="font-normal">3 800 ₽</strong>
      </p>

      <p className="mt-[3cqw] text-center text-[clamp(0.9rem,3.5cqw,1.1rem)] leading-snug text-bone">
        <strong className="font-normal text-acid">3 500 ₽</strong> при
        применении действующего промокода
      </p>

      <div className="flex justify-center">
        {/* Deliberately not full width — the CTA's narrowness against the
            near-edge-to-edge accordion below is what carries the composition. */}
        <PaymentCta className="w-fit max-w-full px-[6cqw] text-[clamp(1.25rem,6cqw,2.25rem)] mt-6">
          Забронировать место
        </PaymentCta>
      </div>
    </Section>
  );
};
