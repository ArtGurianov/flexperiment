import { describe, expect, it } from "vitest";
import { DESTINATION_RESPONSE_MAX_LENGTH, deliveryEvidence, sanitizeDeliveryStatus, sanitizeDestinationResponse, sanitizeProviderEventTime, sanitizeSenderIp, webhookDeliveryEvidence } from "../src/email-delivery-evidence";

describe("a receiver's answer, kept without the recipient", () => {
  it("keeps the SMTP code and reason and removes the address", () => {
    expect(sanitizeDestinationResponse("452 4.2.2 <someone@proton.me>: Mailbox full"))
      .toBe("452 4.2.2 <address>: Mailbox full");
    expect(sanitizeDestinationResponse("550 5.1.1 someone@example.invalid does not exist"))
      .toBe("550 5.1.1 <address> does not exist");
  });

  it("removes URLs, long opaque tokens and control characters", () => {
    const response = "421 4.7.0 Try again later, see https://support.example.invalid/x?u=someone@x.invalid\r\nid=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const sanitized = sanitizeDestinationResponse(response)!;
    expect(sanitized).toBe("421 4.7.0 Try again later, see <url> id=<token>");
    expect(sanitized).not.toMatch(/someone|https|\r|\n/);
  });

  it("removes quoted, bracketed, spaced and encoded address forms", () => {
    const cases: [string, string][] = [
      ['550 5.1.1 "john doe"@example.invalid unknown', "550 5.1.1 <address> unknown"],
      ["550 5.1.1 <john.doe+tag@sub.example.invalid>: unknown", "550 5.1.1 <address>: unknown"],
      ["550 john @ example.invalid unknown", "550 <address> unknown"],
      ["550 john%40example.invalid unknown", "550 <address> unknown"],
      ["550 john(at)example.invalid / john [at] example.invalid", "550 <address> / <address>"],
      ["550 @@", "550 <address><address>"],
    ];
    for (const [raw, expected] of cases) expect(sanitizeDestinationResponse(raw)).toBe(expected);
    for (const [raw] of cases) expect(sanitizeDestinationResponse(raw)).not.toMatch(/@|john|%40/i);
  });

  it("flattens every control, format and separator character", () => {
    const raw = "451\u0000 4.7.1\tTry\u0085again\u2028later\u202Egnissim\u200B!\u001b[31m";
    const sanitized = sanitizeDestinationResponse(raw)!;
    expect(sanitized).toBe("451 4.7.1 Try again later gnissim ! [31m");
    expect(sanitized).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it("caps the length, and says nothing rather than an empty string", () => {
    expect(sanitizeDestinationResponse(`451 ${"x ".repeat(400)}`)).toHaveLength(DESTINATION_RESPONSE_MAX_LENGTH);
    const astral = sanitizeDestinationResponse(`451 ${"😀".repeat(400)}`)!;
    expect(Array.from(astral)).toHaveLength(DESTINATION_RESPONSE_MAX_LENGTH);
    expect(astral).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(sanitizeDestinationResponse(" \r\n ")).toBeNull();
    expect(sanitizeDestinationResponse(451)).toBeNull();
  });

  it("accepts only Unisender's own status words, a real IP, and a provider timestamp", () => {
    expect(sanitizeDeliveryStatus("err_will_retry")).toBe("err_will_retry");
    expect(sanitizeDeliveryStatus("err_will_retry someone@x.invalid")).toBeNull();
    expect(sanitizeSenderIp("192.0.2.10")).toBe("192.0.2.10");
    expect(sanitizeSenderIp("192.0.2.10; drop")).toBeNull();
    expect(sanitizeProviderEventTime("2026-09-24 06:51:59")).toBe("2026-09-24T06:51:59Z");
    expect(sanitizeProviderEventTime("yesterday")).toBeNull();
    expect(deliveryEvidence({})).toEqual({ deliveryStatus: null, destinationResponse: null, senderIp: null, eventTime: null });
  });

  it("reads only the named delivery_info fields from a webhook, never the recipient's data", () => {
    const evidence = webhookDeliveryEvidence({
      email: "someone@proton.me",
      status: "soft_bounced",
      event_time: "2026-09-24 06:51:59",
      delivery_info: {
        delivery_status: "err_mailbox_full", destination_response: "452 4.2.2 Mailbox full", sender_ip: "192.0.2.10",
        ip: "203.0.113.7", user_agent: "Mozilla/5.0", city: "Berlin", country: "Germany",
      },
    });
    expect(evidence).toEqual({ deliveryStatus: "err_mailbox_full", destinationResponse: "452 4.2.2 Mailbox full", senderIp: "192.0.2.10", eventTime: "2026-09-24T06:51:59Z" });
    expect(JSON.stringify(evidence)).not.toMatch(/proton|203\.0\.113|Mozilla|Berlin/);
    expect(webhookDeliveryEvidence({ status: "sent", delivery_info: "not an object" })).toEqual({ deliveryStatus: null, destinationResponse: null, senderIp: null, eventTime: null });
  });
});
