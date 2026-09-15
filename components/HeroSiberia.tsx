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
        className="h-auto w-full -rotate-10 translate-x-2"
      />
    </section>
  );
}
