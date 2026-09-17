import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaymentCta from "./PaymentCta";

/**
 * What the two checkout entry points render as CHROME.
 *
 * components/CheckoutFlow.dom.test.tsx already proves which occurrence each
 * entry point books. This proves the dialog around it, which is where the
 * split between catalogue and checkout actually shows up to a visitor — and
 * where a visual smoke of PR2 found a control that rendered, was announced to
 * assistive tech, and did nothing.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

// DialogDrawer chooses dialog vs drawer through useBreakpoint -> matchMedia.
// Both variants render the same controls, so one stable answer is enough.
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const CHOSEN = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

const occurrence = (id: string, cityTitle: string) => ({
  id, city: "novosibirsk", city_title: cityTitle, title: "FLEXPERIMENT",
  starts_at: "2030-03-14T04:00:00.000Z", timezone: "Asia/Novosibirsk",
  price_kopecks: 380000, availability: 10, sales_status: "OPEN",
  fulfillment_status: "SCHEDULED", purchase_status: "AVAILABLE",
  venue: { status: "CONFIRMED", name: "Студия", address: "Ленина 1", disclosure_text: null, announce_by: null },
});

const mockCommerce = (tour: unknown[]) => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/public/tour")) return { ok: true, json: async () => ({ cities: tour }) } as Response;
    if (url.includes("/v1/public/legal-config")) return { ok: true, json: async () => ({ occurrence_notifications_available: false }) } as Response;
    if (url.includes("/v1/public/checkout-context")) return { ok: true, json: async () => ({ quote_id: "q", price_kopecks: 380000, final_amount_kopecks: 380000, discount_kopecks: 0, promo: null, venue_disclosure: "", expires_at: "", legal_release: { version: "v", manifest: { documents: {} } } }) } as Response;
    return { ok: false, json: async () => ({}) } as Response;
  }) as typeof fetch;
};

/** Opens the dialog the way a visitor does, and waits for the lazy chunks. */
const openDialog = async (label: string) => {
  screen.getByRole("button", { name: label }).click();
  return waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
};

describe("PaymentCta dialog chrome", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("offers no Back when checkout was entered for one occurrence", async () => {
    mockCommerce([occurrence(CHOSEN, "Новосибирск"), occurrence(OTHER, "Томск")]);
    render(<PaymentCta occurrenceId={CHOSEN}>Забронировать место</PaymentCta>);
    await openDialog("Забронировать место");

    // Booking opened for the chosen date...
    await waitFor(
      () => expect(screen.getByRole("dialog").textContent).toMatch(/Новосибирск/),
      { timeout: 5000 },
    );
    // ...and there is nothing behind it. `backToCities` would remount
    // CheckoutFlow, whose tour effect re-opens this very booking view, so a
    // Back button here is a control that does nothing. Close is the way out.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Назад" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
  });

  it("keeps Back when checkout was entered through the catalogue", async () => {
    mockCommerce([occurrence(CHOSEN, "Новосибирск"), occurrence(OTHER, "Томск")]);
    render(<PaymentCta>Записаться</PaymentCta>);
    await openDialog("Записаться");

    // The catalogue picks nothing on its own; the visitor chooses a city, and
    // from there Back returns to the list they came from.
    const choose = await screen.findByRole("button", { name: /Новосибирск/ });
    choose.click();
    await waitFor(() => expect(screen.getByRole("button", { name: "Назад" })).toBeInTheDocument());
  });

  it("renders the checkout surface opaque, because it can sit on another dialog", async () => {
    mockCommerce([occurrence(CHOSEN, "Новосибирск")]);
    render(<PaymentCta occurrenceId={CHOSEN}>Забронировать место</PaymentCta>);
    await openDialog("Забронировать место");

    // The shared surface is bg-ink/90. Opened from the event drawer this
    // dialog stacks on top of one, and at 90% the date and price underneath
    // read through the payment form.
    const surface = screen.getByRole("dialog");
    expect(surface.className).toContain("bg-ink");
    expect(surface.className).not.toContain("bg-ink/90");
  });
});
