"use client";

import { useEffect, useRef, useState } from "react";

import { commerceApiUrl } from "@/lib/commerce-api";
import { formatRubles } from "@/lib/money";
import {
  occurrenceDateLabelInZone,
  occurrenceTimeLabelInZone,
} from "@/lib/occurrence-format";
import { parsePublicTour, type PublicOccurrence } from "@/lib/seo/public-occurrence";
import { reconcileSchedule } from "@/lib/seo/schedule-reconciliation";
import {
  venuePresentation,
  type ScheduleEventView,
  type ScheduleViewModel,
} from "@/lib/seo/schedule-view-model";

/**
 * Stale-while-revalidate for the schedule, with one live read per activation.
 *
 * The published snapshot is rendered immediately and is never waited on: a
 * drawer opens from static data in the same frame as the click. A single
 * `/v1/public/tour` read then runs alongside, and if it succeeds the
 * presentation is reconciled.
 *
 * A failed read leaves THE CURRENT PRESENTATION unchanged — which is the
 * snapshot only until the first success. After a flow has been reconciled,
 * closed and reopened, a failing second read preserves the correction the
 * visitor has already seen rather than reverting to older published data.
 * Reverting would be strictly worse: it would replace a value known to be
 * newer with one known to be older, on the strength of a request that failed.
 * See reconcileSchedule, where `null` means "no successful read" rather than
 * "the tour is empty".
 *
 * The brief pre-reconciliation state is the intended contract, not a defect.
 * The snapshot is valid publication state; live Commerce corrects mutable
 * presentation. Nothing transactional trusts either — availability belongs to
 * EventBooking and price authority to the checkout context.
 *
 * `enabled` is what makes the home page cost nothing. A landing visitor who
 * never opens the catalogue issues no Commerce request at all; the read starts
 * on the first activation. /schedule passes true from mount, because loading
 * that page IS the intent.
 *
 * ONE READ PER FLOW, NOT PER TRANSITION. Moving schedule → event → schedule
 * inside an open flow must not refetch; the data cannot have become more
 * current between two clicks a second apart. Closing resets the latch, so
 * reopening later — when the visitor has genuinely come back to the schedule —
 * reads again.
 */
const liveFormat = (occurrence: PublicOccurrence): Partial<ScheduleEventView> => ({
  startsAt: occurrence.starts_at,
  dateLabel: occurrenceDateLabelInZone(occurrence.starts_at, occurrence.timezone),
  timeLabel: occurrenceTimeLabelInZone(occurrence.starts_at, occurrence.timezone),
  priceLabel: formatRubles(occurrence.price_kopecks),
  ...venuePresentation(occurrence.venue),
});

export function useReconciledSchedule(
  initialModel: ScheduleViewModel,
  enabled: boolean,
): ScheduleViewModel {
  const [model, setModel] = useState<ScheduleViewModel>(initialModel);
  const attempted = useRef(false);

  useEffect(() => {
    if (!enabled) {
      // Flow closed: arm the next activation, and nothing else. The model is
      // deliberately left where it is — reverting to the snapshot would undo a
      // correction the visitor has already seen, and the re-arm concerns only
      // the right to make a new request.
      attempted.current = false;
      return;
    }
    if (attempted.current) return;
    attempted.current = true;

    let current = true;
    fetch(commerceApiUrl("/v1/public/tour"), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("TOUR_UNAVAILABLE"))))
      .then((body: unknown) => {
        if (!current) return;
        // Parsed against the expected contract rather than trusted: a shape
        // this code does not understand must leave the snapshot standing, not
        // half-apply.
        const live = parsePublicTour(body);
        setModel((previous) => reconcileSchedule(previous, live, liveFormat));
      })
      // Swallowed deliberately. A failed read is the documented "snapshot
      // stands" case, and there is nothing a visitor could act on here.
      .catch(() => {});

    return () => { current = false; };
  }, [enabled]);

  return model;
}
