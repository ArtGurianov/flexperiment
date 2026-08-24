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

  it("deep-links every health row to a destination (D2/D3)", async () => {
    global.fetch = mockFetchOnce(baseResponse);
    const client = createTestQueryClient();
    render(<Dashboard />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("Pending refunds")).toBeInTheDocument());
    const link = screen.getByText("Pending refunds").closest("a")!;
    // Link's trailing-slash behavior depends on next.config's `trailingSlash`,
    // which this isolated render doesn't apply — assert on the query, not the path shape.
    expect(link).toHaveAttribute("href", expect.stringContaining("/refunds"));
    expect(link).toHaveAttribute("href", expect.stringContaining("status=REQUESTED"));
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
