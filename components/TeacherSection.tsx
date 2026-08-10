import Image from "next/image";

import DarkPanel from "@/components/DarkPanel";
import TeacherCredentials from "@/components/TeacherCredentials";
import TeacherHead from "@/components/TeacherHead";
import nameArt from "@/public/name.webp";

export default function TeacherSection() {
  return (
    <section className="@container relative w-full overflow-hidden px-4 py-10 font-display text-bone">
      <header>
        <p className="mb-[3cqw] pr-[2%] text-right text-[clamp(1.15rem,5cqw,1.6rem)] leading-none uppercase text-acid">
          Преподаватель
        </p>

        {/* The lettering only occupies 32.5%-72.5% of this file's height, so at
            w-full it would open ~52px of phantom gap above and 43px below. The
            negative margins trim exactly that: margin percentages resolve
            against the container's width, and the padding is 10.8% / 9.0% of
            the width once the 3:1 aspect ratio is folded in. */}
        <Image
          src={nameArt}
          alt="Арт Гурьянов"
          sizes="(min-width: 512px) 480px, 100vw"
          className="-mt-[10.8%] -mb-[9%] h-auto w-full"
        />
      </header>

      <DarkPanel className="mt-[6cqw] px-[6cqw] py-[7cqw]">
        <p className="text-center text-[clamp(1rem,4.1cqw,1.35rem)] leading-[1.75] tracking-[0.01em]">
          — Когда Флекс только появлялся в России, мы участвовали в баттлах и
          ТВ-шоу, пытались показать этот стиль как можно большему количеству
          людей. Но со временем направление практически исчезло из поля зрения.
          Моя миссия — передать опыт и зажечь тех, кто сформирует новое
          поколение.
        </p>
      </DarkPanel>

      {/* Even 50/50 split, bottom-aligned so the portrait sits on the same
          baseline as the last credential. The half-width column is what sets
          the credential type size — see TeacherCredentials. */}
      <div className="mt-[8cqw] grid grid-cols-2 items-end">
        <TeacherCredentials />
        <TeacherHead className="w-full" />
      </div>
    </section>
  );
}
