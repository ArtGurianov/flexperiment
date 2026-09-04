import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Overview } from "./Overview";

const category = (total = 0, items: Record<string, unknown>[] = []) => ({ total, items, truncated: total > items.length });
const emptyReviewQueue = {
  distributions_review_required: category(), distributions_removal_overdue: category(), distributions_reporting_tail_incomplete: category(),
  acts_awaiting_presentation: category(), payment_attempts_payout_unknown: category(), npd_reconciliation_needed: category(),
  partners_profile_pending_verification: category(), partners_framework_not_issued: category(),
};

describe("Overview (Agent Referrals admin console)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("renders the feature state and the review queue TRUE totals, even when the item page is smaller", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/agent-referrals/feature-state")) return { ok: true, status: 200, json: async () => ({ state: "ACTIVE", owner_id: "owner-1", revision: 3 }) } as Response;
      if (String(input).includes("/agent-referrals/review-queue")) {
        return {
          ok: true, status: 200, json: async () => ({
            ...emptyReviewQueue,
            distributions_review_required: { total: 137, items: [{ distribution_id: "d1", engagement_id: "e1" }], truncated: true },
          }),
        } as Response;
      }
      throw new Error(`unhandled fetch: ${input}`);
    });
    const client = createTestQueryClient();
    render(<Overview onNavigate={() => undefined} />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("ACTIVE")).toBeInTheDocument());
    expect(screen.getByText("Размещения, требующие проверки канала")).toBeInTheDocument();
    // The rendered total must be the TRUE count (137), never silently capped
    // at the bounded item-page size (1 item returned here).
    expect(screen.getByText("137")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Приостановить/ })).toBeInTheDocument();
  });

  it("expanding a nonempty category renders its items as navigable links, and clicking one calls onNavigate with the item's own engagement_id", async () => {
    const navigated: Array<{ tab: string; id: string }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/agent-referrals/feature-state")) return { ok: true, status: 200, json: async () => ({ state: "ACTIVE", owner_id: "owner-1", revision: 3 }) } as Response;
      if (String(input).includes("/agent-referrals/review-queue")) {
        return {
          ok: true, status: 200, json: async () => ({
            ...emptyReviewQueue,
            distributions_review_required: { total: 1, items: [{ distribution_id: "d1", engagement_id: "e1" }], truncated: false },
          }),
        } as Response;
      }
      throw new Error(`unhandled fetch: ${input}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<Overview onNavigate={(tab, id) => navigated.push({ tab, id })} />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: "Показать" }));
    await user.click(await screen.findByRole("button", { name: /Открыть d1/ }));
    expect(navigated).toEqual([{ tab: "engagements", id: "e1" }]);
  });

  it("suspends the feature with the exact expected_revision read from the current state, and refreshes it afterwards", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let state = { state: "ACTIVE", owner_id: "owner-1", revision: 3 };
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/agent-referrals/feature-state/suspend")) {
        requests.push({ url, body: JSON.parse(String(init?.body)) });
        state = { state: "SUSPENDED", owner_id: "owner-1", revision: 4 };
        return { ok: true, status: 200, json: async () => state } as Response;
      }
      if (url.includes("/agent-referrals/feature-state")) return { ok: true, status: 200, json: async () => state } as Response;
      if (url.includes("/agent-referrals/review-queue")) return { ok: true, status: 200, json: async () => emptyReviewQueue } as Response;
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<Overview onNavigate={() => undefined} />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: /Приостановить/ }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toMatchObject({ expected_revision: 3 });
    await waitFor(() => expect(screen.getByText("SUSPENDED")).toBeInTheDocument());
  });
});
