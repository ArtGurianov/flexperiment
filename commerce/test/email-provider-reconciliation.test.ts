import { describe, expect, it } from "vitest";
import { normalizeUnisenderReconciliationEvent } from "../src/email-provider-reconciliation";

describe("Unisender reconciliation normalization", () => {
  it.each([
    ["accepted", "ACCEPTED"], ["sent", "SENT"], ["delivered", "DELIVERED"],
    ["soft_bounced", "BOUNCED"], ["hard_bounced", "BOUNCED"], ["spam", "BOUNCED"],
  ] as const)("normalizes %s into the canonical delivery state %s", (providerStatus, status) => {
    expect(normalizeUnisenderReconciliationEvent({ outboxId: "outbox", providerStatus, jobId: "job", semanticKey: "event", source: "WEBHOOK" }))
      .toEqual({ outboxId: "outbox", providerStatus, status, jobId: "job", semanticKey: "event", source: "WEBHOOK" });
  });

  it("rejects data which cannot be delivery evidence", () => {
    expect(normalizeUnisenderReconciliationEvent({ outboxId: "outbox", providerStatus: "queued", semanticKey: "event", source: "WEBHOOK" })).toBeUndefined();
    expect(normalizeUnisenderReconciliationEvent({ outboxId: 1, providerStatus: "sent", semanticKey: "event", source: "WEBHOOK" })).toBeUndefined();
  });
});
