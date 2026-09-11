import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Partners } from "./Partners";

function PartnersHarness() {
  const [selected, setSelected] = useState<string | null>(null);
  return <Partners selected={selected} onSelect={setSelected} />;
}

describe("Partners (Agent Referrals admin console)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("provisions a new partner via the invite form, sending only agent_id/email/reason", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/agent-referrals/partners") && (!init?.method || init.method === "GET")) return { ok: true, status: 200, json: async () => ({ partners: [] }) } as Response;
      if (url.includes("/agent-referrals/partners") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, json: async () => ({ partner_identity_id: "p1", invite_id: "i1", raw_invite_token: "tok" }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<PartnersHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.type(await screen.findByLabelText(/ID агента/), "agent-1");
    await user.type(screen.getByLabelText("Email"), "partner@example.test");
    await user.clear(screen.getByLabelText("Причина"));
    await user.type(screen.getByLabelText("Причина"), "onboarding");
    await user.click(screen.getByRole("button", { name: "Пригласить" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toEqual({ agent_id: "agent-1", email: "partner@example.test", reason: "onboarding" });
  });

  it("opening a partner at PROFILE_SUBMITTED offers exactly the legal-profile verification action, and it advances the onboarding state on click", async () => {
    let onboardingState = "PROFILE_SUBMITTED";
    const verifyCalls: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/partners")) return { ok: true, status: 200, json: async () => ({ partners: [{ id: "p1", agent_id: "a1", slug: "p1", display_name: "Partner One", onboarding_state: onboardingState, destroyed_at: null, created_at: "now" }] }) } as Response;
      if (url.includes("/agent-referrals/partners/p1/legal-profile/verify")) {
        verifyCalls.push(url);
        onboardingState = "PROFILE_VERIFIED";
        return { ok: true, status: 200, json: async () => ({ id: "p1", onboarding_state: onboardingState }) } as Response;
      }
      if (url.endsWith("/agent-referrals/partners/p1")) {
        return { ok: true, status: 200, json: async () => ({ identity: { id: "p1", email: "p@example.test", onboarding_state: onboardingState, onboarding_revision: 3 }, engagements: [], invites: [], audience_verifications: [], legal_holds: [] }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<PartnersHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: "Открыть" }));
    const verifyButton = await screen.findByRole("button", { name: "Проверить юридический профиль" });
    expect(screen.queryByRole("button", { name: /Активировать партнёра/ })).not.toBeInTheDocument();
    await user.click(verifyButton);
    await waitFor(() => expect(verifyCalls).toHaveLength(1));
  });

  // PR-C: the reliability contract the raw api() + local busy/error pattern
  // never had. An ambiguous failure (the connection dropped before any
  // answer) must re-read authoritative state, because the command may well
  // have committed - leaving the operator looking at pre-command data with
  // an error on screen is the exact failure mode useAdminMutation exists to
  // prevent.
  it("re-reads authoritative state after an ambiguous command failure, instead of leaving stale data on screen", async () => {
    const detailReads: number[] = [];
    let commandAttempts = 0;
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/partners")) {
        return { ok: true, status: 200, json: async () => ({ partners: [{ id: "p1", agent_id: "a1", slug: "p1", display_name: "Partner One", onboarding_state: "PROFILE_SUBMITTED", destroyed_at: null, created_at: "now" }] }) } as Response;
      }
      if (url.includes("/legal-profile/verify")) {
        commandAttempts += 1;
        throw new TypeError("network down");  // api() turns this into NETWORK_AMBIGUOUS
      }
      if (url.endsWith("/agent-referrals/partners/p1")) {
        detailReads.push(Date.now());
        return { ok: true, status: 200, json: async () => ({ identity: { id: "p1", email: "p@example.test", onboarding_state: "PROFILE_SUBMITTED", onboarding_revision: 3 }, engagements: [], invites: [], audience_verifications: [], legal_holds: [] }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<PartnersHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByRole("button", { name: "Проверить юридический профиль" });
    const readsBeforeCommand = detailReads.length;

    await user.click(screen.getByRole("button", { name: "Проверить юридический профиль" }));

    await waitFor(() => expect(commandAttempts).toBe(1));
    // The ambiguous failure is surfaced to the operator...
    expect(await screen.findByText(/NETWORK_AMBIGUOUS/)).toBeInTheDocument();
    // ...AND the partner detail was re-read, so what they see next to that
    // error is the server's current answer, not the pre-command render.
    await waitFor(() => expect(detailReads.length).toBeGreaterThan(readsBeforeCommand));
    // Never auto-retried: a NETWORK_AMBIGUOUS command must not be replayed
    // on its own (lib/query-config.ts pins mutations to retry: 0).
    expect(commandAttempts).toBe(1);
  });
});
