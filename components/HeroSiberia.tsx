import Image from "next/image";

import year2026 from "@/public/2026.webp";
import siberia from "@/public/siberia.webp";

export default function HeroSiberia() {
  return (
    <section className="flex flex-col w-full items-center justify-center">
      <Image
        src={siberia}
        alt="Сибирь"
        sizes="100vw"
        className="h-auto w-full -rotate-12"
      />
      <Image
        src={year2026}
        alt="2026"
        sizes="50vw"
        className="h-auto w-1/2 self-end -translate-y-1/3"
      />
    </section>
  );
}
