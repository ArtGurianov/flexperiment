import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Occurrences } from "./Occurrences";

const scheduledOccurrence = {
  id: "occ-1", title: "Мастер-класс", starts_at: "2026-10-01T10:00:00.000Z", price_kopecks: 100000,
  availability: 5, capacity: 5, visibility: "PUBLISHED", sales_status: "CLOSED", fulfillment_status: "SCHEDULED",
  city_title: "Томск", city_slug: "tomsk", admin_revision: 1,
};

function routeFetch(handlers: Record<string, () => unknown>) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return { ok: true, status: 200, json: async () => handler() } as Response;
    }
    throw new Error(`unhandled fetch: ${url}`);
  });
}

describe("Occurrences", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("shows the occurrence as CANCELLED and its financials become available after occurrence.cancel invalidates the list and cancellationFinancials (A2, part a)", async () => {
    let cancelled = false;
    global.fetch = routeFetch({
      "/cities": () => ({ cities: [] }),
      "/reauth": () => ({ capability: "cap-1", expires_at: "2026-01-01T00:00:00.000Z" }),
      "/occurrences/occ-1/cancel": () => { cancelled = true; return { ...scheduledOccurrence, fulfillment_status: "CANCELLED" }; },
      "/occurrences/occ-1/cancellation-financial-overview": () => ({ captured_kopecks: 100000, refund_target_kopecks: 100000, refund_succeeded_kopecks: 0, refund_outstanding_kopecks: 100000, refund_needs_attention_kopecks: 0, refund_needs_attention_count: 0 }),
      "/occurrences": () => ({ occurrences: [{ ...scheduledOccurrence, fulfillment_status: cancelled ? "CANCELLED" : "SCHEDULED" }] }),
    });

    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<Occurrences />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await waitFor(() => expect(screen.getByText("Мастер-класс")).toBeInTheDocument());
    expect(screen.getByText("SCHEDULED")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Отменить событие" }));
    await user.type(screen.getByLabelText("Причина"), "Форс-мажор");
    await user.type(screen.getByLabelText("Текущий пароль администратора"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Подтвердить отмену" }));

    await waitFor(() => expect(screen.getByText("CANCELLED")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Показать финансы" }));
    await waitFor(() => expect(screen.getByText(/К возврату/)).toBeInTheDocument());
  });

  it("keeps polling the cancellation-financials of the same mounted occurrence unaided every 15s, with no user action (A2, part b)", async () => {
    vi.useFakeTimers();
    let outstanding = 100000;
    global.fetch = routeFetch({
      "/cities": () => ({ cities: [] }),
      "/occurrences/occ-1/cancellation-financial-overview": () => ({ captured_kopecks: 100000, refund_target_kopecks: 100000, refund_succeeded_kopecks: 100000 - outstanding, refund_outstanding_kopecks: outstanding, refund_needs_attention_kopecks: 0, refund_needs_attention_count: 0 }),
      "/occurrences": () => ({ occurrences: [{ ...scheduledOccurrence, fulfillment_status: "CANCELLED" }] }),
    });

    const client = createTestQueryClient();
    render(<Occurrences />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await vi.waitFor(() => expect(screen.getByText("Мастер-класс")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Показать финансы" }));
    await vi.waitFor(() => expect(screen.getByText(/В обработке.*1 000,00/)).toBeInTheDocument());

    // The worker progresses the refund server-side; the mounted panel must
    // pick this up on its own via the 15s poll, with no click.
    outstanding = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(screen.getByText(/В обработке.*0,00/)).toBeInTheDocument());

    vi.useRealTimers();
  });
});
