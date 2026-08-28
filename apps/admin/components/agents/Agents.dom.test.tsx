import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("sends only the strict agent create DTO, never the form-only values", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/agents") && (!init?.method || init.method === "GET")) return { ok: true, status: 200, json: async () => ({ agents: [] }) } as Response;
      requests.push({ method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 201, json: async () => ({}) } as Response;
    });
    const user = userEvent.setup(); const client = createTestQueryClient();
    render(<Agents />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await screen.findByText("Добавить агента");
    await user.type(screen.getByLabelText("Slug"), "agent-one");
    await user.type(screen.getByLabelText("Отображаемое имя"), "Agent One");
    await user.type(screen.getByLabelText("Юридическое имя"), "Agent One LLC");
    await user.type(screen.getByLabelText("Email"), "agent@example.test");
    await user.type(screen.getByLabelText("ИНН"), "1234567890");
    await user.type(screen.getByLabelText("Договор"), "Contract 1");
    const percent = screen.getByDisplayValue("0,00");
    await user.clear(percent);
    await user.type(percent, "10");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ method: "POST" });
    expect(Object.keys(requests[0].body).sort()).toEqual(["contract_reference", "contractor_type", "default_reward_type", "default_reward_value", "display_name", "email", "enabled", "inn", "legal_name", "slug"]);
    expect(requests[0].body).not.toHaveProperty("percent");
    expect(requests[0].body).not.toHaveProperty("fixedRubles");
  });

  it("sends only mutable command fields when editing a read-model agent", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const agent = { id: "agent-1", slug: "agent-one", display_name: "Agent One", legal_name: "Agent One LLC", email: "agent@example.test", contractor_type: "SELF_EMPLOYED", inn: "1234567890", contract_reference: "Contract 1", enabled: 1, default_reward_type: "PERCENT", default_reward_value: 1000, created_at: "old", updated_at: "new", promo_count: 3 };
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/agents") && (!init?.method || init.method === "GET")) return { ok: true, status: 200, json: async () => ({ agents: [agent] }) } as Response;
      requests.push({ method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200, json: async () => ({ ...agent }) } as Response;
    });
    const user = userEvent.setup(); const client = createTestQueryClient();
    render(<Agents />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await user.click(await screen.findByRole("button", { name: "Редактировать" }));
    const dialog = screen.getByRole("dialog", { name: "Редактировать агента" });
    await user.clear(within(dialog).getByLabelText("Отображаемое имя"));
    await user.type(within(dialog).getByLabelText("Отображаемое имя"), "Updated agent");
    await user.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ method: "PATCH" });
    expect(Object.keys(requests[0].body).sort()).toEqual(["contract_reference", "contractor_type", "default_reward_type", "default_reward_value", "display_name", "email", "enabled", "inn", "legal_name"]);
    for (const field of ["percent", "fixedRubles", "id", "created_at", "updated_at", "promo_count", "slug"]) expect(requests[0].body).not.toHaveProperty(field);
  });
});
