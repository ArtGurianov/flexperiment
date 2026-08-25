import Image from "next/image";

import Section, { SectionLabel } from "@/components/Section";
import price from "@/public/price.webp";
import PaymentCta from "./PaymentCta";

export const Price = () => {
  return (
    <Section>
      <SectionLabel className="mb-[5cqw]">Стоимость участия</SectionLabel>

      <Image
        src={price}
        alt="3500р*"
        sizes="(min-width: 512px) 512px, 100vw"
        className="h-auto w-full"
      />

      <p className="mt-[2cqw] text-center text-[clamp(0.9rem,3.5cqw,1.1rem)] text-bone">
        *при применении действующего промокода или 3800р
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
