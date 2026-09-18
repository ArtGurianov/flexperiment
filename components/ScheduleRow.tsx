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
 * At text-2xl the longest labels do not fit one line in the mobile drawer —
 * 340px of text in a 314px row, measured — and they did not in the golden file
 * either, whose reference list only ever held short names. Left as a single
 * run the browser broke the line wherever it ran out of room, which put
 * «Санкт-Петербург ×» on the first line and the bare date on the second,
 * stranding the separator away from what it separates. Two flex items break at
 * the seam instead.
 *
 * `justify-between` puts them on the row's outer edges when they share a line:
 *
 *     Санкт-Петербург            × 25.09.2026
 *
 * and a wrapped row stacks to the left, which is where the row's own
 * `text-left` already points:
 *
 *     Санкт-Петербург
 *     × 25.09.2026
 *
 * THAT SECOND CASE CANNOT ALSO BE CENTRED. Centring a part that is alone on its
 * line needs it to fill that line (`flex-grow`), and a part that grows leaves no
 * free space for `justify-between` to push anything to an edge — so the two
 * behaviours are mutually exclusive, and CSS has no selector for "alone on a
 * flex line" to switch between them. Edges won, because every row that fits is
 * one, and only the long names wrap.
 *
 * Nor can the wrap be designed away by shrinking the type: 21px would fit
 * «Санкт-Петербург × 25.09.2026», but city-catalog.ts also holds
 * «Комсомольск-на-Амуре», and something will always be too long. The row has to
 * wrap well rather than promise not to.
 */
const LABEL = "flex w-full flex-wrap items-center justify-between gap-2 font-display text-2xl";

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
      <span>{left}</span>{" "}
      <span>{right}</span>
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
 * `compactDateLabel`, not `dateLabel`. This is the ONLY surface on the compact
 * register: «25.09.2026» is for scanning a list, and the long «25 сентября
 * 2026 г.» stays on the headings, detail panels and confirmations that the
 * same model feeds. The golden file's row was compact too — but via an
 * ambient-zone formatter, which under `output: "export"` would freeze CI's
 * timezone into static HTML, so the model derives both labels from the
 * occurrence's own zone instead. See occurrence-format.ts for the two
 * registers.
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
        right={<>× <time dateTime={event.startsAt}>{event.compactDateLabel}</time></>}
      />
      {/* Only on the archive, where «Отменён» and «Прошёл» are different facts a
          visitor needs and the section heading alone cannot distinguish. */}
      {tone === "archival" && event.departedLabel ? (
        // Same whitespace trick as inside RowLabel, for the same reason: it
        // keeps the link's text reading «… 10.08.2026 Отменён» instead of
        // running the two together, and costs no layout. Alignment is left by
        // inheritance, under the city part it belongs to.
        <>{" "}<span className="text-bone/60">{event.departedLabel}</span></>
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
