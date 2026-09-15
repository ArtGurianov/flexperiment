import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CheckoutFlow from "./CheckoutFlow";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/referral-capture-client", () => ({ ensureCurrentReferralCapture: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/components/referral-capture-state", () => ({ referralCaptureCoordinator: { waitForCurrentCapture: vi.fn().mockResolvedValue(undefined) } }));

const availableOccurrence = {
  id: "occurrence-1", city: "tomsk", city_title: "Томск", title: "Inventory", starts_at: "2030-10-01T10:00:00.000Z", timezone: "Asia/Tomsk", price_kopecks: 100000, availability: 1,
  sales_status: "OPEN" as const, fulfillment_status: "SCHEDULED" as const, purchase_status: "AVAILABLE" as const,
  venue: { status: "CONFIRMED" as const, name: "Studio", address: "Lenina 1", disclosure_text: null, announce_by: null },
};

describe("CheckoutFlow inventory reconciliation", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("keeps the SOLD_OUT explanation after a successful occurrence refresh", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/public/tour")) return { ok: true, json: async () => ({ cities: [availableOccurrence] }) } as Response;
      if (url.endsWith("/v1/public/legal-config")) return { ok: true, json: async () => ({ occurrence_notifications_available: false }) } as Response;
      if (url.endsWith("/v1/public/checkout-context")) return { ok: false, json: async () => ({ error: { code: "SOLD_OUT" } }) } as Response;
      if (url.endsWith("/v1/public/occurrences/occurrence-1")) return { ok: true, json: async () => ({ ...availableOccurrence, availability: 0, purchase_status: "SOLD_OUT" }) } as Response;
      throw new Error(`unexpected request ${url}`);
    });

    const user = userEvent.setup();
    render(<CheckoutFlow onViewChange={vi.fn()} onBookingTitle={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Томск/ }));
    expect(await screen.findByText("Свободных мест больше нет. Данные о наличии обновились.")).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/v1/public/occurrences/occurrence-1"), { cache: "no-store" }));
    expect(screen.getByText("Свободных мест больше нет. Данные о наличии обновились.")).toBeInTheDocument();
  });
});
