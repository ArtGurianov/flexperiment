import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StandaloneScheduleView from "./StandaloneScheduleView";
import { getCityBySlug, type CitySlug } from "@/lib/city-catalog";
import type { SeoDeparture, SeoTombstone } from "@/lib/seo/occurrence-snapshot";
import { seoOccurrence } from "@/lib/seo/public-occurrence-fixture";
import { toScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * The standalone page's presentation — the same rows, a different shell.
 *
 * What this pins is the split itself: /schedule and the drawer now share the
 * upcoming list and the row visual, and nothing else. The page keeps the two
 * things only a permanent, indexable URL can carry — the archive, and a
 * city-interest form that opens IN PLACE rather than stacking a second modal on
 * a document that is not a modal.
 */
beforeEach(() => {
  global.fetch = vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
});

const at = (city: CitySlug, cityTitle: string, startsAt: string, id: string) =>
  seoOccurrence({
    id,
    event_slug: `${city}-${id}`,
    city,
    city_title: cityTitle,
    starts_at: startsAt,
    ends_at: new Date(Date.parse(startsAt) + 2 * 60 * 60 * 1000).toISOString(),
    timezone: getCityBySlug(city).timezone,
  });

const departed = (
  city: CitySlug, cityTitle: string, startsAt: string, id: string, reason: SeoDeparture,
): SeoTombstone => ({ ...at(city, cityTitle, startsAt, id), departed: reason });

const SPB_SEP = at("saint-petersburg", "Санкт-Петербург", "2030-09-25T10:00:00.000Z", "aaaaaaaa-0000-4000-8000-000000000001");
const NSK_OCT = at("novosibirsk", "Новосибирск", "2030-10-02T10:00:00.000Z", "bbbbbbbb-0000-4000-8000-000000000002");
const SPB_OCT = at("saint-petersburg", "Санкт-Петербург", "2030-10-18T10:00:00.000Z", "cccccccc-0000-4000-8000-000000000003");
const MSK_CANCELLED = departed("moscow", "Москва", "2020-01-01T10:00:00.000Z", "eeeeeeee-0000-4000-8000-000000000005", "CANCELLED");

const model = () => toScheduleViewModel([SPB_SEP, NSK_OCT, SPB_OCT, MSK_CANCELLED]);

const upcomingRows = (container: HTMLElement) =>
  [...container.querySelectorAll('a[href^="/events/"]')]
    .filter((a) => a.className.includes("bg-bone"))
    .map((a) => a.textContent?.replace(/\s+/g, " ").trim());

describe("the standalone /schedule list", () => {
  it("is the same global chronology, in the same minimalist row", () => {
    const { container } = render(<StandaloneScheduleView model={model()} />);

    expect(upcomingRows(container)).toEqual([
      "Санкт-Петербург × 25 сентября 2030 г.",
      "Новосибирск × 02 октября 2030 г.",
      "Санкт-Петербург × 18 октября 2030 г.",
    ]);
    const row = container.querySelector('a[href^="/events/"]') as HTMLElement;
    expect(row.className).toContain("border-2 border-bone/50 bg-bone");
    expect(row.className).toContain("hover:border-acid hover:bg-acid");
    // Not the DarkPanel detail card the page used to render.
    expect(container.textContent).not.toContain("Подробности и запись");
    expect(container.textContent).not.toContain("Красный проспект");
  });

  it("carries no city anchor and no fragment link", () => {
    const { container } = render(<StandaloneScheduleView model={model()} />);

    // The legacy `first upcoming row for a city owns id="<city-slug>"` rule is
    // deleted, not relocated: /cities/<city> now 308s to bare /schedule.
    for (const slug of ["saint-petersburg", "novosibirsk", "moscow"]) {
      expect(container.querySelector(`#${slug}`)).toBeNull();
    }
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href")).not.toContain("#");
    }
  });

  it("keeps departed dates in their own quiet section, never in the picker", () => {
    const { container } = render(<StandaloneScheduleView model={model()} />);

    expect(screen.getByText("Прошедшие и отменённые")).toBeInTheDocument();
    const archivalRow = container.querySelector(`a[href="/events/${MSK_CANCELLED.event_slug}"]`) as HTMLElement;
    // Still a real link — the URL is permanent and has been indexed and shared.
    expect(archivalRow.tagName).toBe("A");
    // But visually secondary: no bone slab, and it says what happened.
    expect(archivalRow.className).not.toContain("bg-bone");
    expect(archivalRow.textContent).toContain("Отменён");
    // `toContain` on an array is identity-based, so join first — an asymmetric
    // matcher there would silently pass whatever the rows said.
    expect(upcomingRows(container).join(" ")).not.toContain("Москва");
  });

  it("says plainly when nothing is announced, and still takes a request", () => {
    render(<StandaloneScheduleView model={toScheduleViewModel([])} />);

    expect(screen.getByRole("status")).toHaveTextContent(/Ближайшие даты пока не объявлены/);
    expect(screen.getByRole("button", { name: "Твой город × Скоро" })).toBeInTheDocument();
  });
});

describe("city interest on the standalone page", () => {
  const row = () => screen.getByRole("button", { name: "Твой город × Скоро" });

  it("expands in place rather than opening a second modal", async () => {
    render(<StandaloneScheduleView model={model()} />);
    expect(row()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Желаемый город")).not.toBeInTheDocument();

    fireEvent.click(row());

    const select = await screen.findByLabelText("Желаемый город");
    expect(select).toBeInTheDocument();
    expect(row()).toHaveAttribute("aria-expanded", "true");
    // A page, not a dialog: nothing here traps focus or covers the document.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus into the region it just revealed", async () => {
    render(<StandaloneScheduleView model={model()} />);
    fireEvent.click(row());

    const panelId = row().getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId as string) as HTMLElement;
    // Otherwise a keyboard visitor is left on the button, several tab stops
    // above the field they just asked for.
    await waitFor(() => expect(document.activeElement).toBe(panel));
    expect(within(panel).getByLabelText("Желаемый город")).toBeInTheDocument();
  });
});
