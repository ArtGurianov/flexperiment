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
});
