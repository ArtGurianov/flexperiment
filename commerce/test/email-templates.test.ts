import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "../src/email-templates";

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
    expect(update.plaintext).toContain("полный возврат");
    expect(full.plaintext).toContain("аннулированы");
    expect(partial.plaintext).toContain("остаются действительными");
  });
});
