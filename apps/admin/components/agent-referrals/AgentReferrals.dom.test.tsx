import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { AgentReferrals } from "./AgentReferrals";

const engagementDetail = (distributionId: string, extra: Record<string, unknown> = {}) => ({
  engagement: { id: distributionId === "d1" ? "e1" : "e2", lifecycle_state: "ACTIVE", created_at: "now" },
  latest_revision: null, creative: null,
  distributions: [{
    distribution_id: distributionId,
    current_revision: { revision: 1, channel_key: "telegram", channel_policy_status: "ALLOWED", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: `https://t.me/x/${distributionId}`, published_at: "2026-01-01T00:00:00.000Z", ended_at: null, reported_by: "PARTNER", correction_reason: null, evidence_ref: "ev", created_at: "now" },
    compliance_state: "MARKED_REPORTABLE", removal_state: null, reporting_periods: [],
  }],
  reward_registry: null, effective_reward_snapshot: null, settlement: null,
  act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
  ...extra,
});

/**
 * Round-5 fix regression: a review-queue item's focus/focusReporting is engagement-scoped state that must
 * not survive a manual navigation to a DIFFERENT engagement - otherwise AgentReferrals.tsx's own focus
 * state (still naming the OLD engagement's distribution) would drive DistributionsSection into
 * auto-opening a reporting form whose mutation target is a distribution that does not even belong to the
 * newly opened engagement.
 */
describe("AgentReferrals: queue-focus lifecycle across manual navigation", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("clears a reporting-tail queue focus once the operator manually leaves that engagement and opens a different one - no stale mutation target survives", async () => {
    const reportPostCalls: Array<{ url: string }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/agent-referrals/feature-state")) return { ok: true, status: 200, json: async () => ({ state: "ACTIVE", owner_id: "owner-1", revision: 3 }) } as Response;
      if (url.includes("/agent-referrals/review-queue")) {
        return {
          ok: true, status: 200, json: async () => ({
            distributions_review_required: { total: 0, items: [], truncated: false },
            distributions_removal_overdue: { total: 0, items: [], truncated: false },
            distributions_reporting_tail_incomplete: { total: 1, items: [{ distribution_id: "d1", engagement_id: "e1" }], truncated: false },
            acts_awaiting_presentation: { total: 0, items: [], truncated: false },
            payment_attempts_payout_unknown: { total: 0, items: [], truncated: false },
            npd_reconciliation_needed: { total: 0, items: [], truncated: false },
            partners_profile_pending_verification: { total: 0, items: [], truncated: false },
            partners_framework_not_issued: { total: 0, items: [], truncated: false },
          }),
        } as Response;
      }
      if (url.endsWith("/agent-referrals/engagements")) {
        return { ok: true, status: 200, json: async () => ({ engagements: [{ id: "e1", lifecycle_state: "ACTIVE" }, { id: "e2", lifecycle_state: "ACTIVE" }] }) } as Response;
      }
      if (url.endsWith("/agent-referrals/engagements/e1")) return { ok: true, status: 200, json: async () => engagementDetail("d1") } as Response;
      if (url.endsWith("/agent-referrals/engagements/e2")) return { ok: true, status: 200, json: async () => engagementDetail("d2") } as Response;
      if (/\/agent-referrals\/distributions\/.+\/reports/.test(url) && init?.method === "POST") {
        reportPostCalls.push({ url });
        return { ok: true, status: 201, json: async () => ({ id: "r2" }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });

    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<AgentReferrals />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    // 1. Queue -> E1/D1 reporting focus: expand the reporting-tail category and open its one item.
    await user.click(await screen.findByRole("button", { name: "Показать" }));
    await user.click(await screen.findByRole("button", { name: /Открыть d1/ }));

    // The reporting panel for d1 auto-opens (focusReporting was true for this category).
    await screen.findByRole("button", { name: "Скрыть отчётность" });

    // 2. Back to the campaign list.
    await user.click(await screen.findByRole("button", { name: "← Все кампании" }));
    await screen.findByRole("button", { name: "Предложить" });

    // 3. Manually open E2 (a completely different engagement, owning d2, not d1).
    const e2Row = (await screen.findByText("e2")).closest("tr")!;
    await user.click(e2Row.querySelector("button")!);

    // E2's own distribution (d2) must render with its reporting panel closed - the stale focus/
    // focusReporting from the E1/D1 queue click must not have survived the manual navigation.
    await screen.findByRole("button", { name: "Отчётность" });
    expect(screen.queryByRole("button", { name: "Скрыть отчётность" })).not.toBeInTheDocument();
    expect(document.querySelector('tr[data-focused="true"]')).toBeNull();

    // No mutation was ever sent to d1 (E1's distribution) while the operator was looking at E2.
    expect(reportPostCalls).toHaveLength(0);
  });
});
