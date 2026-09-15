import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import CtaButton from "@/components/CtaButton";
import DarkPanel from "@/components/DarkPanel";
import Footer from "@/components/Footer";
import Navbar from "@/components/Navbar";
import PaymentNotice from "@/components/PaymentNotice";
import Section, { SectionLabel } from "@/components/Section";
import { formatRubles } from "@/lib/money";
import {
  occurrenceDateLabelInZone,
  occurrenceTimeLabelInZone,
} from "@/lib/occurrence-format";
import { OPEN_GRAPH_BASE, TWITTER_CARD } from "@/lib/seo/site";
import { findPublishedCity, PLACEHOLDER_PARAM, publishedCities } from "@/lib/seo/snapshot-source";

/**
 * One page per city that actually has a publishable occurrence.
 *
 * Emphatically NOT one per CITY_CATALOGUE entry. That list is 80 cities and its
 * own doc comment says it is "intentionally broader than the live tour" — it
 * exists so a visitor can register interest in a city the tour has never
 * visited. Generating a page for each would publish 80 thin documents implying
 * an event that does not exist, which is the textbook way to get a site
 * classified as doorway pages.
 *
 * Same `dynamicParams = false` + synchronous `generateStaticParams` shape as
 * app/legal/[slug] and app/events/[slug]; see that file for why it is the only
 * combination `output: "export"` supports.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  const cities = publishedCities().map((city) => ({ city: city.slug }));
  // See PLACEHOLDER_PARAM in lib/seo/snapshot-source.ts.
  return cities.length > 0 ? cities : [{ city: PLACEHOLDER_PARAM }];
}

export async function generateMetadata(
  props: PageProps<"/cities/[city]">,
): Promise<Metadata> {
  const { city } = await props.params;
  const published = findPublishedCity(city);
  if (!published) return {};

  const title = `Мастер-классы по флексингу в городе ${published.title} | FLEXPERIMENT`;
  const description =
    `Ближайшие мастер-классы FLEXPERIMENT по флексингу и experimental dance в городе ${published.title}: ` +
    "даты, площадка и стоимость участия. Преподаватель — Арт Гурьянов.";
  const canonical = `/cities/${published.slug}`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { ...OPEN_GRAPH_BASE, url: canonical, title, description },
    twitter: { card: TWITTER_CARD, title, description },
  };
}

export default async function CityPage(props: PageProps<"/cities/[city]">) {
  const { city } = await props.params;
  const published = findPublishedCity(city);
  if (!published) notFound();

  return (
    <>
      <Navbar />

      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col overflow-x-clip outline-none"
      >
        <Section className="pb-[10cqw]">
          <Link
            href="/"
            className="mb-[6cqw] inline-block text-[clamp(0.8rem,3cqw,1rem)] text-acid underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid"
          >
            ← На главную
          </Link>

          <h1 className="font-display text-[clamp(1.5rem,7cqw,2.4rem)] leading-tight text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
            Мастер-классы по флексингу
            <span className="mt-[2cqw] block text-bone">{published.title}</span>
          </h1>

          <p className="mt-[5cqw] text-[clamp(0.95rem,3.8cqw,1.2rem)] leading-relaxed text-bone/85">
            Изоляции тела, иллюзии в танце, импровизация и поиск собственного
            стиля. Для любого уровня подготовки — растяжка не нужна.
          </p>

          <SectionLabel className="mt-[9cqw] mb-[4cqw]">Ближайшие даты</SectionLabel>

          {/* Server-rendered, so the dates are in the HTML. Availability is
              not: it is clock-dependent and belongs to the event page's own
              client-side fetch. A list that claimed "мест нет" from a build a
              week ago would be worse than saying nothing. */}
          <ul className="grid gap-[4cqw]">
            {published.records.map((record) => {
              const date = occurrenceDateLabelInZone(record.starts_at, record.timezone);
              const time = occurrenceTimeLabelInZone(record.starts_at, record.timezone);
              const cancelled = record.fulfillment_status === "CANCELLED";
              return (
                <li key={record.id}>
                  <DarkPanel className="px-[5cqw] py-[5cqw]">
                    <p className="font-display text-[clamp(1.15rem,5cqw,1.6rem)] leading-tight text-acid">
                      <time dateTime={record.starts_at}>
                        {date}
                        {time ? `, ${time}` : ""}
                      </time>
                    </p>
                    <p className="mt-[2cqw] text-[clamp(0.85rem,3.3cqw,1.05rem)] text-bone/85">
                      {record.venue.status === "CONFIRMED" && record.venue.name
                        ? record.venue.name
                        : "Площадка уточняется"}
                      {" · "}
                      {formatRubles(record.price_kopecks)}
                    </p>
                    {cancelled ? (
                      <p className="mt-[2cqw] text-[clamp(0.85rem,3.3cqw,1.05rem)] text-bone/70">
                        Отменён
                      </p>
                    ) : null}
                    {/* A link, not a PaymentCta: the destination is a real page
                        with its own URL, so it must stay a navigable anchor
                        rather than a button that opens a modal. */}
                    <CtaButton
                      href={`/events/${record.event_slug}`}
                      className="mt-[4cqw] border-2 px-[4cqw] py-2 text-[clamp(0.95rem,4cqw,1.25rem)]"
                    >
                      Подробности и запись
                    </CtaButton>
                  </DarkPanel>
                </li>
              );
            })}
          </ul>
        </Section>
      </main>

      <Footer />

      {/* Navbar and Footer each render a PaymentCta, so this page needs the
          shared failure notice even though its own list does not use one. */}
      <PaymentNotice />
    </>
  );
}
