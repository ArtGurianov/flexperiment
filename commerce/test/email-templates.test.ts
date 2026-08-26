import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "../src/email-templates";
import { readFileSync } from "node:fs";

describe("refund email wording", () => {
  it("distinguishes an initiated refund from a provider-succeeded refund", () => {
    const occurrence = renderEmailTemplate("occurrence-cancelled", {});
    const customer = renderEmailTemplate("customer-refund-confirmed", {});
    const succeeded = renderEmailTemplate("refund-succeeded", {});
    expect(occurrence.plaintext).toContain("инициирован");
    expect(customer.plaintext).toContain("передан в обработку");
    expect(occurrence.plaintext).not.toContain("Возврат выполнен");
    expect(customer.plaintext).not.toContain("Возврат выполнен");
    expect(succeeded.plaintext).toContain("Возврат выполнен");
  });

  it("keeps post-purchase notices grounded in their immutable payload snapshots", () => {
    const ticket = renderEmailTemplate("ticket", {
      ticket_url: "https://example.test/ticket#capability",
      city_title: "Новосибирск",
      customer_name: "Заказчик",
      participant_name: "Участник",
      participant_requires_adult_accompaniment: true,
      occurrence: { title: "FLEXPERIMENT", starts_at: "2030-01-01T10:00:00Z", timezone: "Asia/Novosibirsk", venue_status: "CONFIRMED", venue_name: "Studio", venue_address: "Lenina 1" },
    });
    const update = renderEmailTemplate("occurrence-updated", {
      before: { title: "FLEXPERIMENT", starts_at: "2030-01-01T10:00:00Z" },
      after: { title: "FLEXPERIMENT", starts_at: "2030-01-02T10:00:00Z", timezone: "Asia/Novosibirsk", venue_status: "TO_BE_ANNOUNCED", venue_disclosure_text: "Venue later" },
      material_changes: [{ field: "starts_at" }], organizer_change_full_refund_available: true,
    });
    const full = renderEmailTemplate("refund-succeeded", { fulfillment_outcome: "FULL" });
    const partial = renderEmailTemplate("refund-succeeded", { fulfillment_outcome: "PARTIAL" });
    expect(ticket.plaintext).toContain("Оплата подтверждена");
    expect(ticket.plaintext).not.toContain("Заказчик:");
    expect(ticket.plaintext).not.toContain("Участник:");
    expect(ticket.plaintext).toContain("на момент оформления заказа не исполнилось 14 лет");
    expect(update.plaintext).toContain("полный возврат");
    expect(full.plaintext).toContain("аннулированы");
    expect(partial.plaintext).toContain("остаются действительными");
  });

  it("uses order-time age-band wording consistently in the new checkout UI and ticket email", () => {
    const checkoutUi = readFileSync("components/CheckoutFlow.tsx", "utf8");
    const ticket = renderEmailTemplate("ticket", { participant_requires_adult_accompaniment: true });
    expect(checkoutUi).toContain("Возрастная категория участника");
    expect(checkoutUi).toContain("на момент оформления заказа не исполнилось 14 лет");
    expect(checkoutUi).not.toContain("оформления билета");
    expect(ticket.plaintext).toContain("на момент оформления заказа не исполнилось 14 лет");
    expect(ticket.html).toContain("на момент оформления заказа не исполнилось 14 лет");
    expect(ticket.plaintext).not.toContain("оформления билета");
  });

  it("waits for explicit event selection before requesting a checkout quote", () => {
    const checkoutUi = readFileSync("components/CheckoutFlow.tsx", "utf8");
    expect(checkoutUi).toContain('setOccurrences(available); setOccurrenceId("")');
    expect(checkoutUi).not.toContain("const initial = available.find(canRequestCheckout)");
    expect(checkoutUi).toContain("quote?.venue_disclosure ?? publicVenueDisclosure(selected)");
  });

  it("renders human-readable field changes and the complete current occurrence state", () => {
    const update = renderEmailTemplate("occurrence-updated", {
      before: {
        title: "FLEXPERIMENT", starts_at: "2030-01-01T10:00:00Z", ends_at: "2030-01-01T13:00:00Z", timezone: "Asia/Novosibirsk",
        venue_status: "CONFIRMED", venue_name: "Studio A", venue_address: "Lenina 1",
      },
      after: {
        title: "FLEXPERIMENT — расширенная программа", starts_at: "2030-01-01T10:00:00Z", ends_at: "2030-01-01T14:30:00Z", timezone: "Asia/Novosibirsk",
        venue_status: "TO_BE_ANNOUNCED", venue_disclosure_text: "Сообщим площадку дополнительно", venue_announce_by: "2029-12-20T10:00:00Z",
      },
      material_changes: [{ field: "title" }, { field: "ends_at" }, { field: "venue_status" }, { field: "venue_announce_by" }],
    });
    expect(update.plaintext).toContain("Время окончания");
    expect(update.plaintext).toContain("Площадка");
    expect(update.plaintext).toContain("Studio A, Lenina 1");
    expect(update.plaintext).toContain("Актуальные данные мастер-класса");
    expect(update.plaintext).not.toContain("OCCURRENCE_END_CHANGED");
    expect(update.plaintext).not.toContain("2030-01-01T10:00:00Z");
  });
});
