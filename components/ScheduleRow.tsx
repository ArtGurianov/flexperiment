import type { ComponentPropsWithoutRef, ReactNode } from "react";

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

/**
 * The label is TWO parts, «Санкт-Петербург» and «× 25.09.2026», not one string.
 *
 * At 390px the longest city name plus a date does not fit on one line at
 * text-2xl — and it did not in the golden file either, whose reference list
 * only ever held short names. Left as a single run, the browser broke it
 * wherever it ran out of room: «Санкт-Петербург ×» on the first line and the
 * bare date on the second, splitting the separator away from what it separates.
 *
 * Two flex items wrap at the seam instead, so a row is either
 *
 *     Санкт-Петербург        × 25.09.2026
 *
 * or, when it cannot fit,
 *
 *          Санкт-Петербург
 *           × 25.09.2026
 *
 * `grow` is what makes the second case centre: alone on its line, a part fills
 * the width and `text-center` does the rest. It is also why there is no
 * `justify-*` here — with both parts growing there is never free space left for
 * one to distribute, so any justification would be dead CSS. The visual spread
 * on a single line comes from the two parts sharing the row, not from
 * `justify-between`.
 */
const LABEL = "flex w-full flex-wrap items-center gap-2 text-center font-display text-2xl";
const LABEL_PART = "grow";

/**
 * The whitespace between the parts is deliberate and is NOT the `gap`.
 *
 * `gap-2` is the visual separation; this text node is what keeps
 * `textContent` — and therefore the accessible name, and the crawlable text of
 * the static export — reading «Санкт-Петербург × 25.09.2026» rather than
 * «Санкт-Петербург× 25.09.2026». CSS ignores it: an anonymous flex item holding
 * only white space is not rendered (CSS Flexbox §4), so it costs no layout.
 */
function RowLabel({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <span className={LABEL}>
      <span className={LABEL_PART}>{left}</span>{" "}
      <span className={LABEL_PART}>{right}</span>
    </span>
  );
}

/**
 * `CITY × DATE` and nothing else.
 *
 * No venue, no price, no seats, no sales badge, no «Подробности и запись». This
 * is a picker: its job is to get a visitor to the right date's page, where the
 * live panel can speak for the live state. Restating any of that here would
 * both duplicate the event surface and put a claim about bookability on a
 * statically built row that cannot know it.
 *
 * `dateLabel` reads «25.09.2026» — the golden file's compact form, restored.
 * It is NOT the golden file's `occurrenceDateLabel`, though: that one formats in
 * the ambient zone, which is the build machine's during `next build`. Correct
 * for a dialog that only ever rendered in the visitor's own browser; here it
 * would freeze CI's timezone into static HTML. The model's `dateLabel` is the
 * same format anchored to the occurrence's own zone — see occurrence-format.ts
 * for why every date on this site is numeric.
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
      <RowLabel
        left={event.cityTitle}
        // The separator travels with the date, so a wrap can never strand a
        // lone «×» at the end of the first line.
        right={<>× <time dateTime={event.startsAt}>{event.dateLabel}</time></>}
      />
      {/* Only on the archive, where «Отменён» and «Прошёл» are different facts a
          visitor needs and the section heading alone cannot distinguish.
          Centred with the label above it rather than left against the row's
          `text-left`, which would read as a stray caption under a centred
          title. */}
      {tone === "archival" && event.departedLabel ? (
        // Same whitespace trick as inside RowLabel, for the same reason: it
        // keeps the link's text reading «… 10.08.2026 Отменён» instead of
        // running the two together, and costs no layout.
        <>{" "}<span className="text-center text-bone/60">{event.departedLabel}</span></>
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
  left,
  right,
  className,
  ...props
}: ComponentPropsWithoutRef<"button"> & { left: ReactNode; right: ReactNode }) {
  return (
    <button type="button" className={cn(ROW, className)} {...props}>
      {/* Two parts like every other row, not one string. «Твой город × Скоро»
          sits in the same list and has the same shape — subject, separator,
          when — so it must wrap and centre the same way or it would be the one
          row that breaks the column. */}
      <RowLabel left={left} right={right} />
    </button>
  );
}
