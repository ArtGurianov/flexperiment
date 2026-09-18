import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ModalRouteController from "./ModalRouteController";
import { getCityBySlug, type CitySlug } from "@/lib/city-catalog";
import type { SeoDeparture, SeoOccurrence, SeoTombstone } from "@/lib/seo/occurrence-snapshot";
import type { PublicOccurrence } from "@/lib/seo/public-occurrence";
import { publicOccurrence, seoOccurrence } from "@/lib/seo/public-occurrence-fixture";
import { toScheduleViewModel, type ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * WHAT THE DRAWER ACTUALLY RENDERS — the half a model suite cannot see.
 *
 * The previous pass shipped a green model suite and a wrong surface: the
 * intercepted /schedule reused the standalone page's renderer, so tapping a
 * booking CTA opened a grouped-by-city page of venue/price cards instead of the
 * compact «ГОРОДА × ДАТЫ» picker. Every assertion below is about the DOM,
 * driven through the real controller, the real dialog chrome and the real
 * click interception.
 *
 * Deliberately NOT asserted here: that a plain click pushes history and a
 * modified one does not. ModalRouteController.dom.test.tsx owns that contract
 * and must keep owning it — these tests are additive to it, never a
 * relaxation of it.
 */
beforeEach(() => {
  // DialogDrawer picks dialog vs drawer through useBreakpoint -> matchMedia,
  // which jsdom does not implement. The desktop dialog is the stable answer.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // The default: the live read fails, so the snapshot stands. Tests that care
  // about reconciliation install their own.
  global.fetch = vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  window.history.replaceState(null, "", "/");
  sandbox = document.createElement("div");
  document.body.appendChild(sandbox);
});
afterEach(() => { sandbox.remove(); vi.restoreAllMocks(); });

let sandbox: HTMLElement;

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
  city: CitySlug, cityTitle: string, startsAt: string, id: string, reason: SeoDeparture = "PAST",
): SeoTombstone => ({ ...at(city, cityTitle, startsAt, id), departed: reason });

const SPB_SEP = at("saint-petersburg", "Санкт-Петербург", "2030-09-25T10:00:00.000Z", "aaaaaaaa-0000-4000-8000-000000000001");
const NSK_OCT = at("novosibirsk", "Новосибирск", "2030-10-02T10:00:00.000Z", "bbbbbbbb-0000-4000-8000-000000000002");
const SPB_OCT = at("saint-petersburg", "Санкт-Петербург", "2030-10-18T10:00:00.000Z", "cccccccc-0000-4000-8000-000000000003");
const TOMSK_OCT = at("tomsk", "Томск", "2030-10-25T10:00:00.000Z", "dddddddd-0000-4000-8000-000000000004");
const MSK_PAST = departed("moscow", "Москва", "2020-01-01T10:00:00.000Z", "eeeeeeee-0000-4000-8000-000000000005", "CANCELLED");

/** SPB, NSK, SPB, Tomsk — two cities interleaved, which is what grouping hides. */
const tour = (): ScheduleViewModel =>
  toScheduleViewModel([SPB_SEP, NSK_OCT, SPB_OCT, TOMSK_OCT, MSK_PAST]);

/**
 * The same occurrence as `/v1/public/tour` would return it.
 *
 * The snapshot's venue is deliberately a narrower type than the wire's — it
 * drops `disclosure_text` and `announce_by`, which are live-only — so a record
 * cannot simply be spread into a wire shape.
 */
const live = (record: SeoOccurrence, overrides: Partial<PublicOccurrence> = {}) =>
  publicOccurrence({
    id: record.id,
    city: record.city,
    city_title: record.city_title,
    title: record.title,
    starts_at: record.starts_at,
    ends_at: record.ends_at,
    timezone: record.timezone,
    price_kopecks: record.price_kopecks,
    fulfillment_status: record.fulfillment_status,
    venue: { ...record.venue, disclosure_text: null, announce_by: null },
    ...overrides,
  });

const anchor = (href: string) => {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.textContent = href;
  sandbox.appendChild(a);
  return a;
};

const click = (el: HTMLElement, init: MouseEventInit = {}) =>
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));

const openSchedule = async (model: ScheduleViewModel = tour()) => {
  render(<ModalRouteController scheduleModel={model} />);
  click(anchor("/schedule"));
  return screen.findByTestId("modal-drawer");
};

/** Row labels in rendered order — the whole question this PR is about. */
const rows = (drawer: HTMLElement) =>
  [...drawer.querySelectorAll('a[href^="/events/"]')].map((a) => a.textContent?.replace(/\s+/g, " ").trim());

describe("the intercepted /schedule drawer", () => {
  it("is one global chronology, not a list of cities each holding dates", async () => {
    const drawer = await openSchedule();

    expect(rows(drawer)).toEqual([
      "Санкт-Петербург × 25.09.2030",
      "Новосибирск × 02.10.2030",
      "Санкт-Петербург × 18.10.2030",
      "Томск × 25.10.2030",
    ]);
    // Grouping would put both Petersburg dates together and print the city once
    // as a heading. Two separate rows naming it is the proof it did not.
    expect(drawer.querySelectorAll("h2, h3")).toHaveLength(0);
  });

  it("makes every occurrence a real anchor to its own page", async () => {
    const drawer = await openSchedule();
    const hrefs = [...drawer.querySelectorAll("a")].map((a) => a.getAttribute("href"));

    expect(hrefs).toEqual([
      `/events/${SPB_SEP.event_slug}`,
      `/events/${NSK_OCT.event_slug}`,
      `/events/${SPB_OCT.event_slug}`,
      `/events/${TOMSK_OCT.event_slug}`,
    ]);
    // Not a button that opens checkout — which is exactly what the pre-SEO row
    // was, and what this restoration must not bring back with the visual.
    expect(drawer.querySelector('a[href^="/events/"]')?.tagName).toBe("A");
    // And no fragment anywhere: the city is not a destination.
    for (const href of hrefs) expect(href).not.toContain("#");
  });

  it("wears the pre-SEO catalogue visual, restored from c7d897b", async () => {
    const drawer = await openSchedule();
    const row = drawer.querySelector('a[href^="/events/"]') as HTMLElement;
    const list = row.parentElement as HTMLElement;

    // The exact class tokens of CheckoutFlow's catalogue button and container.
    for (const token of [
      "border-2", "border-bone/50", "bg-bone", "px-4", "py-5",
      "text-left", "text-ink", "transition-colors",
      "hover:border-acid", "hover:bg-acid",
      "focus-visible:outline-2", "focus-visible:outline-offset-2", "focus-visible:outline-acid",
    ]) {
      expect(row.className).toContain(token);
    }
    expect(list.className).toContain("font-mono");
    expect(list.className).toContain("text-sm");
    expect(row.querySelector("span")?.className).toContain("font-display text-2xl");
  });

  it("splits the label so a wrap breaks at the separator and centres", async () => {
    const drawer = await openSchedule();
    const label = drawer.querySelector('a[href^="/events/"] > span') as HTMLElement;
    const parts = [...label.children] as HTMLElement[];

    // Two parts, and the «×» travels with the date. As one text run the browser
    // broke «Санкт-Петербург ×» onto the first line and left the bare date
    // below it, stranding the separator away from what it separates.
    expect(parts.map((part) => part.textContent)).toEqual([
      "Санкт-Петербург",
      "× 25.09.2030",
    ]);
    // `justify-between` sets the two parts on the row's outer edges whenever
    // they share a line; `flex-wrap` is what lets them break apart at all.
    expect(label.className).toContain("justify-between");
    expect(label.className).toContain("flex-wrap");
    // No `grow`: a part that fills its line leaves `justify-between` no free
    // space to distribute, so the edges would silently stop being edges.
    for (const part of parts) expect(part.className).toBe("");
  });

  it("still reads as one sentence to a screen reader and a crawler", async () => {
    // The visible separation is `gap-2`, which contributes no text. The literal
    // space between the two parts is what keeps the accessible name — and the
    // crawlable text of the static export — from reading
    // «Санкт-Петербург× 25.09.2030». It is easy to delete as stray JSX, so it
    // is pinned here.
    const drawer = await openSchedule();
    expect(drawer.querySelector('a[href^="/events/"]')?.textContent).toBe(
      "Санкт-Петербург × 25.09.2030",
    );
    expect(screen.getByRole("link", { name: "Санкт-Петербург × 25.09.2030" })).toBeInTheDocument();
  });

  it("shows CITY × DATE and nothing a detail card would show", async () => {
    const drawer = await openSchedule();
    const text = drawer.textContent ?? "";

    expect(text).not.toContain("Подробности и запись");
    // Venue and price belong to the event surface, where live state can speak
    // for them. A picker that restates them makes a claim it cannot support.
    expect(text).not.toContain("Студия");
    expect(text).not.toContain("Красный проспект");
    expect(text).not.toContain("₽");
    expect(text).not.toMatch(/мест|Продажи|запись закрыт/i);
  });

  it("shows no archive at all — that stays on the page", async () => {
    const drawer = await openSchedule();

    expect(drawer.textContent).not.toContain("Прошедшие и отменённые");
    expect(drawer.textContent).not.toContain("Москва");
    expect(drawer.querySelector(`a[href="/events/${MSK_PAST.event_slug}"]`)).toBeNull();
  });

  it("drops a date the live tour stopped returning, without archiving it", async () => {
    // A successful read that simply does not contain SPB_SEP.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ cities: [NSK_OCT, SPB_OCT, TOMSK_OCT].map((record) => live(record)) }),
    })) as unknown as typeof fetch;

    const drawer = await openSchedule();

    await waitFor(() => expect(rows(drawer)).toHaveLength(3));
    expect(rows(drawer)?.[0]).toBe("Новосибирск × 02.10.2030");
    // Not relabelled as cancelled: absence from tour() is ambiguous.
    expect(drawer.textContent).not.toContain("Прошедшие и отменённые");
    expect(drawer.textContent).not.toMatch(/Отменён/);
  });

  it("re-sorts when a live read moves a date past its neighbours", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        cities: [
          // SPB's September date has moved to November — it must fall to last.
          live(SPB_SEP, { starts_at: "2030-11-01T10:00:00.000Z", ends_at: "2030-11-01T12:00:00.000Z" }),
          live(NSK_OCT),
          live(SPB_OCT),
          live(TOMSK_OCT),
        ],
      }),
    })) as unknown as typeof fetch;

    const drawer = await openSchedule();
    // No assertion on the pre-reconciliation order here: `findByTestId` awaits,
    // which is enough for the mocked fetch's microtask to have already landed.
    // The snapshot order is pinned in the offline test above, where the read
    // fails and cannot race — so the two together do say the order moved.

    await waitFor(() =>
      expect(rows(drawer)).toEqual([
        "Новосибирск × 02.10.2030",
        "Санкт-Петербург × 18.10.2030",
        "Томск × 25.10.2030",
        "Санкт-Петербург × 01.11.2030",
      ]),
    );
  });
});

describe("«Твой город × Скоро» inside the drawer", () => {
  const cityInterestRow = () => screen.getByRole("button", { name: "Твой город × Скоро" });

  it("is a button, because it is the one row that is not a URL", async () => {
    const drawer = await openSchedule();
    expect(cityInterestRow().tagName).toBe("BUTTON");
    expect(within(drawer).queryByRole("link", { name: /Твой город/ })).toBeNull();
  });

  it("opens the form as a subview, retitling the dialog and offering Back", async () => {
    await openSchedule();
    const historyLength = window.history.length;

    fireEvent.click(cityInterestRow());

    expect(await screen.findByText("Не нашли свой город?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Назад" })).toBeInTheDocument();
    expect(screen.getByLabelText("Желаемый город")).toBeInTheDocument();
    // A panel inside /schedule, not a route: no URL change and no entry.
    expect(window.location.pathname).toBe("/schedule");
    expect(window.history.length).toBe(historyLength);
  });

  it("offers only cities that have no date of their own", async () => {
    await openSchedule();
    fireEvent.click(cityInterestRow());

    const options = [...(await screen.findByLabelText("Желаемый город")).querySelectorAll("option")]
      .map((option) => option.textContent);
    for (const scheduled of ["Санкт-Петербург", "Новосибирск", "Томск"]) {
      expect(options).not.toContain(scheduled);
    }
    // Moscow's only date has departed, so it is requestable again.
    expect(options).toContain("Москва");
  });

  it("returns to the list on Back, leaving the route and history untouched", async () => {
    const drawer = await openSchedule();
    const historyLength = window.history.length;
    fireEvent.click(cityInterestRow());
    await screen.findByText("Не нашли свой город?");

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));

    await waitFor(() => expect(rows(drawer)).toHaveLength(4));
    expect(screen.queryByLabelText("Желаемый город")).not.toBeInTheDocument();
    expect(screen.getByText("ГОРОДА × ДАТЫ")).toBeInTheDocument();
    // Back on a subview must NOT be Back on the session.
    expect(window.location.pathname).toBe("/schedule");
    expect(window.history.length).toBe(historyLength);
    expect(screen.queryByRole("button", { name: "Назад" })).toBeNull();
  });

  it("still closes through history, one step back to home", async () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    await openSchedule();
    fireEvent.click(cityInterestRow());
    await screen.findByText("Не нашли свой город?");

    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));

    // depth 1: the subview added no entry, so closing from it is still one hop.
    expect(go).toHaveBeenCalledWith(-1);
  });

  it("starts on the list again after the visitor has been somewhere else", async () => {
    await openSchedule();
    fireEvent.click(cityInterestRow());
    await screen.findByText("Не нашли свой город?");

    // schedule -> event -> back to schedule, the ordinary flow.
    click(anchor(`/events/${NSK_OCT.event_slug}`));
    await waitFor(() => expect(screen.queryByLabelText("Желаемый город")).not.toBeInTheDocument());
    window.history.back();

    await waitFor(() => expect(screen.getByText("ГОРОДА × ДАТЫ")).toBeInTheDocument());
    expect(screen.queryByLabelText("Желаемый город")).not.toBeInTheDocument();
  });
});
