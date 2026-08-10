import Image from "next/image";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/Accordion";
import PaymentCta from "@/components/PaymentCta";
import footerOrnament from "@/public/footer.webp";

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
    question: "Я дерево... Нужна ли растяжка?",
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
    /* No bottom padding — the footer bar is meant to sit flush against the
       section's bottom edge, which is also the page's. */
    /* Height is content-driven on purpose. A min-h of 100svh plus a flex-1
       spacer used to pin the footer to the viewport bottom, but the copy is
       sized in cqw, so a narrower column shrinks the content while the viewport
       stays tall — on a phone that left 150-220px of dead space above the
       footer. This is the last section of a page that always exceeds one
       viewport, so the footer reaches the document bottom regardless. */
    <section
      id="faq"
      className="@container relative isolate flex w-full scroll-mt-14 flex-col overflow-hidden px-4 pt-10 font-display text-bone"
    >
      <div className="flex justify-center">
        {/* Deliberately not full width — the CTA's narrowness against the
            near-edge-to-edge accordion below is what carries the composition. */}
        <PaymentCta className="w-fit max-w-full px-[6cqw] text-[clamp(1.25rem,6cqw,2.25rem)]">
          Забронировать место
        </PaymentCta>
      </div>

      <h2 className="mt-[10cqw] mb-[5cqw] pr-[2cqw] text-right text-[clamp(1.15rem,5cqw,1.6rem)] leading-none uppercase text-acid">
        Вопросы
      </h2>

      <Accordion type="single" collapsible className="flex flex-col gap-[4cqw]">
        {FAQ.map(({ question, answer }) => (
          <AccordionItem key={question} value={question}>
            {/* The marker is drawn rather than delegated to list-style: the
                trigger is a <button>, and a real <ol>/<li> is invalid inside
                one — Tailwind's Preflight also strips list markers globally,
                so a bare list renders nothing. Matches the diamond used in
                TeacherCredentials. */}
            <AccordionTrigger className="min-h-[4.5rem] text-[clamp(1rem,4.4cqw,1.5rem)]">
              <span className="flex items-center gap-[0.7em] text-left">
                <span
                  aria-hidden="true"
                  className="size-[0.24em] shrink-0 rotate-45 bg-bone"
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
      <p className="mx-auto mt-[11cqw] max-w-[22em] text-center text-[clamp(1.05rem,4.4cqw,1.5rem)] leading-[1.5] text-acid [text-shadow:2px_3px_0_#111]">
        «Тебя не учат танцевать как я.
        <br />
        Я учу тебя находить то, как можешь двигаться ты. Это мастер-класс по
        развитию собственного языка движения через флексинг. До встречи!»
      </p>

      {/* -mx-4 cancels the section's horizontal padding so the bar spans the
          full column while its own px-4 keeps the text off the edges. The top
          margin is a fixed gap now that no spacer sets the distance. */}
      <footer className="relative z-30 -mx-4 mt-[10cqw] flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-[rgb(22_20_18_/_0.5)] px-4 py-3 text-[clamp(0.7rem,2.7cqw,0.9rem)] leading-tight uppercase">
        <span>ИП Гурьянов Арт Артурович</span>
        <a href="/offer" className="underline-offset-4 hover:underline">
          Оферта
        </a>
        <span>flextatic.ru 2026</span>
      </footer>

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
        sizes="(min-width: 512px) 512px, 100vw"
        className="pointer-events-none absolute right-0 bottom-0 -z-10 w-2/3 max-w-none translate-x-1/3 translate-y-1/3 select-none rotate-45"
      />
    </section>
  );
}
