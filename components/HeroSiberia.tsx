import Image from "next/image";

import hero from "@/public/hero.webp";

export default function HeroSiberia() {
  return (
    <section className="flex flex-col w-full items-center justify-center">
      {/* The column caps at max-w-lg, so a bare `100vw`/`50vw` had the
          optimizer serving a candidate sized to the whole viewport — roughly
          3x the rendered width on a desktop screen. */}
      <Image
        src={hero}
        // The artwork is the poster, and the alt text is its description — not
        // a slot for keyword copy the sighted visitor never sees. The old value
        // asserted a season and a year nothing else on the page carries.
        alt="Постер FLEXPERIMENT «Впервые в Сибири»"
        sizes="(min-width: 512px) 512px, 100vw"
        // Deliberately left at next/image's default lazy loading, and
        // deliberately NOT given `priority`. This is the obvious candidate —
        // the largest <img> above the fold at both phone and desktop widths
        // (measured 573x479 at 1440x900, 471px down a 900px viewport) — which
        // is exactly why the reasoning is recorded here.
        //
        // The page's LCP element is not an <img> at all. It is /background.webp,
        // which paints as the bg-site layer on desktop and as the hero video's
        // poster on a phone, and it is already preloaded from the document head
        // with fetchPriority="high" (app/layout.tsx) — the strongest hint
        // available. `priority` here would emit a *second* head preload, for a
        // 620KB file, competing with it: measured on a throttled profile, that
        // moved background.webp's request from 587ms to 1813ms into the load.
        //
        // The right treatment for the second-largest image is to leave the
        // largest one's lane clear.
        className="h-auto w-full -rotate-10 translate-x-2"
      />
    </section>
  );
}
