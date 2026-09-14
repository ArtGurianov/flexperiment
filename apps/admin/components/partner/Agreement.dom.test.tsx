import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Agreement } from "./Agreement";

const clauses = { clauses: [] };
const currentProfile = {
  revision: 8, legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "OTHER", opf: null,
  full_name: "Ivanov Ivan Petrovich", short_name: null, inn: "123456789012", kpp: null,
  registration_number: "123456789012345", legal_address: null, created_at: "2026-03-01T00:00:00.000Z",
  projected_contractor_type: "INDIVIDUAL_ENTREPRENEUR",
};

const reacceptanceAgreement = {
  issued: true, agreement_status: "REACCEPTANCE_REQUIRED", issuance_id: "issuance-B", issuance_sequence: 2,
  issued_at: "2026-03-02T00:00:00.000Z", current_legal_profile_revision_id: "profile-8",
  framework_agreement: { revision: 2, content_hash: "framework-B", content: clauses },
  delegation_template: { revision: 2, content_hash: "delegation-B", content: clauses },
  effective_acceptance: {
    framework_acceptance_id: "acceptance-A", issuance_id: "issuance-A", issuance_sequence: 1,
    accepted_at: "2026-02-01T00:00:00.000Z", legal_profile_revision_id: "profile-7",
    legal_profile: { ...currentProfile, revision: 7, full_name: "Ivanov Ivan Ivanovich" },
  },
  required_issuance_accepted: false,
  delegation_revoked: false,
};

describe("Agreement reacceptance", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("renders required B and sends the exact B/profile-8 pair through step-up and accept, never historical A", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ url, body });
        if (url.includes("/step-up")) return { ok: true, status: 200, json: async () => ({ grant_id: "grant-B" }) } as Response;
        if (url.includes("/framework/accept")) return { ok: true, status: 200, json: async () => ({ framework_acceptance_id: "acceptance-B" }) } as Response;
        throw new Error(`unhandled POST: ${url}`);
      }
      // The successful mutation invalidates partner agreement/profile queries;
      // serve their authoritative refetches without weakening POST assertions.
      if (url.includes("/agreements")) return { ok: true, status: 200, json: async () => reacceptanceAgreement } as Response;
      if (url.includes("/me")) return { ok: true, status: 200, json: async () => ({ legal_profile: currentProfile }) } as Response;
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<Agreement />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    expect(await screen.findByText("Выдана новая редакция - требуется повторное принятие.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Принять договор и делегирование" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Договор принят" })).not.toBeInTheDocument();
    expect(screen.getByText("Ivanov Ivan Petrovich")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Принять договор и делегирование" }));
    expect(await screen.findByText(/юридического профиля ред\. 8/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Подтвердить" }));

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts).toEqual([
      {
        url: "/v1/partner/step-up",
        body: {
          action: "FRAMEWORK_ACCEPTANCE",
          resource: { issuance_id: "issuance-B", legal_profile_revision_id: "profile-8" },
        },
      },
      {
        url: "/v1/partner/framework/accept",
        body: {
          step_up_grant_id: "grant-B",
          issuance_id: "issuance-B",
          legal_profile_revision_id: "profile-8",
        },
      },
    ]);
    const sent = JSON.stringify(posts);
    expect(sent).not.toContain("issuance-A");
    expect(sent).not.toContain("profile-7");
  });
});
