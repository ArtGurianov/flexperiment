import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Cities } from "./Cities";

describe("Cities idempotency", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("replays a create with the same key after NETWORK_AMBIGUOUS", async () => {
    const receivedKeys: string[] = [];
    let attempts = 0;
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/cities") && init?.method === "POST") {
        receivedKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
        attempts += 1;
        if (attempts === 1) throw new TypeError("connection closed");
        return { ok: true, status: 201, json: async () => ({ id: "city-1" }) } as Response;
      }
      if (url.includes("/cities")) return { ok: true, status: 200, json: async () => ({ cities: [] }) } as Response;
      throw new Error(`unhandled fetch: ${url}`);
    });

    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<Cities />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await waitFor(() => expect(screen.getByRole("option", { name: "Москва" })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Город"), "moscow");
    await user.type(screen.getByLabelText(/Причина/), "Новый город");
    await user.click(screen.getByRole("button", { name: "Создать город" }));
    await waitFor(() => expect(screen.getByText(/NETWORK_AMBIGUOUS/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Создать город" }));

    await waitFor(() => expect(receivedKeys).toHaveLength(2));
    expect(receivedKeys[0]).toBeTruthy();
    expect(receivedKeys[1]).toBe(receivedKeys[0]);
  });
});
