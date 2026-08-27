import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { PromoCodes } from "./PromoCodes";

const promo = {
  id: "cb9ee324-a2c2-4f26-92a1-1f9abe62a007",
  code: "CERT-ONE",
  status: "ACTIVE",
  discount_type: "FIXED",
  discount_value: 1,
  agent_id: null,
};

describe("PromoCodes", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("shows every promo UUID beside its immutable code", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/promo-codes")) return { ok: true, status: 200, json: async () => ({ promo_codes: [promo] }) } as Response;
      if (url.includes("/agents")) return { ok: true, status: 200, json: async () => ({ agents: [] }) } as Response;
      throw new Error(`unhandled fetch: ${url}`);
    });

    const client = createTestQueryClient();
    render(<PromoCodes />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText(promo.code)).toBeInTheDocument());
    expect(screen.getByText(promo.id, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText(/UUID:/)).toBeInTheDocument();
  });
});
