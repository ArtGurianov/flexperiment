import DarkPanel from "@/components/DarkPanel";
import EventBooking from "@/components/EventBooking";
import type { EventViewModel } from "@/lib/seo/event-view-model";

/**
 * One event's content, with no page chrome.
 *
 * The standalone /events/[slug] page wraps it in the full-page shell; the
 * drawer wraps the same component in DialogDrawer. One renderer, two shells —
 * so the page a crawler indexes and the drawer a visitor opens cannot say
 * different things about the same date.
 *
 * The programme deliberately stays on the page below this component rather than
 * moving inside it. It is identical for every occurrence and belongs to the
 * indexable document; repeating it inside a drawer would be length without
 * information.
 *
 * `headingLevel` exists because the same content is an <h1> on its own page and
 * a lower level inside a dialog that already has a title.
 */
const TERM = "font-mono text-[clamp(0.7rem,2.7cqw,0.85rem)] uppercase tracking-wide text-bone/60";
const VALUE = "mt-[1cqw] text-[clamp(1rem,4.2cqw,1.35rem)] leading-snug text-bone";

export default function EventView({
  event,
  headingLevel = "h1",
  showHeading = true,
}: {
  event: EventViewModel;
  headingLevel?: "h1" | "h2";
  /**
   * False inside the drawer, whose own title already names the event.
   * Rendering both put «Санкт-Петербург, 25.09.2026» on screen twice,
   * once as the sheet title and again as the first line of its body.
   */
  showHeading?: boolean;
}) {
  const Heading = headingLevel;
  const archived = event.archivalNotice !== null;
  // A successful live read that did not return this occurrence. Distinct from
  // archival: absence from tour() is ambiguous — it filters to SCHEDULED and
  // future — so this says only that booking is not available right now, never
  // that the event was cancelled.
  const unavailable = !archived && event.listing === "NOT_IN_LIVE_TOUR";

  return (
    <>
      {showHeading ? (
        <Heading className="font-display text-[clamp(1.5rem,7cqw,2.4rem)] leading-tight text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
          Мастер-класс FLEXPERIMENT
          <span className="mt-[2cqw] block text-bone">
            {event.cityTitle}, {event.dateLabel}
          </span>
        </Heading>
      ) : null}

      {archived || unavailable ? (
        <p
          role={unavailable ? "status" : undefined}
          className="mt-[5cqw] border border-bone/50 px-[4cqw] py-[3cqw] text-[clamp(0.9rem,3.5cqw,1.1rem)] text-bone/80"
        >
          {/* The page stays live rather than 404ing: this URL has been indexed,
              shared and linked, and a visitor arriving on it deserves an
              answer. What it must not do is look like an event still on sale. */}
          {archived
            ? event.archivalNotice
            : "Актуальное состояние этой даты изменилось. Запись сейчас недоступна."}
        </p>
      ) : null}

      <DarkPanel className="mt-[6cqw] px-[6cqw] py-[6cqw]">
        <dl className="grid gap-[4.5cqw]">
          <div>
            <dt className={TERM}>Город</dt>
            <dd className={`${VALUE} font-display text-acid`}>{event.cityTitle}</dd>
          </div>
          <div>
            <dt className={TERM}>Дата и время</dt>
            <dd className={VALUE}>
              {/* Machine-readable instant, so it is unambiguous however the
                  visible string is worded or localized. */}
              <time dateTime={event.startsAt}>
                {event.dateLabel}
                {event.timeLabel ? `, ${event.timeLabel}` : ""}
              </time>
            </dd>
          </div>
          <div>
            <dt className={TERM}>Место проведения</dt>
            <dd className={VALUE}>{event.venueDisclosure}</dd>
          </div>
          <div>
            <dt className={TERM}>Стоимость участия</dt>
            <dd className={VALUE}>
              <strong className="font-normal text-acid">{event.priceLabel}</strong>
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

      {/* The live panel is mounted only for a date still in the tour. For an
          archived one the notice above is the whole answer, and hydrating a
          booking panel whose endpoint is known to 404 would leave a CTA up
          permanently — see EventBooking. The same applies once a successful
          live read has stopped returning the occurrence: reconciliation already
          decided it is not actionable, so offering a booking CTA would
          contradict the model that produced this page. */}
      {archived || unavailable ? null : <EventBooking occurrenceId={event.id} />}
    </>
  );
}
