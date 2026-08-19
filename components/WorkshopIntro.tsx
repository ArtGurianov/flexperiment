import Image from "next/image";

import DarkPanel from "@/components/DarkPanel";
import PaymentCta from "@/components/PaymentCta";
import Section from "@/components/Section";
import body from "@/public/body.webp";

// Type scales with `cqw` rather than `vw` because the page sits in a fixed
// max-w-lg column — viewport units would keep growing on a wide screen while
// the column stayed 512px, blowing the headline out of its container.
export default function WorkshopIntro() {
  return (
    <Section>
      <h2 className="relative z-30 text-end text-[clamp(1.75rem,8.6cqw,2.75rem)] leading-[1.3] tracking-[0.015em] uppercase text-acid [text-shadow:2px_3px_0_rgb(0_0_0_/_0.9),0_0_4px_rgb(202_255_86_/_0.25)]">
        Разблокируй новый уровень контроля над телом
      </h2>

      {/* The dancer and the panel share one grid cell, so the row is as tall as
          whichever is taller and the overlap survives any column width. */}
      <div className="mt-[6cqw] grid grid-cols-1 grid-rows-1">
        <Image
          src={body}
          alt=""
          aria-hidden="true"
          sizes="(min-width: 512px) 269px, 50vw"
          className="pointer-events-none z-20 col-start-1 row-start-1 -ml-[6cqw] h-auto w-[56cqw] select-none self-end justify-self-start"
        />

        {/* Left padding is wider than right: the figure now reaches ~46cqw, so
            the copy starts past it instead of being overlapped. */}
        <DarkPanel className="z-10 col-start-1 row-start-1 w-[60cqw] self-end justify-self-end pt-[6cqw] px-[5cqw] pb-[5cqw] text-center">
          <h3 className="text-[clamp(1.45rem,6.4cqw,2rem)] leading-tight tracking-[0.015em] uppercase underline decoration-2 underline-offset-8">
            Впервые в Сибири
          </h3>

          {/* Width-constrained instead of hard line breaks, so the copy rewraps
              instead of breaking at odd points when the column narrows. */}
          <p className="mx-auto mt-[5cqw] max-w-[15.5em] text-[clamp(1.05rem,4.3cqw,1.4rem)] leading-[1.47] tracking-[0.015em]">
            Мастер-классы по EXPERIMENTAL DANCE х FLEXING - изоляции тела, иллюзии в танце,
            импровизация и создание индивидуального стиля. Научись двигаться,
            как никто другой.
          </p>

          <PaymentCta className="mt-[6cqw] min-h-[3.5rem] text-[clamp(1.15rem,4.8cqw,1.6rem)]">
            Города × Даты
          </PaymentCta>
        </DarkPanel>
      </div>
    </Section>
  );
}
