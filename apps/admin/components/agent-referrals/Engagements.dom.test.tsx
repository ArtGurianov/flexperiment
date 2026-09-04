import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Engagements } from "./Engagements";

function EngagementsHarness() {
  const [selected, setSelected] = useState<string | null>("e1");
  return <Engagements selected={selected} onSelect={setSelected} />;
}

const distributionRow = (removalState: string | null) => ({
  distribution_id: "d1",
  current_revision: { revision: 1, channel_key: "telegram", channel_policy_status: "ALLOWED", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1", published_at: "2026-01-01T00:00:00.000Z", ended_at: null, reported_by: "PARTNER", correction_reason: null, evidence_ref: "ev", created_at: "now" },
  compliance_state: "MARKED_REPORTABLE",
  removal_state: removalState,
  reporting_periods: [],
});

describe("Engagements (Agent Referrals admin console): distribution removal verification", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("offers 'confirm removal' for a REMOVAL_CLAIMED distribution, and posts to confirm-removal on click", async () => {
    let removalState: string | null = "REMOVAL_CLAIMED";
    const confirmCalls: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(removalState)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
          }),
        } as Response;
      }
      if (url.includes("/agent-referrals/distributions/d1/confirm-removal")) {
        confirmCalls.push(url);
        removalState = "REMOVAL_CONFIRMED";
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    const confirmButton = await screen.findByRole("button", { name: "Подтвердить снятие" });
    await user.click(confirmButton);
    await waitFor(() => expect(confirmCalls).toHaveLength(1));
  });

  it("never offers 'confirm removal' for a distribution with no removal event yet - only 'require removal'", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(null)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
          }),
        } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await screen.findByRole("button", { name: "Требовать снятия" });
    expect(screen.queryByRole("button", { name: "Подтвердить снятие" })).not.toBeInTheDocument();
  });
});
