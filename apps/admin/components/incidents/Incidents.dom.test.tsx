import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { OperationalIncidents } from "./Incidents";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

describe("OperationalIncidents provider drift", () => {
  let originalFetch: typeof fetch;
  let originalUrl: string;
  beforeEach(() => { originalFetch = global.fetch; originalUrl = window.location.href; });
  afterEach(() => { global.fetch = originalFetch; window.history.replaceState(null, "", originalUrl); vi.restoreAllMocks(); });

  it("renders drift evidence links and requires a bookkeeping note before resolving", async () => {
    let reviewOpen = true;
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("/operational-incidents")) return { ok: true, status: 200, json: async () => ({ incidents: [], open_count: 0 }) } as Response;
      if (url.includes("/provider-drift-reviews") && method === "GET") return { ok: true, status: 200, json: async () => ({ reviews: reviewOpen ? [{ id: "drift-1", entity_type: "REFUND", entity_id: "refund-1", refund_id: "refund-1", refund_source: "ADMIN_COMPENSATION", payment_id: "payment-1", order_id: "order-1", public_order_number: "FX-1", observed_json: "{}", created_at: "2026-08-28T00:00:00.000Z" }] : [] }) } as Response;
      if (url.includes("/provider-drift-reviews/drift-1/resolve")) { reviewOpen = false; return { ok: true, status: 200, json: async () => ({ resolved: true }) } as Response; }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const client = createTestQueryClient(); const user = userEvent.setup();
    render(<OperationalIncidents />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    const evidenceLink = await screen.findByRole("link", { name: /Открыть заказ FX-1/ });
    expect(evidenceLink).toHaveAttribute("href", "/orders?id=order-1");
    expect(screen.getByText("Refund: ADMIN_COMPENSATION")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Закрыть review" }));
    const dialog = screen.getByRole("dialog", { name: "Закрыть provider drift review" });
    await user.click(within(dialog).getByRole("button", { name: "Закрыть review" }));
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
    await user.type(within(dialog).getByRole("textbox"), "Evidence reconciled");
    await user.click(within(dialog).getByRole("button", { name: "Закрыть review" }));
    await waitFor(() => expect(requests.find((request) => request.method === "POST")).toMatchObject({ body: JSON.stringify({ note: "Evidence reconciled" }) }));
    expect(requests.every((request) => !request.url.includes("/payments/") || request.method !== "POST")).toBe(true);
  });
});
