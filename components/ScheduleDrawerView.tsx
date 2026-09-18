import CityInterestForm from "@/components/CityInterestForm";
import ScheduleChronologicalList from "@/components/ScheduleChronologicalList";
import { scheduledCitySlugs } from "@/lib/seo/schedule-presentation";
import type { ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * The intercepted /schedule, as a compact picker.
 *
 * No archive, no page chrome, no grouping: a visitor who tapped a booking CTA
 * wants the next dates, and a drawer is not the place to publish a record of
 * dates that have passed. Those stay on /schedule, which is a document and can
 * afford them.
 *
 * SUBVIEW, NOT ROUTE. `view` is owned by ModalRouteController, which also owns
 * the dialog chrome this has to agree with — the title becomes «Не нашли свой
 * город?» and a Back control appears. It is deliberately NOT a history entry:
 * history stays the authority for route identity (home / schedule / event), and
 * the city-interest form is a panel inside /schedule, not a fourth route. So
 * the URL stays /schedule while it is open, and browser Back from it goes home,
 * because there is no entry between the two. Pushing a hidden entry for a form
 * would make the hardware Back button mean something different from the one on
 * screen.
 */
export type ScheduleDrawerSubview = "list" | "city-interest";

export default function ScheduleDrawerView({
  model,
  view,
  onCityInterest,
}: {
  model: ScheduleViewModel;
  view: ScheduleDrawerSubview;
  onCityInterest: () => void;
}) {
  if (view === "city-interest") {
    return <CityInterestForm scheduledCitySlugs={scheduledCitySlugs(model)} />;
  }

  return (
    <ScheduleChronologicalList
      model={model}
      // The pre-SEO wording, kept exactly: this is the sentence the dialog has
      // always shown when the catalogue came back empty.
      emptyNotice="Запись на ближайшие даты пока не открыта."
      onCityInterest={onCityInterest}
    />
  );
}
