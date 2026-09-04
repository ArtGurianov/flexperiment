import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("requires the operator to enter an actual evidence reference before REMOVAL_CONFIRMED - never a fabricated placeholder", async () => {
    let removalState: string | null = "REMOVAL_CLAIMED";
    const confirmCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(removalState)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      if (url.includes("/agent-referrals/distributions/d1/confirm-removal")) {
        confirmCalls.push({ url, body: JSON.parse(String(init?.body)) });
        removalState = "REMOVAL_CONFIRMED";
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    const evidenceInput = await screen.findByPlaceholderText("Ссылка на подтверждение снятия");
    // No submission is possible without the operator actually typing something -
    // required:true on the field, proven by attempting a click first.
    const confirmButton = screen.getByRole("button", { name: "Подтвердить снятие" });
    await user.click(confirmButton);
    expect(confirmCalls).toHaveLength(0);

    await user.type(evidenceInput, "https://t.me/x/1/2 — screenshot reviewed 2026-09-05");
    await user.click(confirmButton);
    await waitFor(() => expect(confirmCalls).toHaveLength(1));
    expect(confirmCalls[0].body).toEqual({ evidence_ref: "https://t.me/x/1/2 — screenshot reviewed 2026-09-05" });
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
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
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

  it("distribution fact intake and correction: reporting a new distribution posts the exact partner-facing fields, and correcting an existing one requires a correction reason", async () => {
    const reportCalls: Array<{ body: Record<string, unknown> }> = [];
    const correctCalls: Array<{ body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(null)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      if (url.endsWith("/agent-referrals/engagements/e1/distributions") && init?.method === "POST") {
        reportCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, json: async () => ({ distribution_id: "d2" }) } as Response;
      }
      if (url.endsWith("/agent-referrals/distributions/d1/correct") && init?.method === "POST") {
        correctCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.type(await screen.findByLabelText("Идентификатор ресурса"), "new-channel-post");
    await user.type(screen.getByLabelText("Ссылка на публикацию"), "https://t.me/x/9");
    await user.type(screen.getByLabelText("Дата публикации"), "2026-09-01T10:00");
    await user.type(screen.getByLabelText("Ссылка на подтверждение"), "ev-new");
    // "Канал" appears in both the report form and (once opened) the correction form - target the report form's own field explicitly.
    await user.type(screen.getAllByLabelText("Канал")[0], "telegram");
    await user.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(reportCalls).toHaveLength(1));
    expect(reportCalls[0].body).toMatchObject({ channel_key: "telegram", resource_identifier: "new-channel-post", distribution_resource_url: "https://t.me/x/9", evidence_ref: "ev-new" });
    expect(reportCalls[0].body).not.toHaveProperty("correction_reason");

    await user.click(screen.getByRole("button", { name: "Скорректировать" }));
    const correctionForm = (await screen.findByText("Скорректировать факт размещения")).closest("form")!;
    await user.type(within(correctionForm).getByLabelText("Ссылка на подтверждение"), "ev-correction");
    await user.type(within(correctionForm).getByLabelText("Причина коррекции"), "wrong URL");
    await user.click(within(correctionForm).getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(correctCalls).toHaveLength(1));
    expect(correctCalls[0].body).toMatchObject({ correction_reason: "wrong URL", evidence_ref: "ev-correction" });
  });
});
