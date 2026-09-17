import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EventView from "./EventView";
import ScheduleView from "./ScheduleView";
import { toEventViewModel } from "@/lib/seo/event-view-model";
import { reconcileSchedule } from "@/lib/seo/schedule-reconciliation";
import { toScheduleViewModel } from "@/lib/seo/schedule-view-model";
import { seoOccurrence } from "@/lib/seo/public-occurrence-fixture";

/**
 * NOT_IN_LIVE_TOUR must reach the screen, not just the model.
 *
 * reconcileSchedule already decided such an occurrence is neither actionable
 * nor upcoming, and a unit test pinned that. But the two views ignored
 * `listing` entirely, so the decision died in the model: the catalogue still
 * offered «Подробности и запись» and the event surface still mounted a booking
 * CTA for a date the checkout could not honour.
 *
 * These are the behavioural half of that invariant.
 */
beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response) as typeof fetch;
});

const absentFromLiveTour = () => {
  // A successful read that simply does not contain the published occurrence.
  const model = toScheduleViewModel([seoOccurrence()]);
  return reconcileSchedule(model, [], () => ({}));
};

describe("a record the live tour no longer returns", () => {
  it("is not advertised in the schedule", () => {
    const reconciled = absentFromLiveTour();
    expect(reconciled.cities[0].upcoming[0].listing).toBe("NOT_IN_LIVE_TOUR");

    render(<ScheduleView model={reconciled} />);

    // Neither the booking affordance nor a link presented as an available date.
    expect(screen.queryByText("Подробности и запись")).not.toBeInTheDocument();
    expect(screen.getByText(/пока не объявлены/)).toBeInTheDocument();
    // And it is NOT relabelled as archival — the reason for its absence is
    // unknown, so calling it cancelled would assert more than is known.
    expect(screen.queryByText("Прошедшие и отменённые")).not.toBeInTheDocument();
  });

  it("still renders the schedule's other dates normally", () => {
    // The gate must be per record, not a blanket suppression.
    const model = toScheduleViewModel([seoOccurrence()]);
    render(<ScheduleView model={model} />);
    expect(screen.getByText("Подробности и запись")).toBeInTheDocument();
  });

  it("offers no booking CTA on the event surface", () => {
    const reconciled = absentFromLiveTour();
    const event = { ...toEventViewModel(seoOccurrence()), listing: "NOT_IN_LIVE_TOUR" as const };
    expect(reconciled.cities[0].upcoming[0].listing).toBe(event.listing);

    render(<EventView event={event} />);

    expect(screen.queryByText("Забронировать место")).not.toBeInTheDocument();
    expect(screen.getByText(/Запись сейчас недоступна/)).toBeInTheDocument();
    // Not described as cancelled or finished.
    expect(screen.queryByText(/отменён/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/прошёл/i)).not.toBeInTheDocument();
  });

  it("still offers booking for an ACTIONABLE event", () => {
    render(<EventView event={toEventViewModel(seoOccurrence())} />);
    expect(screen.getByText("Забронировать место")).toBeInTheDocument();
    expect(screen.queryByText(/Запись сейчас недоступна/)).not.toBeInTheDocument();
  });
});
