import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import EventArchivalNotice from "@/components/EventArchivalNotice";
import EventBooking from "@/components/EventBooking";
import EventFacts from "@/components/EventFacts";
import EventStructuredData from "@/components/EventStructuredData";
import Footer from "@/components/Footer";
import Navbar from "@/components/Navbar";
import PaymentNotice from "@/components/PaymentNotice";
import ProgramBlock from "@/components/ProgramBlock";
import Section, { SectionLabel } from "@/components/Section";
import Separator from "@/components/Separator";
import practiceItem from "@/public/practice-item.webp";
import practiceTitle from "@/public/practice-title.webp";
import theoryItem from "@/public/theory-item.webp";
import theoryTitle from "@/public/theory-title.webp";
import { occurrenceDateLabelInZone, departureNotice } from "@/lib/occurrence-format";
import { isDeparted } from "@/lib/seo/occurrence-snapshot";
import { OPEN_GRAPH_BASE, TWITTER_CARD } from "@/lib/seo/site";
import { findPublishedRecord, PLACEHOLDER_PARAM, publishedRecords } from "@/lib/seo/snapshot-source";

/**
 * One page per publishable occurrence, at `/events/<frozen-city>-<full uuid>`.
 *
 * `dynamicParams = false` plus a synchronous `generateStaticParams` is the only
 * combination `output: "export"` supports for a dynamic route — see
 * node_modules/next/dist/docs/01-app/02-guides/static-exports.md, which lists
 * both "dynamicParams: true" and "without generateStaticParams" as unsupported.
 * This mirrors app/legal/[slug]/page.tsx exactly.
 *
 * With today's committed snapshot this generates ZERO pages, because
 * production's only occurrence is rejected on a timezone contradiction. That is
 * the intended fail-closed behaviour, not a bug: the architecture is complete
 * and publishes nothing until the inventory is correct. See PLACEHOLDER_PARAM
 * for how "zero pages" is expressed to a framework that refuses to accept zero.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  const records = publishedRecords().map((record) => ({ slug: record.event_slug }));
  // See PLACEHOLDER_PARAM: Next refuses an empty array here under
  // `output: "export"`, and `pnpm build` deletes the placeholder from `out/`.
  return records.length > 0 ? records : [{ slug: PLACEHOLDER_PARAM }];
}

const PROGRAM_THEORY = [
  "Обзор и выбор направлений во флексинге по своим физическим возможностям - собери свой уникальный запоминающийся образ.",
  "Вход в состояние потока и креативность через танец. Как придумывать и комбинировать движения.",
  "Разберем иллюзии и абстракции. Как танцевать, чтобы было интересно под любую музыку.",
];

const PROGRAM_PRACTICE = [
  "Упражнения на координацию и управление телом. Упражнения по растяжке и мобильности.",
  "Попробуем техники каждого направления флексинга (анимации, таттинг, глайдинг и др.).",
  "Выучим связку с комбинацией этих направлений для понимания сочетаний и переходов между ними.",
];

export async function generateMetadata(
  props: PageProps<"/events/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const record = findPublishedRecord(slug);
  // Unreachable while dynamicParams is false, but generateMetadata is called
  // for arbitrary params during development — and an empty object is the
  // documented way to contribute nothing rather than throw.
  if (!record) return {};

  const date = occurrenceDateLabelInZone(record.starts_at, record.timezone);
  const title = `${record.city_title}, ${date} — мастер-класс FLEXPERIMENT`;
  // The date label already ends in "г.", so the sentence is punctuated with an
  // em dash rather than a full stop it would double.
  const description =
    `${record.city_title}, ${date} — мастер-класс по флексингу и experimental dance ` +
    "от Арта Гурьянова. Изоляции тела, иллюзии, импровизация и свой стиль. " +
    "Для любого уровня, растяжка не нужна.";
  const canonical = `/events/${record.event_slug}`;

  return {
    title,
    description,
    alternates: { canonical },
    // Spread rather than replaced — Next merges metadata shallowly, so a bare
    // object here would drop og:type, og:locale and og:site_name from this
    // route alone. Same for twitter's card.
    openGraph: { ...OPEN_GRAPH_BASE, url: canonical, title, description },
    twitter: { card: TWITTER_CARD, title, description },
  };
}

export default async function EventPage(props: PageProps<"/events/[slug]">) {
  const { slug } = await props.params;
  const record = findPublishedRecord(slug);
  if (!record) notFound();

  const date = occurrenceDateLabelInZone(record.starts_at, record.timezone);
  // A record that has left /v1/public/tour is archival whatever its
  // fulfillment_status says. Testing only for CANCELLED was not enough: a PAST
  // or WITHDRAWN tombstone still carries SCHEDULED, because that is the last
  // state Commerce reported, so it would have rendered as an ordinary bookable
  // date. isDeparted is the only reliable gate, and it narrows the union so the
  // notice below can read `departed`.
  const departed = isDeparted(record) ? record : null;

  return (
    <>
      {/* Deliberately NOT wrapped in AssetPreloader: that gates on
          [data-hero-video], which only the home page renders, and an event page
          behind a loading overlay waiting for a video that is not there is the
          exact bug the preloader was moved off the layout to avoid. */}
      <Navbar />

      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col overflow-x-clip outline-none"
      >
        <Section className="pb-[8cqw]">
          <Link
            href={`/cities/${record.city}`}
            className="mb-[6cqw] inline-block text-[clamp(0.8rem,3cqw,1rem)] text-acid underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid"
          >
            ← {record.city_title}
          </Link>

          <h1 className="font-display text-[clamp(1.5rem,7cqw,2.4rem)] leading-tight text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
            Мастер-класс FLEXPERIMENT
            <span className="mt-[2cqw] block text-bone">
              {record.city_title}, {date}
            </span>
          </h1>

          {departed ? (
            <p className="mt-[5cqw] border border-bone/50 px-[4cqw] py-[3cqw] text-[clamp(0.9rem,3.5cqw,1.1rem)] text-bone/80">
              {/* The page stays live rather than 404ing: this URL has been
                  indexed, shared and linked, and a visitor arriving on it
                  deserves an answer, not a dead end. What it must not do is
                  look like an event still on sale. */}
              {departureNotice(departed.departed)}
            </p>
          ) : null}

          <EventFacts occurrence={record} />

          {/* The live booking panel is mounted only for a date that is still in
              the public tour. A departed record gets a static notice instead —
              see EventArchivalNotice for why hydrating one would be worse than
              useless. */}
          {departed ? (
            <EventArchivalNotice record={departed} />
          ) : (
            <EventBooking occurrenceId={record.id} />
          )}
        </Section>

        <Separator />

        {/* ProgramBlock is the one parameterizable content component the home
            page has. ProgramSection itself is not reused: it is propless, and
            it carries id="program", which would duplicate the home page's
            anchor on a different document. */}
        <Section className="pb-[10cqw]">
          <SectionLabel>Программа мастер-класса</SectionLabel>

          <ProgramBlock
            className="mt-[7cqw]"
            title="Теория"
            titleImage={theoryTitle}
            item={theoryItem}
            itemClassName="-top-[3cqw] -right-[11cqw] w-[58cqw]"
            itemSizes="(min-width: 512px) 278px, 58vw"
            steps={PROGRAM_THEORY}
          />

          <ProgramBlock
            className="mt-[11cqw]"
            title="Практика"
            titleImage={practiceTitle}
            item={practiceItem}
            itemClassName="-top-[7cqw] -right-[13cqw] w-[50cqw]"
            itemSizes="(min-width: 512px) 240px, 50vw"
            steps={PROGRAM_PRACTICE}
          />
        </Section>
      </main>

      <Footer />

      {/* Required on any page that renders a PaymentCta — and Navbar and Footer
          each render one, so it would be needed here even without the booking
          panel. All the CTAs report a failed dialog load through the shared
          store rather than each rendering its own banner. */}
      <PaymentNotice />

      {/* Withheld entirely when the venue is not announced: Google requires a
          real location, and asserting one the page itself says is unknown would
          be a false claim rather than an incomplete one. */}
      <EventStructuredData occurrence={record} />
    </>
  );
}
