import Image from "next/image";

import DarkPanel from "@/components/DarkPanel";
import Section, { SectionLabel } from "@/components/Section";
import TeacherCredentials from "@/components/TeacherCredentials";
import TeacherHead from "@/components/TeacherHead";
import nameArt from "@/public/name.webp";

export default function TeacherSection() {
  return (
    <Section id="teacher">
      <header>
        <SectionLabel className="mb-[3cqw]">Преподаватель</SectionLabel>

        {/* 1831x469, cropped flush to the lettering apart from 18px of dead
            space along the top - the descenders run right to the last row, so
            there is nothing to trim at the bottom. -mt-[1%] absorbs that band:
            margin percentages resolve against the container's width, and 18px
            is 0.98% of the file's 1831px width. */}
        <Image
          src={nameArt}
          alt="Арт Гурьянов"
          sizes="(min-width: 512px) 480px, 100vw"
          className="-mt-[1%] h-auto w-full"
        />
      </header>

      <DarkPanel className="mt-[6cqw] px-[6cqw] py-[7cqw]">
        <p className="text-center text-[clamp(1rem,4.1cqw,1.35rem)] leading-[1.75] tracking-[0.01em]">
          - "Когда Флекс только появлялся в России, мы участвовали в баттлах и
          ТВ-шоу, пытались показать этот стиль как можно большему количеству
          людей. Но со временем направление практически исчезло из поля зрения.
          Моя миссия - передать опыт и зажечь тех, кто сформирует новое
          поколение."
        </p>
      </DarkPanel>

      {/* Even 50/50 split, bottom-aligned so the portrait sits on the same
          baseline as the last credential. The half-width column is what sets
          the credential type size — see TeacherCredentials. */}
      <div className="mt-[8cqw] grid grid-cols-2 items-center">
        <TeacherCredentials />
        <TeacherHead className="w-full" />
      </div>
    </Section>
  );
}
