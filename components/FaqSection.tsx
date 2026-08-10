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
      "Даже если ты никогда не занимался флексингом. Мастер-класс подойдет и новичкам, и танцорам с опытом: начнем с базовой механики движений и постепенно соберем ее в связки. Главное — желание пробовать и двигаться.",
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
    <section className="@container relative isolate flex min-h-[100svh] w-full flex-col overflow-hidden px-4 pt-10 font-display text-bone">
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
            <AccordionTrigger className="min-h-[4.5rem] text-[clamp(1rem,4.4cqw,1.5rem)]">
              {question}
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

      {/* Absorbs leftover height so the legal row sits at the bottom on tall
          screens without being absolutely positioned. */}
      <div className="min-h-8 flex-1" />

      {/* -mx-4 cancels the section's horizontal padding so the bar spans the
          full column while its own px-4 keeps the text off the edges. */}
      <footer className="relative z-30 -mx-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-[rgb(22_20_18_/_0.5)] px-4 py-3 text-[clamp(0.7rem,2.7cqw,0.9rem)] leading-tight uppercase">
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
        className="pointer-events-none absolute right-0 bottom-0 -z-10 w-full max-w-none translate-x-1/2 translate-y-1/2 select-none"
      />
    </section>
  );
}
