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
});
