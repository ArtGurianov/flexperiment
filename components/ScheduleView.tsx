import CtaButton from "@/components/CtaButton";
import DarkPanel from "@/components/DarkPanel";
import { SectionLabel } from "@/components/Section";
import type { ScheduleEventView, ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * The schedule, as content — with no page chrome around it.
 *
 * Deliberately free of <Section>, <Navbar>, <Footer> and any layout decision.
 * /schedule/page.tsx wraps it in the full-page shell; in PR2 the drawer wraps
 * the same component in DialogDrawer. One renderer, two shells, so the two
 * presentations cannot drift.
 *
 * No "use client" and no hooks: it is a plain function of its props, which is
 * what lets it render during `next build` for the static page and again inside
 * a client component for the drawer.
 *
 * Every link is a real <a>. That is the whole reason this route exists — the
 * booking catalogue used to live only inside a client-only dialog, so no
 * crawler ever saw a city name, a date, or a path to an event page.
 */
const CARD_DATE = "font-display text-[clamp(1.15rem,5cqw,1.6rem)] leading-tight text-acid";
const CARD_META = "mt-[2cqw] text-[clamp(0.85rem,3.3cqw,1.05rem)] text-bone/85";

function EventCard({ event, action }: { event: ScheduleEventView; action: string }) {
  return (
    <DarkPanel className="px-[5cqw] py-[5cqw]">
      <p className={CARD_DATE}>
        <time dateTime={event.startsAt}>
          {event.dateLabel}
          {event.timeLabel ? `, ${event.timeLabel}` : ""}
        </time>
      </p>
      <p className={CARD_META}>
        {event.venueLabel}
        {" · "}
        {event.priceLabel}
      </p>
      {event.departedLabel ? (
        <p className="mt-[2cqw] text-[clamp(0.85rem,3.3cqw,1.05rem)] text-bone/70">
          {event.departedLabel}
        </p>
      ) : null}
      {/* A navigable anchor, never a button that opens a modal. The drawer in
          PR2 intercepts the click; the href is what a crawler and a
          middle-click both get. */}
      <CtaButton
        href={event.href}
        className="mt-[4cqw] border-2 px-[4cqw] py-2 text-[clamp(0.95rem,4cqw,1.25rem)]"
      >
        {action}
      </CtaButton>
    </DarkPanel>
  );
}

export default function ScheduleView({ model }: { model: ScheduleViewModel }) {
  if (model.cities.length === 0) {
    return (
      <p className="text-[clamp(0.95rem,3.8cqw,1.2rem)] leading-relaxed text-bone/80">
        Ближайшие даты пока не объявлены. Мы сообщим, как только появится
        расписание.
      </p>
    );
  }

  return (
    <div className="grid gap-[10cqw]">
      {model.cities.map((city) => {
        const actionable = city.upcoming.filter((event) => event.listing === "ACTIONABLE");
        return (
        <section key={city.slug} id={city.slug} className="scroll-mt-16">
          {/* The id is the anchor target for /schedule#<city>, which is where
              the retired /cities/<city> URLs redirect. */}
          <h2 className="font-display text-[clamp(1.3rem,6cqw,2rem)] leading-tight text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
            {city.title}
          </h2>

          {/* Only ACTIONABLE dates are advertised. A record the live tour no
              longer returns keeps its page and its permanent URL, but it has
              stopped being a date anyone can book, so offering it here under
              «Подробности и запись» would be an invitation the checkout cannot
              honour. It is not moved to «Прошедшие и отменённые» either: the
              reason for its absence is unknown, and calling it cancelled would
              assert something only the generator's per-id re-fetch could
              establish. */}
          {actionable.length > 0 ? (
            <ul className="mt-[5cqw] grid gap-[4cqw]">
              {actionable.map((event) => (
                <li key={event.id}>
                  <EventCard event={event} action="Подробности и запись" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-[4cqw] text-[clamp(0.9rem,3.5cqw,1.1rem)] text-bone/75">
              Ближайшие даты в этом городе пока не объявлены.
            </p>
          )}

          {city.archived.length > 0 ? (
            <>
              <SectionLabel className="mt-[7cqw] mb-[4cqw] text-[clamp(0.95rem,4cqw,1.25rem)]">
                Прошедшие и отменённые
              </SectionLabel>
              <ul className="grid gap-[4cqw]">
                {city.archived.map((event) => (
                  <li key={event.id}>
                    <EventCard event={event} action="Подробности" />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
        );
      })}
    </div>
  );
}
