import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";
import type { ScheduleEventView } from "@/lib/seo/schedule-view-model";

/**
 * The catalogue row, restored verbatim from the pre-SEO checkout dialog.
 *
 * These class strings are copied from
 * `git show c7d897b:components/CheckoutFlow.tsx` — the bone slab, the acid
 * hover, the 2px border, the `font-display text-2xl` label and the `font-mono
 * text-sm` container are that surface, not an interpretation of it. The one
 * thing that changed is the element:
 *
 *     before   <button onClick={() => showBooking(occurrence)}>
 *     now      <a href="/events/<slug>">
 *
 * and that difference is the entire point of the SEO architecture. The row is a
 * navigation to a real, indexable, shareable document. On the home page
 * ModalRouteController intercepts the plain left-click and opens it as a drawer;
 * a cmd-click, a middle-click, a crawler and a direct hit all get the static
 * page. Nothing here calls the router, sets local route state, or opens
 * checkout — the old button did all three, and a catalogue that opens a payment
 * form is exactly what the new architecture replaced.
 */
export const SCHEDULE_LIST = "flex w-full flex-col gap-4 font-mono text-sm";

/** The bone slab. Golden: CheckoutFlow's catalogue button. */
const ROW =
  "flex w-full flex-col gap-4 border-2 border-bone/50 bg-bone px-4 py-5 text-left text-ink transition-colors hover:border-acid hover:bg-acid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid";

/**
 * The quiet variant, for dates that have already departed.
 *
 * Not a new design: it is the golden file's own secondary treatment — the
 * `border border-bone/50 px-4 py-5 text-bone/70` it used for status lines —
 * given the same acid focus and hover as the row above. An archived date is
 * still a real link to a permanent page, so it must look reachable; it must not
 * compete with a date that can still be booked.
 *
 * `bg-ink/90` is load-bearing and comes from a browser smoke, not from taste.
 * The golden treatment lived inside a dialog, which supplied its own dark
 * surface. This row renders on a PAGE, over the sticky `bg-site` artwork in
 * layout.tsx — a photograph with bright cloud regions. Unfilled, `text-bone/70`
 * over one of those washed out to the point where «Отменён» was hard to read;
 * with the fill it is clean at every scroll position. The DarkPanel cards this
 * replaces never had the problem because they carried a fill too. It is the
 * same value the dialog surface uses, so the row brings its own contrast
 * wherever it lands.
 */
const ROW_ARCHIVAL =
  "flex w-full flex-col gap-2 border border-bone/50 bg-ink/90 px-4 py-5 text-left text-bone/70 transition-colors hover:border-acid hover:text-acid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid";

const LABEL = "font-display text-2xl";

/**
 * `CITY × DATE` and nothing else.
 *
 * No venue, no price, no seats, no sales badge, no «Подробности и запись». This
 * is a picker: its job is to get a visitor to the right date's page, where the
 * live panel can speak for the live state. Restating any of that here would
 * both duplicate the event surface and put a claim about bookability on a
 * statically built row that cannot know it.
 *
 * `dateLabel` is the model's timezone-anchored string («25 сентября 2026 г.»),
 * not the golden file's `occurrenceDateLabel`. That one formats in the ambient
 * zone, which is the build machine's during `next build` — it was correct for a
 * dialog that only ever rendered in the visitor's own browser, and it would
 * freeze CI's timezone into static HTML here.
 */
export default function ScheduleOccurrenceRow({
  event,
  tone = "upcoming",
}: {
  event: ScheduleEventView;
  tone?: "upcoming" | "archival";
}) {
  return (
    <a href={event.href} className={tone === "archival" ? ROW_ARCHIVAL : ROW}>
      <span className={LABEL}>
        {event.cityTitle} × <time dateTime={event.startsAt}>{event.dateLabel}</time>
      </span>
      {/* Only on the archive, where «Отменён» and «Прошёл» are different facts a
          visitor needs and the section heading alone cannot distinguish. */}
      {tone === "archival" && event.departedLabel ? (
        <span className="text-bone/60">{event.departedLabel}</span>
      ) : null}
    </a>
  );
}

/**
 * The same slab as a button, for the one row that is not a URL.
 *
 * «Твой город × Скоро» opens a form, not a document, so it must not pretend to
 * be a link — there is nothing to middle-click, and a crawler following it
 * would find nothing. It looks identical because it belongs to the same list.
 */
export function ScheduleRowButton({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"button">) {
  return (
    <button type="button" className={cn(ROW, className)} {...props}>
      <span className={LABEL}>{children}</span>
    </button>
  );
}
