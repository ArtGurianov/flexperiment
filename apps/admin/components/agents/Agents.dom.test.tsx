import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Agents } from "./Agents";

describe("Agents", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("explains the enabled control and its attribution effect", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/agents")) return { ok: true, status: 200, json: async () => ({ agents: [] }) } as Response;
      throw new Error(`unhandled fetch: ${input}`);
    });

    const client = createTestQueryClient();
    render(<Agents />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    const enabled = await screen.findByRole("checkbox", { name: /Агент активен/ });
    expect(enabled).toBeChecked();
    expect(screen.getByText(/не получает новые attribution через промокоды и referral links/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Добавить агента")).toBeInTheDocument());
  });
});
