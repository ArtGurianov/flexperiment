"use client";

import StandaloneScheduleView from "@/components/StandaloneScheduleView";
import { useReconciledSchedule } from "@/hooks/useReconciledSchedule";
import type { ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * /schedule's client wrapper: static snapshot HTML first, then one live read.
 *
 * Eager rather than lazy, and that asymmetry with the home page is deliberate.
 * Loading this page IS the intent to see the schedule, so the read is already
 * earned. On the home page it is not — most visitors never open the catalogue,
 * and making every landing pay a Commerce request for a drawer they will not
 * open is the wrong trade.
 *
 * Reconciliation is the ONE thing the two surfaces share at this layer, which
 * is why it stays here and in ModalRouteController rather than inside either
 * view: a live read that moves a date must move the row on both, and the
 * chronological ordering is derived from the reconciled model at render time.
 */
export default function LiveScheduleView({ initialModel }: { initialModel: ScheduleViewModel }) {
  return <StandaloneScheduleView model={useReconciledSchedule(initialModel, true)} />;
}
