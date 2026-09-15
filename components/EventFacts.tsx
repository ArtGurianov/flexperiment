import DarkPanel from "@/components/DarkPanel";
import { formatRubles } from "@/lib/money";
import {
  occurrenceDateLabelInZone,
  occurrenceTimeLabelInZone,
} from "@/lib/occurrence-format";
import type { PublishedRecord } from "@/lib/seo/occurrence-snapshot";

/**
 * The commercial facts of one occurrence, server-rendered.
 *
 * This is the whole point of an event page: until now city, date, venue and
 * price existed only inside a client-only checkout modal, so not one city name
 * appeared in the built HTML. Everything here comes from the committed
 * snapshot, which is a build-time copy of Commerce — Commerce stays
 * authoritative, and nothing on this page is a fact SEO code invented.
 *
 * Times are formatted in the occurrence's own zone, never the viewer's and
 * never the build machine's — see occurrenceDateLabelInZone.
 *
 * The price shown is this occurrence's `price_kopecks`. It is NOT the home
 * page's editorial «от 3 800 ₽», and there is deliberately no fallback between
 * the two: an event page quoting an editorial figure would be advertising a
 * price nothing can honour.
 */
const TERM = "font-mono text-[clamp(0.7rem,2.7cqw,0.85rem)] uppercase tracking-wide text-bone/60";
const VALUE = "mt-[1cqw] text-[clamp(1rem,4.2cqw,1.35rem)] leading-snug text-bone";

export default function EventFacts({ occurrence }: { occurrence: PublishedRecord }) {
  const date = occurrenceDateLabelInZone(occurrence.starts_at, occurrence.timezone);
  const time = occurrenceTimeLabelInZone(occurrence.starts_at, occurrence.timezone);
  const venueConfirmed =
    occurrence.venue.status === "CONFIRMED" && occurrence.venue.name && occurrence.venue.address;

  return (
    <DarkPanel className="mt-[6cqw] px-[6cqw] py-[6cqw]">
      <dl className="grid gap-[4.5cqw]">
        <div>
          <dt className={TERM}>Город</dt>
          {/* A real <dd>, not alt text or a modal label: this is the string a
              crawler and a screen reader read as the event's location. */}
          <dd className={`${VALUE} font-display text-acid`}>{occurrence.city_title}</dd>
        </div>

        <div>
          <dt className={TERM}>Дата и время</dt>
          <dd className={VALUE}>
            {/* <time> with a machine-readable datetime, so the instant is
                unambiguous regardless of how the visible string is worded. */}
            <time dateTime={occurrence.starts_at}>
              {date}
              {time ? `, ${time}` : ""}
            </time>
          </dd>
        </div>

        <div>
          <dt className={TERM}>Место проведения</dt>
          <dd className={VALUE}>
            {venueConfirmed
              ? `${occurrence.venue.name}: ${occurrence.venue.address}`
              : // Truthful rather than reassuring. The snapshot carries no
                // announce_by deadline (that is Commerce's checkout copy), so
                // this states the fact and promises nothing about when.
                "Площадка уточняется. Адрес сообщим участникам по email."}
          </dd>
        </div>

        <div>
          <dt className={TERM}>Стоимость участия</dt>
          <dd className={VALUE}>
            <strong className="font-normal text-acid">{formatRubles(occurrence.price_kopecks)}</strong>
          </dd>
        </div>

        <div>
          <dt className={TERM}>Уровень подготовки</dt>
          <dd className={VALUE}>Любой. Растяжка не нужна.</dd>
        </div>

        <div>
          <dt className={TERM}>Преподаватель</dt>
          <dd className={VALUE}>Арт Гурьянов</dd>
        </div>
      </dl>
    </DarkPanel>
  );
}
