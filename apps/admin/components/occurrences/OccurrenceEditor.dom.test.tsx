import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { OccurrenceEditor } from "./OccurrenceEditor";

const confirmedOccurrence = {
  id: "occ-1", title: "Мастер-класс", starts_at: "2026-10-01T10:00:00.000Z", ends_at: "2026-10-01T12:00:00.000Z",
  timezone: "Asia/Novosibirsk", price_kopecks: 100000, availability: 5, capacity: 5, sold: 0, held: 0, reconciling: 0, admin_reserved_seats: 0, venue_status: "CONFIRMED",
  venue_name: "Студия", venue_address: "Ленина, 1", venue_disclosure_text: null, venue_announce_by: null, admin_revision: 1,
};

describe("OccurrenceEditor", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("saves a price edit for a confirmed venue without parsing its unregistered announcement lead", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => confirmedOccurrence } as Response);
    global.fetch = fetch;
    const done = vi.fn();
    const user = userEvent.setup();
    const client = createTestQueryClient();

    render(<OccurrenceEditor occurrence={confirmedOccurrence} close={vi.fn()} done={done} onRevisionConflict={vi.fn()} />, {
      wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper>,
    });

    const price = screen.getByPlaceholderText("0,00");
    await user.clear(price);
    await user.type(price, "101");
    await user.click(screen.getByRole("button", { name: "Сохранить изменения" }));

    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/v1/admin/occurrences/occ-1", expect.objectContaining({ method: "PATCH" }));
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ price_kopecks: 10100, venue_status: "CONFIRMED", inventory: { capacity: 5, admin_reserved_seats: 0 } });
  });

  it("uses target values for steppers and renders the authoritative inventory error details", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: "RESERVE_EXCEEDS_AVAILABLE_CAPACITY", details: { minimum_capacity: 15, breakdown: { sold: 9, held: 2, reconciling: 1, admin_reserved: 3 } } } }) } as Response);
    global.fetch = fetch;
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<OccurrenceEditor occurrence={{ ...confirmedOccurrence, sold: 9, held: 2, reconciling: 1, admin_reserved_seats: 3, availability: -10 }} close={vi.fn()} done={vi.fn()} onRevisionConflict={vi.fn()} />, {
      wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper>,
    });

    await user.click(screen.getByRole("button", { name: "Увеличить вместимость" }));
    expect(screen.getByLabelText("Вместимость")).toHaveValue(6);
    await user.click(screen.getByRole("button", { name: "Сохранить изменения" }));

    await waitFor(() => expect(screen.getByText(/Серверный минимум: 15/)).toBeInTheDocument());
    expect(screen.getByText(/Серверный минимум: 15/).textContent).toContain("9 оплачено + 2 в оплате + 1 на сверке + 3 резерв");
  });
});
