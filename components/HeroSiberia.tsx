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
        alt="Сибирь осень 2026"
        sizes="(min-width: 512px) 512px, 100vw"
        className="h-auto w-full -rotate-10 translate-x-2"
      />
    </section>
  );
}
