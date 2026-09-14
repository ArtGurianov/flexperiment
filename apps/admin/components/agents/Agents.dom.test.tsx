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

  it("sends an operational-only create command", async () => {
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
    await user.type(screen.getByLabelText("Email"), "agent@example.test");
    const percent = screen.getByDisplayValue("0,00");
    await user.clear(percent);
    await user.type(percent, "10");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ method: "POST" });
    expect(Object.keys(requests[0].body).sort()).toEqual(["default_reward_type", "default_reward_value", "display_name", "email", "enabled", "slug"]);
    for (const field of ["contractor_type", "inn", "legal_name", "npd_status_checked_at", "percent", "fixedRubles"]) expect(requests[0].body).not.toHaveProperty(field);
  });

  it("renders the legal profile read-only and patches only operational fields", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const agent = {
      id: "agent-2", slug: "org-agent", display_name: "Org Agent", email: "org@example.test",
      enabled: 1, default_reward_type: "PERCENT", default_reward_value: 1000, created_at: "old", updated_at: "new", promo_count: 0,
      legal_profile: { revision: 2, projected_contractor_type: "ORGANIZATION", opf: "ООО" },
    };
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/agents") && (!init?.method || init.method === "GET")) return { ok: true, status: 200, json: async () => ({ agents: [agent] }) } as Response;
      requests.push({ method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200, json: async () => ({ ...agent }) } as Response;
    });
    const user = userEvent.setup(); const client = createTestQueryClient();
    render(<Agents />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    expect(await screen.findByText("Юридическое лицо · ООО")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Редактировать" }));
    const dialog = screen.getByRole("dialog", { name: "Редактировать агента" });
    expect(within(dialog).queryByLabelText("Тип исполнителя")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Юридическое имя")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("ИНН")).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Email"));
    await user.type(within(dialog).getByLabelText("Email"), "moved@example.test");
    await user.click(within(dialog).getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ method: "PATCH" });
    expect(Object.keys(requests[0].body).sort()).toEqual(["default_reward_type", "default_reward_value", "display_name", "email", "enabled"]);
    for (const field of ["contractor_type", "inn", "legal_name", "npd_status_checked_at", "slug"]) expect(requests[0].body).not.toHaveProperty(field);
    expect(requests[0].body.email).toBe("moved@example.test");
  });
});
