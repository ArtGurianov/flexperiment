"use client";

import { useEffect, useId, useRef, useState } from "react";

import CityInterestForm from "@/components/CityInterestForm";
import ScheduleChronologicalList from "@/components/ScheduleChronologicalList";
import ScheduleOccurrenceRow, { SCHEDULE_LIST } from "@/components/ScheduleRow";
import { SectionLabel } from "@/components/Section";
import { archivedEvents, scheduledCitySlugs } from "@/lib/seo/schedule-presentation";
import type { ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * /schedule as a page: the same minimalist rows, in a document.
 *
 * It shares the upcoming list and the row visual with the drawer and nothing
 * else. What it adds is what only a permanent, indexable URL can carry — the
 * archive of dates that have departed, and a city-interest form that opens in
 * place rather than stacking a second modal on a page that is not a modal.
 *
 * It does NOT add back the venue/price cards. Those were a page-shaped answer
 * to a catalogue question: every fact on them is repeated, in more detail and
 * with live state attached, on the event page one click away. The row's job on
 * both surfaces is to name the date and link to it.
 *
 * A client component, but a prerendered one: `next build` renders it into
 * out/schedule.html, so the list, the rows and every /events/<slug> anchor are
 * in the static document a crawler receives. Only the form — which is not crawl
 * surface and has nothing to index — waits for a click.
 */
export default function StandaloneScheduleView({ model }: { model: ScheduleViewModel }) {
  const [cityInterestOpen, setCityInterestOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const archived = archivedEvents(model);

  // Focus follows the disclosure, so a keyboard visitor is standing in the form
  // that just appeared rather than at the button above it, several tab stops
  // from the field they asked for.
  useEffect(() => {
    if (cityInterestOpen) panel.current?.focus();
  }, [cityInterestOpen]);

  return (
    <>
      <ScheduleChronologicalList
        model={model}
        // Worded for a document rather than a dialog: a visitor who navigated
        // to the catalogue is owed the reason, not just the state.
        emptyNotice="Ближайшие даты пока не объявлены. Мы сообщим, как только появится расписание."
        onCityInterest={() => setCityInterestOpen(true)}
        cityInterestExpanded={cityInterestOpen}
        cityInterestControls={panelId}
      />

      {cityInterestOpen ? (
        <div id={panelId} ref={panel} tabIndex={-1} className="mt-4 outline-none">
          <CityInterestForm scheduledCitySlugs={scheduledCitySlugs(model)} />
        </div>
      ) : null}

      {archived.length > 0 ? (
        <>
          {/* Secondary by placement and weight, and separated by a heading, so
              a departed date is never mistaken for one still on offer. It stays
              on the page at all because these URLs are permanent: they have
              been indexed, shared and printed on tickets. */}
          <SectionLabel className="mt-[9cqw] mb-[5cqw] text-[clamp(0.95rem,4cqw,1.25rem)]">
            Прошедшие и отменённые
          </SectionLabel>
          <div className={SCHEDULE_LIST}>
            {archived.map((event) => (
              <ScheduleOccurrenceRow key={event.id} event={event} tone="archival" />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
