import Image from "next/image";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/Accordion";
import Diamond from "@/components/Diamond";
import Section, { SectionLabel } from "@/components/Section";
import footerOrnament from "@/public/hero4.webp";

const FAQ = [
  {
    question: "Для кого? Подойдет ли мне?",
    answer:
      "Даже если ты никогда не занимался флексингом. Мастер-класс подойдет и новичкам, и танцорам с опытом: начнем с базовой механики движений и постепенно соберем ее в связки. Главное - желание пробовать и двигаться.",
  },
  {
    question: "Я занимаюсь другим стилем",
    answer:
      "Отлично. Тебе не нужно переучиваться или отказываться от своего стиля. Флексинг даст новые принципы работы с телом, изоляциями и иллюзиями, которые можно добавить в хип-хоп, контемп, вог и другие направления.",
  },
  {
    question: "Я дерево… Нужна ли растяжка?",
    answer:
      "Нет. Шпагаты и специальная растяжка не нужны. Мы работаем прежде всего с контролем тела, суставами, изоляциями и координацией. Все упражнения можно выполнять в комфортной для себя амплитуде.",
  },
  {
    question: "Какую одежду взять с собой?",
    answer:
      "Любую удобную одежду, которая не ограничивает движения: футболку или лонгслив, свободные штаны и чистые кроссовки. Возьми воду. Специальная форма или экипировка не нужны.",
  },
];

export default function FaqSection() {
  return (
    /* Height is content-driven on purpose. A min-h of 100svh plus a flex-1
       spacer used to pin the footer to the viewport bottom, but the copy is
       sized in cqw, so a narrower column shrinks the content while the viewport
       stays tall — on a phone that left 150-220px of dead space above the
       footer. This is the last section of a page that always exceeds one
       viewport, so the footer reaches the document bottom regardless. */
    /* pb-6 tightens the shell's py-10 above the footer bar, and must stay a
       fixed length. Container units are illegal here: cqw resolves against the
       nearest *ancestor* query container, and an element is never its own — so
       a cqw padding on this element, which is itself the @container, skips past
       the 512px column to the viewport. That is what made the gap grow without
       bound on wide screens (168px at 1400px) while every cqw inside the
       section, which does see this container, stayed put. */
    <Section id="faq" className="isolate flex flex-col pb-6">
      <SectionLabel className="mb-[5cqw]">Вопросы</SectionLabel>

      <Accordion type="single" collapsible className="flex flex-col gap-[4cqw]">
        {FAQ.map(({ question, answer }) => (
          <AccordionItem key={question} value={question}>
            <AccordionTrigger className="min-h-[4.5rem] text-[clamp(1rem,4.4cqw,1.5rem)]">
              <span className="flex items-center gap-[0.7em] text-left">
                <Diamond
                  className="size-[0.24em] bg-bone"
                  wrapperClassName="shrink-0"
                />
                {question}
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-[clamp(0.9rem,3.6cqw,1.15rem)]">
              {answer}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>

      {/* Wrapping is left to CSS apart from the one conceptual break after the
          opening line, so the quote reflows instead of breaking at odd points. */}
      <p className="mx-auto mt-[11cqw] max-w-[22em] text-center text-[clamp(1.05rem,4.4cqw,1.5rem)] leading-[1.5] text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
        «Тебя не учат танцевать как я.
        <br />
        Я учу тебя находить то, как можешь двигаться ты. Это мастер-класс по
        развитию собственного языка движения через флексинг. До встречи!»
      </p>

      {/* Centred on the section's bottom-right corner, so only its upper-left
          quadrant shows — the translate pair is what moves the image's centre
          there rather than its corner. Half the width sits off-screen, so a
          full-width element is what makes the visible part read as half the
          column. max-w-none defeats the global img { max-width: 100% } that
          would otherwise cap the overhang.

          -z-10 keeps it behind the copy: a positioned element paints above
          non-positioned content at any non-negative z-index, so at this size it
          would otherwise cover the quote and accordion. The section's `isolate`
          is what stops the negative layer from sliding behind the page
          background entirely. */}
      <Image
        src={footerOrnament}
        alt=""
        aria-hidden="true"
        sizes="(min-width: 512px) 341px, 67vw"
        className="pointer-events-none absolute right-0 bottom-0 -z-10 w-1/3 max-w-none select-none"
      />
    </Section>
  );
}
