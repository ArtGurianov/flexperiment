import ScheduleOccurrenceRow, {
  SCHEDULE_LIST,
  ScheduleRowButton,
} from "@/components/ScheduleRow";
import { actionableUpcomingEvents } from "@/lib/seo/schedule-presentation";
import type { ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * The upcoming catalogue as one global chronological list.
 *
 * SHARED DATA, NOT SHARED PRESENTATION. This is the piece the drawer and the
 * standalone page genuinely have in common — the same model, the same
 * `ACTIONABLE` filter, the same ordering, the same row. Everything around it is
 * different and should be: one is a picker inside a dialog whose chrome already
 * has a title and a Back control, the other is a document with a navbar, an
 * <h1>, intro copy, an archive and a footer.
 *
 * The previous version shared the whole renderer instead, which is how the
 * drawer ended up showing a page's grouped-by-city cards. Reuse is not a goal
 * that outranks the surface being right.
 *
 * No "use client" and no hooks: a plain function of its props, which is what
 * lets it prerender into /schedule's static HTML during `next build` and render
 * again inside the client drawer from the identical model.
 */
export default function ScheduleChronologicalList({
  model,
  emptyNotice,
  onCityInterest,
  cityInterestExpanded,
  cityInterestControls,
}: {
  model: ScheduleViewModel;
  /** What to say when nothing is bookable. Worded per surface. */
  emptyNotice: string;
  /**
   * Omitted only where there is nothing for the row to do. Both real surfaces
   * pass it: the drawer swaps to a subview, the page expands a form in place.
   */
  onCityInterest?: () => void;
  /** Set only where the row toggles a region that is rendered next to it. */
  cityInterestExpanded?: boolean;
  cityInterestControls?: string;
}) {
  const upcoming = actionableUpcomingEvents(model);

  return (
    <div className={SCHEDULE_LIST}>
      {upcoming.length === 0 ? (
        <p role="status" className="border border-bone/50 px-4 py-5 text-center text-bone/70">
          {emptyNotice}
        </p>
      ) : (
        upcoming.map((event) => <ScheduleOccurrenceRow key={event.id} event={event} />)
      )}

      {/* Kept even when the list is empty — a visitor with no date to pick is
          exactly the one with a reason to ask for their city. CityInterestForm
          says so itself when it cannot accept a request, so this row never has
          to guess whether the endpoint is open. */}
      {onCityInterest ? (
        <ScheduleRowButton
          onClick={onCityInterest}
          aria-expanded={cityInterestExpanded}
          aria-controls={cityInterestControls}
          left="Твой город"
          right="× Скоро"
        />
      ) : null}
    </div>
  );
}
