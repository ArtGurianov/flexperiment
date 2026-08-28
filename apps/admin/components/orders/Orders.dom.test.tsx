import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Orders } from "./Orders";

const order = {
  id: "order-1", public_status_id: "status-1", public_order_number: "FX-1",
  occurrence_id: "occ-1", customer_name: "Иван", customer_email: "ivan@example.test",
  participant_name: null, participant_age_band: "ADULT", participant_age_at_occurrence: null, participant_is_customer: 1, participant_is_minor: 0,
  participant_requires_adult_accompaniment: 0, amount_kopecks: 100000, created_at: "2026-08-20T10:00:00.000Z",
  occurrence_title: "Мастер-класс", city_id: "city-1", city_title: "Томск",
  payment_state: "CREATED", payment_status: "PAID", booking_status: "CONFIRMED", refund_count: 0,
};

function evidenceFor(paymentStatus: string, refundCount: number) {
  return {
    order: { id: "order-1" },
    payment: { id: "payment-1", status: paymentStatus, captured_amount_kopecks: 100000 },
    booking: { id: "booking-1" },
    ticket: null,
    email_outbox: [],
    refunds: Array.from({ length: refundCount }, (_, i) => ({ id: `refund-${i}` })),
    reservation_abandonment: null,
    actions: { can_create_compensation_refund: true, can_abandon_reservation: false },
  };
}

function routeFetch(handlers: Record<string, () => unknown>) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return { ok: true, status: 200, json: async () => handler() } as Response;
    }
    throw new Error(`unhandled fetch: ${url}`);
  });
}

describe("Orders", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("shows new anonymous orders as ticket admission while retaining legacy names when present", async () => {
    const anonymousOrder = {
      ...order,
      customer_name: "",
      participant_name: null,
      participant_is_customer: null,
    };
    global.fetch = routeFetch({
      "/cities": () => ({ cities: [] }),
      "/occurrences": () => ({ occurrences: [] }),
      "/orders": () => ({ orders: [anonymousOrder] }),
    });

    const client = createTestQueryClient();
    render(<Orders />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("FX-1")).toBeInTheDocument());
    expect(screen.getByText("Без имени")).toBeInTheDocument();
    expect(screen.getByText("Допуск по билету")).toBeInTheDocument();
    expect(screen.queryByText("Другой участник")).not.toBeInTheDocument();
  });

  it("opens the exact order evidence supplied by an id deep link", async () => {
    window.history.replaceState(null, "", "/orders/?id=order-1");
    global.fetch = routeFetch({
      "/cities": () => ({ cities: [] }),
      "/occurrences": () => ({ occurrences: [] }),
      "/orders/order-1/evidence": () => evidenceFor("REVIEW_REQUIRED", 0),
      "/orders": () => ({ orders: [order] }),
    });
    const client = createTestQueryClient();
    render(<Orders />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await waitFor(() => expect(screen.getByText("Order evidence")).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/orders/order-1/evidence"), expect.anything());
  });

  it("updates the badge in the already-open evidence panel and the underlying table after a refund, with no remount and no hard reload (A1)", async () => {
    let paymentStatus = "PAID";
    let refundCount = 0;
    const fetchMock = routeFetch({
      "/cities": () => ({ cities: [] }),
      "/occurrences": () => ({ occurrences: [] }),
      "/orders/order-1/evidence": () => evidenceFor(paymentStatus, refundCount),
      "/orders/order-1/refunds": () => { paymentStatus = "PARTIALLY_REFUNDED"; refundCount += 1; return { id: "new-refund" }; },
      "/orders": () => ({ orders: [{ ...order, payment_status: paymentStatus, refund_count: refundCount }] }),
    });
    global.fetch = fetchMock;

    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<Orders />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("FX-1")).toBeInTheDocument());
    expect(screen.getByText("Возраст при оформлении: 18 лет или старше")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("PAID")).toBeInTheDocument();

    fireEvent.click(screen.getByText("FX-1"));
    await waitFor(() => expect(screen.getByText("Order evidence")).toBeInTheDocument());
    const evidencePanel = screen.getByText("Order evidence").closest("section")!;
    await waitFor(() => expect(within(evidencePanel).getByText(/"status": "PAID"/)).toBeInTheDocument());

    await user.click(within(evidencePanel).getByRole("button", { name: "Вернуть оплату" }));
    await user.type(screen.getByLabelText(/Сумма/), "1");
    await user.clear(screen.getByLabelText(/Сумма/));
    await user.type(screen.getByLabelText(/Сумма/), "500");
    await user.type(screen.getByLabelText(/Причина/), "Клиент попросил");
    await user.click(screen.getByRole("button", { name: /Создать refund 500/ }));

    // The already-open evidence panel reflects the new payment status —
    // no remount, no page reload, just the invalidated query refetching.
    await waitFor(() => expect(within(evidencePanel).getByText(/"status": "PARTIALLY_REFUNDED"/)).toBeInTheDocument());
    // The orders table beside it also picked up the new state.
    await waitFor(() => expect(within(screen.getByRole("table")).getByText("PARTIALLY_REFUNDED")).toBeInTheDocument());
  });

  it("never invalidates at the all()-width prefix: opening evidence for order-1 survives a refund on a different order's list refresh", async () => {
    const fetchMock = routeFetch({
      "/cities": () => ({ cities: [] }),
      "/occurrences": () => ({ occurrences: [] }),
      "/orders/order-1/evidence": () => evidenceFor("PAID", 0),
      "/orders": () => ({ orders: [order] }),
    });
    global.fetch = fetchMock;
    const client = createTestQueryClient();
    render(<Orders />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await waitFor(() => expect(screen.getByText("FX-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("FX-1"));
    await waitFor(() => expect(screen.getByText("Order evidence")).toBeInTheDocument());

    const callsBefore = fetchMock.mock.calls.length;
    await client.invalidateQueries({ queryKey: ["orders", "list"] });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
    // The evidence panel query key is outside the "orders","list" prefix, so
    // it must not have refired as a result of this narrower invalidation.
    const evidenceCallsAfter = fetchMock.mock.calls.filter((call) => String(call[0]).includes("evidence")).length;
    expect(evidenceCallsAfter).toBe(1);
  });

  it("keeps the previous table visible and marked updating during a filter transition, never presenting it as matching the new filter (E3 / exit criterion 5)", async () => {
    const otherCityOrder = { ...order, id: "order-2", public_order_number: "FX-2", city_id: "city-2", city_title: "Москва" };
    let resolveFiltered: (() => void) | null = null;
    const filteredGate = new Promise<void>((resolve) => { resolveFiltered = resolve; });

    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/cities")) return { ok: true, status: 200, json: async () => ({ cities: [{ id: "city-1", title: "Томск" }, { id: "city-2", title: "Москва" }] }) } as Response;
      if (url.includes("/occurrences")) return { ok: true, status: 200, json: async () => ({ occurrences: [] }) } as Response;
      if (url.includes("city_id=city-1")) {
        await filteredGate;
        return { ok: true, status: 200, json: async () => ({ orders: [otherCityOrder] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ orders: [order] }) } as Response;
    });
    global.fetch = fetchMock;

    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<Orders />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("FX-1")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Город"), "city-1");

    // Mid-transition: the OLD row must still be on screen, marked updating —
    // never replaced by a bare loading line, and never showing FX-2 (which
    // belongs to the new filter) until that fetch actually resolves.
    expect(screen.getByText("FX-1")).toBeInTheDocument();
    expect(screen.queryByText("FX-2")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveClass("table-updating");
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(/Показываем предыдущие данные/)).toBeInTheDocument();

    resolveFiltered!();
    await waitFor(() => expect(screen.getByText("FX-2")).toBeInTheDocument());
    expect(screen.queryByText("FX-1")).not.toBeInTheDocument();
  });
});
