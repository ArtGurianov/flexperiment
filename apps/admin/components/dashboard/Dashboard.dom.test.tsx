import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Dashboard } from "./Dashboard";

const baseResponse = {
  today: { orders: 3, revenue_kopecks: 300000, refunded_kopecks: 0 },
  health: {
    create_unknown: { count: 0 },
    review_required_payments: { count: 0 },
    review_required_refunds: { count: 0 },
    pending_refunds: { count: 2 },
    email_attention: { count: 0 },
    stale_prepared_settlements: { count: 0 },
    operational_incidents: { count: 0 },
    provider_drift: { count: 2 },
  },
  upcoming: [],
};

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn().mockResolvedValueOnce({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response);
}

describe("Dashboard", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("renders — for an omitted dashboard counter, never 0 (B2)", async () => {
    const { pending_refunds, ...healthWithoutPendingRefunds } = baseResponse.health;
    void pending_refunds;
    global.fetch = mockFetchOnce({ ...baseResponse, health: healthWithoutPendingRefunds });
    const client = createTestQueryClient();
    render(<Dashboard />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("Pending refunds")).toBeInTheDocument());
    const row = screen.getByText("Pending refunds").closest("a")!;
    expect(row).toHaveTextContent("—");
    expect(row).not.toHaveTextContent(/(^|\D)0(\D|$)/);
  });

  it("deep-links every health row to an equivalent destination filter (D3)", async () => {
    global.fetch = mockFetchOnce(baseResponse);
    const client = createTestQueryClient();
    render(<Dashboard />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("Pending refunds")).toBeInTheDocument());
    const expected: Record<string, [string, string]> = {
      "CREATE_UNKNOWN": ["/orders", "?payment_state=CREATE_UNKNOWN"],
      "REVIEW_REQUIRED (payments)": ["/orders", "?payment_status=REVIEW_REQUIRED"],
      "REVIEW_REQUIRED (refunds)": ["/refunds", "?status=REVIEW_REQUIRED"],
      "Pending refunds": ["/refunds", "?status=REQUESTED&status=SUBMITTING&status=SUBMIT_UNKNOWN&status=RECONCILING"],
      "Email attention": ["/email-attention", ""],
      "Stale PREPARED": ["/settlements", "?stale_prepared=1"],
      "Operational incidents": ["/incidents", "?status=OPEN"],
      "Provider drift": ["/incidents", "?provider_drift=1"],
    };
    for (const [label, [pathname, search]] of Object.entries(expected)) {
      const href = screen.getByText(label).closest("a")?.getAttribute("href") ?? "";
      const url = new URL(href, "https://admin.flexperiment.test");
      expect(url.pathname.replace(/\/$/, "")).toBe(pathname);
      expect(url.search).toBe(search);
    }
  });

  it("keeps each upcoming status with its city rather than absolutely positioning it over the card", async () => {
    global.fetch = mockFetchOnce({ ...baseResponse, upcoming: [{ id: "occurrence-1", city_title: "Томск", title: "Мастер-класс", starts_at: "2026-10-01T10:00:00.000Z", availability: 3, capacity: 10, sales_status: "OPEN" }] });
    const client = createTestQueryClient();
    render(<Dashboard />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("Мастер-класс")).toBeInTheDocument());
    const cityAndStatus = screen.getByText("Томск").closest(".upcoming-meta");
    expect(cityAndStatus).toHaveTextContent("OPEN");
    expect(screen.getByText("OPEN").closest(".upcoming-card")).toContainElement(cityAndStatus);
  });

  it("shows both pause authorities and keeps the emergency control reachable while a release owns sales", async () => {
    global.fetch = mockFetchOnce({
      ...baseResponse,
      sales_control: {
        effective_status: "PAUSED",
        emergency: { sales_paused: true, revision: 8, paused_at: "2026-08-31T10:00:00.000Z", paused_reason: "Operator hold" },
        release_paused: true,
      },
    });
    const client = createTestQueryClient();
    render(<Dashboard />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    expect(await screen.findByText(/Экстренная остановка включена/)).toBeInTheDocument();
    expect(screen.getByText(/Пауза release-control также включена/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Снять экстренную остановку" })).toBeEnabled();
  });

  it("shows the failure band and the last-success timestamp when a background refetch fails, never presenting the stale rows as current (A7)", async () => {
    const client = createTestQueryClient();
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) return { ok: true, status: 200, json: async () => baseResponse } as Response;
      return { ok: false, status: 500, json: async () => ({ error: { code: "INTERNAL_ERROR" } }) } as Response;
    });

    render(<Dashboard />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await waitFor(() => expect(screen.getByText(/Обновлено/)).toBeInTheDocument());

    // Force a background refetch that fails.
    await client.refetchQueries({ queryKey: ["dashboard", "summary"] }).catch(() => undefined);

    await waitFor(() => expect(screen.getByText(/Обновление не удалось/)).toBeInTheDocument());
    // The dashboard content (from the last successful fetch) must still be visible.
    expect(screen.getByText("Pending refunds")).toBeInTheDocument();
  });
});
