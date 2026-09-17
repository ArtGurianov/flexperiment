import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CheckoutFlow from "./CheckoutFlow";

// CheckoutFlow calls useRouter for the post-payment redirect, which needs the
// App Router context a bare render() does not provide.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

/**
 * The two explicit-selection entry points, asserted semantically.
 *
 * commerce/test/email-templates.test.ts guards this file by reading it as text,
 * which proves a line is present or absent but says nothing about behaviour.
 * These prove the behaviour that guard exists to protect:
 *
 *   the catalogue path never picks for the visitor, and
 *   `initialOccurrenceId = A` can never lead to checkout of B.
 */
const A = "11111111-2222-4333-8444-555555555555";
const B = "99999999-2222-4333-8444-555555555555";

const occurrence = (id: string, cityTitle: string) => ({
  id, city: "novosibirsk", city_title: cityTitle, title: "FLEXPERIMENT",
  starts_at: "2030-03-14T04:00:00.000Z", timezone: "Asia/Novosibirsk",
  price_kopecks: 380000, availability: 10, sales_status: "OPEN",
  fulfillment_status: "SCHEDULED", purchase_status: "AVAILABLE",
  venue: { status: "CONFIRMED", name: "Студия", address: "Ленина 1", disclosure_text: null, announce_by: null },
});

/** Records every call so a quote for the wrong occurrence cannot pass unnoticed. */
const mockCommerce = (tour: unknown[], overrides: Record<string, unknown> = {}) => {
  const calls: { url: string; body?: string }[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    for (const [fragment, response] of Object.entries(overrides)) {
      if (url.includes(fragment)) return response as Response;
    }
    if (url.includes("/v1/public/tour")) return { ok: true, json: async () => ({ cities: tour }) } as Response;
    if (url.includes("/v1/public/legal-config")) return { ok: true, json: async () => ({ occurrence_notifications_available: false }) } as Response;
    if (url.includes("/v1/public/checkout-context")) return { ok: true, json: async () => ({ quote_id: "q", price_kopecks: 380000, final_amount_kopecks: 380000, discount_kopecks: 0, promo: null, venue_disclosure: "", expires_at: "", legal_release: { version: "v", manifest: { documents: {} } } }) } as Response;
    return { ok: false, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return calls;
};

const quoteBodies = (calls: { url: string; body?: string }[]) =>
  calls.filter((c) => c.url.includes("/v1/public/checkout-context")).map((c) => c.body ?? "");

const props = { onViewChange: () => {}, onBookingTitle: () => {} };

describe("CheckoutFlow entry points", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("without initialOccurrenceId, loads the catalogue and picks nothing", async () => {
    const calls = mockCommerce([occurrence(A, "Новосибирск"), occurrence(B, "Томск")]);
    render(<CheckoutFlow {...props} />);

    await screen.findByText(/Новосибирск/);
    // Both offered, nothing chosen, and crucially no quote requested — the
    // visitor has not selected anything yet.
    expect(screen.getByText(/Томск/)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/v1/public/tour"))).toBe(true));
    expect(quoteBodies(calls)).toEqual([]);
  });

  it("with initialOccurrenceId, opens booking for exactly that occurrence", async () => {
    const calls = mockCommerce([occurrence(A, "Новосибирск"), occurrence(B, "Томск")]);
    render(<CheckoutFlow {...props} initialOccurrenceId={A} />);

    // Booking view, not the catalogue.
    await screen.findByText("Возрастная категория участника");
    await waitFor(() => expect(quoteBodies(calls).length).toBeGreaterThan(0));
    for (const body of quoteBodies(calls)) {
      expect(body).toContain(A);
      expect(body).not.toContain(B);
    }
  });

  it("never substitutes another occurrence when the chosen one is not in the live tour", async () => {
    // A is gone from the tour and its own endpoint is unavailable too. The
    // visitor asked for A; they must not end up in checkout for B.
    const calls = mockCommerce([occurrence(B, "Томск")], {
      [`/v1/public/occurrences/${A}`]: { ok: false, json: async () => ({}) } as Response,
    });
    render(<CheckoutFlow {...props} initialOccurrenceId={A} />);

    await screen.findByText("Актуальное состояние этой даты изменилось.");
    // No quote at all, and certainly not for B.
    expect(quoteBodies(calls)).toEqual([]);
    expect(screen.queryByText("Возрастная категория участника")).not.toBeInTheDocument();
  });

  it("recovers the chosen occurrence from its own endpoint when the tour has dropped it", async () => {
    // tour() filters to SCHEDULED-and-future; /v1/public/occurrences/{id} does
    // not. If Commerce still knows the occurrence, the explicit choice stands.
    const calls = mockCommerce([occurrence(B, "Томск")], {
      [`/v1/public/occurrences/${A}`]: { ok: true, json: async () => occurrence(A, "Новосибирск") } as Response,
    });
    render(<CheckoutFlow {...props} initialOccurrenceId={A} />);

    await screen.findByText("Возрастная категория участника");
    await waitFor(() => expect(quoteBodies(calls).length).toBeGreaterThan(0));
    for (const body of quoteBodies(calls)) {
      expect(body).toContain(A);
      expect(body).not.toContain(B);
    }
  });
});
