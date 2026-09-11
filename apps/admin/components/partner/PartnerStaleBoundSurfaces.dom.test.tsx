import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Profile } from "./Profile";
import { Engagements } from "./Engagements";

/**
 * PR-C2 review round 2, the two partner surfaces that carry a STALE_BOUND
 * pin. Both were wired wrongly and neither had a test holding them:
 *
 *  - the initial legal-profile submission sent its pin but exposed no
 *    retained-intent choice, because the only notice lived inside the
 *    PARTNER_ACTIVE section - which an ambiguous first submit never reaches;
 *  - the removal claim sent no pin at all, so the button simply 422'd
 *    against a route that now requires one.
 *
 * These assert the HTTP shape and the retained-intent affordance on the real
 * components, which is the level the defects actually lived at.
 */

const ME = {
  partner_identity_id: "pi1",
  email: "p@example.test",
  onboarding_state: "INVITED",
  submitted_legal_form: null, submitted_tax_mode: null, submitted_opf: null, submitted_full_name: null,
  submitted_short_name: null, submitted_inn: null, submitted_kpp: null, submitted_registration_number: null,
  submitted_legal_address: null,
  legal_profile_draft_revision: 0,
  legal_profile: null,
  legal_profile_change_request_head: 0,
  pending_legal_profile_change_request: null,
  tax_treatment: null,
  payout_profile: null,
  promo_code: null,
  delegation_effective: false,
};

const ENGAGEMENT_LIST_ROW = {
  engagement_id: "e1",
  lifecycle_state: "ACTIVE",
  occurrence: { title: "FLEXPERIMENT", city_title: "Томск" },
};

const ENGAGEMENT_DETAIL = {
  engagement: { id: "e1", lifecycle_state: "ACTIVE", lifecycle_revision: 3, occurrence_id: "o1" },
  occurrence: { id: "o1", title: "FLEXPERIMENT", city_title: "Томск", starts_at: "2026-01-01T00:00:00.000Z", fulfillment_status: "COMPLETED" },
  latest_revision_accepted: true,
  reward: { registry_finalized: false, reward_total_kopecks: null },
  erid: null,
  latest_revision: { id: "r1", revision: 1, reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: 1000, publication_start_at: "2026-01-01T00:00:00.000Z", publication_end_at: "2026-02-01T00:00:00.000Z" },
  creative: null,
  distributions: [{
    distribution_id: "d1",
    current_revision: { revision: 1, channel_key: "telegram", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1", published_at: "2026-01-01T00:00:00.000Z", ended_at: null, evidence_ref: "ev" },
    compliance_state: "MARKED_REPORTABLE",
    removal_state: "REMOVAL_REQUIRED",
    // The pin the claim button must send.
    event_sequence: 9,
    reporting_periods: [],
  }],
  act: null, act_acceptance: null, act_dispute: null,
};

describe("partner surfaces carrying a STALE_BOUND pin", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  // Explicit, and both halves are needed: these cases render the SAME
  // component, and Engagements keeps its selection in the URL
  // (history.replaceState), so without resetting it the next case starts
  // already inside the previous one's detail view.
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/partner/engagements");
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("removal claim sends the event_sequence the row was rendered with, not an empty body", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (url.includes("/conversions")) return { ok: true, status: 200, json: async () => ({ conversions: [] }) } as Response;
      if (url.includes("/engagements/e1")) return { ok: true, status: 200, json: async () => ENGAGEMENT_DETAIL } as Response;
      return { ok: true, status: 200, json: async () => ({ engagements: [ENGAGEMENT_LIST_ROW] }) } as Response;
    });

    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<Engagements />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: "Открыть" }));
    await user.click(await screen.findByRole("button", { name: "Заявить о снятии" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain("/distributions/d1/removal-claim");
    // Without expected_event_sequence this route answers 422 - the button was
    // simply broken, which is a stronger failure than an unproven retry.
    expect(posts[0].body).toEqual({ evidence_ref: "partner-portal-claim", expected_event_sequence: 9 });
  });

  it("removal claim offers a retry of the ORIGINAL pin after an ambiguous outcome", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let sequence = 9;
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        // The response is lost, and by the time the refresh lands another
        // writer has moved the distribution's event stream on.
        sequence = 11;
        return { ok: false, status: 0, json: async () => ({ error: { code: "NETWORK_AMBIGUOUS" } }) } as Response;
      }
      if (url.includes("/conversions")) return { ok: true, status: 200, json: async () => ({ conversions: [] }) } as Response;
      if (url.includes("/engagements/e1")) {
        return { ok: true, status: 200, json: async () => ({
          ...ENGAGEMENT_DETAIL,
          distributions: [{ ...ENGAGEMENT_DETAIL.distributions[0], event_sequence: sequence }],
        }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ engagements: [ENGAGEMENT_LIST_ROW] }) } as Response;
    });

    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<Engagements />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: "Открыть" }));
    await user.click(await screen.findByRole("button", { name: "Заявить о снятии" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ expected_event_sequence: 9 });

    await user.click(await screen.findByRole("button", { name: "Повторить прежнюю команду" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    // The retained snapshot, not the refreshed table's 11.
    expect(posts[1]).toMatchObject({ expected_event_sequence: 9 });
  });

  it("the INITIAL legal-profile submission exposes its retained intent, in the state an ambiguous submit actually leaves behind", async () => {
    const posts: Array<Record<string, unknown>> = [];
    // An ambiguous first submit still commits: onboarding moves to
    // PROFILE_SUBMITTED and the draft counter to 1. The PARTNER_ACTIVE
    // section is never rendered, so a notice living there is unreachable.
    let me: Record<string, unknown> = { ...ME };
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        me = { ...ME, onboarding_state: "PROFILE_SUBMITTED", legal_profile_draft_revision: 1 };
        return { ok: false, status: 0, json: async () => ({ error: { code: "NETWORK_AMBIGUOUS" } }) } as Response;
      }
      if (url.includes("/me")) return { ok: true, status: 200, json: async () => me } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<Profile />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.type(await screen.findByLabelText(/ФИО|Полное наименование/), "Ivanov Ivan Ivanovich");
    await user.type(screen.getByLabelText(/ИНН/), "123456789012");
    await user.click(screen.getByRole("button", { name: "Отправить на проверку" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ expected_draft_revision: 0 });

    // The form is still on screen (PROFILE_SUBMITTED keeps canSubmit true),
    // and the retained-intent choice is reachable from it.
    const retry = await screen.findByRole("button", { name: "Повторить прежнюю команду" });
    await user.click(retry);
    await waitFor(() => expect(posts).toHaveLength(2));
    // The retained pin, not the refreshed 1.
    expect(posts[1]).toMatchObject({ expected_draft_revision: 0 });

    // And a deliberate new submission authors against what is on screen now.
    await user.click(screen.getByRole("button", { name: "Это новое действие" }));
    await user.click(screen.getByRole("button", { name: "Отправить на проверку" }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]).toMatchObject({ expected_draft_revision: 1 });
  });
});
