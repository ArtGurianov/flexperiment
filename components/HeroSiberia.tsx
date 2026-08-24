import Image from "next/image";

import autumn2026 from "@/public/autumn2026.webp";
import siberia from "@/public/siberia.webp";

export default function HeroSiberia() {
  return (
    <section className="flex flex-col w-full items-center justify-center">
      {/* The column caps at max-w-lg, so a bare `100vw`/`50vw` had the
          optimizer serving a candidate sized to the whole viewport — roughly
          3x the rendered width on a desktop screen. */}
      <Image
        src={siberia}
        alt="Сибирь"
        sizes="(min-width: 512px) 512px, 100vw"
        className="h-auto w-full -rotate-12"
      />
      <Image
        src={autumn2026}
        alt="осень 2026"
        sizes="(min-width: 512px) 256px, 50vw"
        className="h-auto w-full -translate-y-1/3 px-6"
      />
    </section>
  );
}
