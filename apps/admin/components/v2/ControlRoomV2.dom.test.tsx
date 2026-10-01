import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { CourseCatalogue, EntitlementsView, IntegrationView, RefundsView } from "./ControlRoomV2";

const generatedAt = "2026-09-30T10:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("Control Room v2", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("renders the typed catalogue contract without legacy row coercion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      generatedAt,
      courses: [{
        courseRef: "course/merchant-authority",
        productRef: "product/merchant-authority",
        accessModel: "PAID",
        withdrawn: false,
        withdrawnReason: null,
        withdrawnTermsRef: null,
        version: 3,
        offer: { offerRef: "offer/base", priceKopecks: 1_000_000, saleMode: "PUBLIC", acceptanceAllowlist: [] },
        projection: { version: 7, visibility: "LISTED", lastReconciledAt: generatedAt },
      }],
    }));
    global.fetch = fetchMock;

    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<CourseCatalogue />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    expect(await screen.findByText("course/merchant-authority")).toBeInTheDocument();
    expect(screen.getByText("PAID")).toBeInTheDocument();
    expect(screen.getByText("PUBLIC")).toBeInTheDocument();
    expect(screen.getByText("LISTED")).toBeInTheDocument();
    expect(screen.getByText(/10\s*000\s*₽/)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("/v1/admin/v2/catalogue", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    await user.click(screen.getByRole("button", { name: "Изменить" }));
    const price = screen.getByLabelText("Цена, коп.");
    await user.clear(price);
    await user.type(price, "1200000");
    await user.click(screen.getByRole("button", { name: "Сохранить v4" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const commandCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(commandCall?.[1]?.body))).toMatchObject({ expectedVersion: 3, priceKopecks: 1_200_000 });
    expect(JSON.parse(String(commandCall?.[1]?.body))).not.toHaveProperty("actor");
  });

  it("submits a refund decision without accepting a browser-supplied actor", async () => {
    const refund = {
      requestPublicId: "refund/request-1",
      orderPublicId: "FX-V2-1",
      reasonCode: "CUSTOMER_REQUEST",
      state: "REQUESTED",
      policyFacts: {
        schema: "flexperiment.refund-policy-facts/1",
        productKind: "ONLINE_COURSE",
        productRef: "product/course-1",
        courseRef: "course-1",
        paidLineAmountKopecks: 25_000,
        orderedAt: generatedAt,
        courseAccessStartedAt: null,
        requestedAt: generatedAt,
        automatedEligibility: "NOT_EVALUATED",
      },
      requestedAt: generatedAt,
      outcome: null,
      amountKopecks: null,
      policyBasis: null,
      rationale: null,
      decidedBy: null,
      decidedAt: null,
      executionState: null,
      providerExecutionId: null,
      supportReference: null,
      lastErrorCode: null,
    };
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/v2/refunds") && (!init?.method || init.method === "GET")) return response({ generatedAt, refunds: [refund] });
      if (url.endsWith("/v2/refunds/refund/request-1/decision") && init?.method === "POST") return response({ refund: { ...refund, state: "APPROVED" } });
      throw new Error(`unhandled fetch: ${url}`);
    });
    global.fetch = fetchMock;

    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<RefundsView />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: /FX-V2-1/ }));
    await user.type(screen.getByLabelText("Основание"), "offer/2026-09");
    await user.type(screen.getByLabelText("Мотивировка"), "Подтверждено оператором");
    await user.click(screen.getByRole("button", { name: "Зафиксировать решение" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/v1/admin/v2/refunds/refund/request-1/decision",
      expect.objectContaining({ method: "POST" }),
    ));
    const decisionCall = fetchMock.mock.calls.find(([input, init]) => input.toString().endsWith("/decision") && init?.method === "POST");
    expect(decisionCall).toBeDefined();
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({
      outcome: "APPROVE",
      amountKopecks: 25_000,
      policyBasis: "offer/2026-09",
      rationale: "Подтверждено оператором",
    });
  });

  it("submits an idempotent manual entitlement without a browser-supplied actor", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/v2/entitlements") && (!init?.method || init.method === "GET")) return response({ generatedAt, entitlements: [] });
      if (url.endsWith("/v2/customers") && (!init?.method || init.method === "GET")) return response({
        generatedAt,
        customers: [{ customerId: "customer-1", email: "student@example.com", displayName: null, authBound: true, orderCount: 0, activeEntitlementCount: 0, createdAt: generatedAt }],
      });
      if (url.endsWith("/v2/catalogue") && (!init?.method || init.method === "GET")) return response({
        generatedAt,
        courses: [{ courseRef: "course-1", productRef: "course:course-1", accessModel: "PAID", withdrawn: false,
          withdrawnReason: null, withdrawnTermsRef: null, version: 1, offer: null, projection: null }],
      });
      if (url.endsWith("/v2/entitlements/manual") && init?.method === "POST") return response({ entitlementId: "entitlement-1", orderPublicId: "FX-MANUAL-1", created: true }, 201);
      throw new Error(`unhandled fetch: ${url}`);
    });
    global.fetch = fetchMock;

    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<EntitlementsView />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.selectOptions(await screen.findByLabelText("Клиент"), "customer-1");
    await user.selectOptions(screen.getByLabelText("Курс"), "course-1");
    await user.type(screen.getByLabelText("Основание"), "Teacher access");
    await user.type(screen.getByLabelText("Ссылка на доказательство"), "ART-181/manual-1");
    await user.click(screen.getByRole("button", { name: "Выдать ручной доступ" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => input.toString().endsWith("/entitlements/manual") && init?.method === "POST")).toBe(true));
    const commandCall = fetchMock.mock.calls.find(([input, init]) => input.toString().endsWith("/entitlements/manual") && init?.method === "POST");
    expect(JSON.parse(String(commandCall?.[1]?.body))).toMatchObject({
      customerId: "customer-1",
      scope: "COURSE",
      courseRef: "course-1",
      reason: "Teacher access",
      evidenceRef: "ART-181/manual-1",
      legalTermsRef: "manual-access-v1",
      idempotencyKey: expect.any(String),
    });
    expect(JSON.parse(String(commandCall?.[1]?.body))).not.toHaveProperty("actor");
  });

  it("shows a terminal read error instead of an endless loading state", async () => {
    global.fetch = vi.fn().mockResolvedValue(response({ error: { code: "CONTROL_ROOM_FORBIDDEN" } }, 403));
    const client = createTestQueryClient();
    render(<CourseCatalogue />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    expect(await screen.findByText("CONTROL_ROOM_FORBIDDEN")).toBeInTheDocument();
    expect(screen.queryByText("Загрузка…")).not.toBeInTheDocument();
  });

  it("shows abnormal playback access counters in integration operations", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => input.toString().endsWith("/integration")
      ? response({
        paymentMode: "disabled", lastAcceptedPayment: null, outstandingCheckoutCount: 0, processingRefundCount: 0,
        attentionOverrideCount: 0, staleProjectionCount: 0,
        playbackAccess24h: { allowed: 12, denied: 3, rateLimited: 1, invalidToken: 2 },
      })
      : response({ generatedAt, items: [] }));
    const client = createTestQueryClient();
    render(<IntegrationView />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    expect(await screen.findByText("Playback / 24 часа")).toBeInTheDocument();
    expect(screen.getByText("Отказано").parentElement).toHaveTextContent("3");
    expect(screen.getByText("Rate limited").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Invalid token").parentElement).toHaveTextContent("2");
  });
});
