import { describe, expect, it } from "vitest";
import {
  emailEvidence, manifestDefect, occurrenceIdentityDefect, orderIdentityDefect, refundConvergenceDefect, refundPollAction,
  type OrderEvidence,
  emailTimeoutDiagnosis,
} from "../../src/certification/evidence";

const scope = { citySlug: "kemerovo", title: "FLEXPERIMENT — production E2E run", timezone: "Asia/Novokuznetsk", priceKopecks: 100, capacity: 1 };
const occurrence = { id: "occ", city_slug: "kemerovo", title: scope.title, timezone: "Asia/Novokuznetsk", price_kopecks: 100, capacity: 1 };
const identifiers = { orderId: "order", statusId: "status", occurrenceId: "occ", paymentId: "pay", bookingId: "booking", ticketId: "ticket", amountKopecks: 100 };
const refundIds = { paymentId: "pay", obligationId: "obligation", refundId: "refund", amountKopecks: 100 };

const evidence: OrderEvidence = {
  order: { id: "order", public_status_id: "status", occurrence_id: "occ", amount_kopecks: 100, currency: "RUB" },
  payment: { id: "pay", status: "REFUNDED" },
  booking: { id: "booking" },
  ticket: { id: "ticket" },
  refund_obligation: { id: "obligation", initial_source: "CUSTOMER_CANCELLATION_PARTIAL", target_refunded_amount_kopecks: 100, status: "FULFILLED" },
  refunds: [{ id: "refund", payment_id: "pay", source: "REFUND_OBLIGATION", refund_obligation_id: "obligation", amount_kopecks: 100, status: "SUCCEEDED", provider_reference: "tochka-1" }],
  email_outbox: [{ id: "outbox", type: "TICKET", payload_ref: "ticket", status: "DELIVERED", job_id: "job-1" }],
  email_provider_events: [{ outbox_id: "outbox", status: "DELIVERED", provider_status: "delivered", job_id: "job-1" }],
};

describe("certification evidence", () => {
  it("accepts only this run's own single-seat fixture", () => {
    expect(occurrenceIdentityDefect(occurrence, scope)).toBeUndefined();
    // A real event that happens to be open is the thing this excludes: every
    // later step mutates whatever it matched here.
    expect(occurrenceIdentityDefect({ ...occurrence, capacity: 40 }, scope)).toBe("CERTIFICATION_OCCURRENCE_CAPACITY_MISMATCH");
    expect(occurrenceIdentityDefect({ ...occurrence, price_kopecks: 350_000 }, scope)).toBe("CERTIFICATION_OCCURRENCE_PRICE_MISMATCH");
    expect(occurrenceIdentityDefect({ ...occurrence, title: "Настоящее событие" }, scope)).toBe("CERTIFICATION_OCCURRENCE_TITLE_MISMATCH");
  });

  it("requires every identifier to belong to the same order", () => {
    expect(orderIdentityDefect(evidence, identifiers)).toBeUndefined();
    expect(orderIdentityDefect({ ...evidence, booking: { id: "someone-elses" } }, identifiers)).toBe("CERTIFICATION_BOOKING_MISMATCH");
    expect(orderIdentityDefect({ ...evidence, order: { ...evidence.order, amount_kopecks: 100_000 } }, identifiers)).toBe("CERTIFICATION_ORDER_AMOUNT_MISMATCH");
  });

  it("does not take a DELIVERED row's word for delivery", () => {
    expect(emailEvidence(evidence, "TICKET", "ticket")).toEqual({ delivered: true, outboxId: "outbox", jobId: "job-1" });
    expect(emailEvidence({ ...evidence, email_provider_events: [] }, "TICKET", "ticket"))
      .toEqual({ delivered: false, code: "CERTIFICATION_EMAIL_PROVIDER_EVIDENCE_MISSING" });
  });

  it("fails a delivery that a later provider event contradicts", () => {
    // The row was never walked back. Reading it as success is how a bounced
    // ticket certifies as delivered mail.
    const bounced = { ...evidence, email_provider_events: [...evidence.email_provider_events!, { outbox_id: "outbox", status: "BOUNCED", job_id: "job-1" }] };
    expect(emailEvidence(bounced, "TICKET", "ticket")).toEqual({ delivered: false, code: "CERTIFICATION_EMAIL_CONTRADICTED_BY_PROVIDER" });
  });

  it("fails a delivery whose outbox has an event from a second send", () => {
    // Two sends exist for one message and only one of them is accounted for.
    const foreign = { ...evidence, email_provider_events: [...evidence.email_provider_events!, { outbox_id: "outbox", status: "DELIVERED", provider_status: "delivered", job_id: "job-2" }] };
    expect(emailEvidence(foreign, "TICKET", "ticket")).toEqual({ delivered: false, code: "CERTIFICATION_EMAIL_FOREIGN_JOB_EVENT" });
  });

  it("insists a message be unique before saying anything about it", () => {
    const duplicated = { ...evidence, email_outbox: [...evidence.email_outbox!, { id: "outbox-2", type: "TICKET", payload_ref: "ticket", status: "DELIVERED", job_id: "job-9" }] };
    expect(emailEvidence(duplicated, "TICKET", "ticket")).toEqual({ delivered: false, code: "CERTIFICATION_EMAIL_OUTBOX_NOT_UNIQUE" });
  });

  it("treats a second refund against one obligation as a defect, not a detail", () => {
    // It means the customer's card was credited twice.
    const doubled = { ...evidence, refunds: [...evidence.refunds!, { id: "refund-2", payment_id: "pay", source: "REFUND_OBLIGATION", refund_obligation_id: "obligation", amount_kopecks: 100, status: "SUCCEEDED", provider_reference: "tochka-2" }] };
    expect(refundConvergenceDefect(doubled, refundIds)).toBe("CERTIFICATION_REFUND_NOT_UNIQUE");
    expect(refundConvergenceDefect(evidence, refundIds)).toBeUndefined();
  });

  it("keeps reading when the provider is ahead of the derived local facts", () => {
    // A refund can read SUCCEEDED before the payment and obligation catch up.
    // The answer is to keep polling, never to issue a second refund.
    const ahead = { ...evidence, payment: { id: "pay", status: "PAID" } };
    expect(refundPollAction(ahead, refundIds)).toEqual({ kind: "WAIT_FOR_DERIVED", defect: "CERTIFICATION_PAYMENT_NOT_REFUNDED" });
    expect(refundPollAction(evidence, refundIds)).toEqual({ kind: "CONVERGED" });
  });

  it("stops on a terminal refund rather than trying another one", () => {
    const failed = { ...evidence, refunds: [{ ...evidence.refunds![0], status: "REVIEW_REQUIRED" }] };
    expect(refundPollAction(failed, refundIds)).toEqual({ kind: "TERMINAL", status: "REVIEW_REQUIRED" });
    expect(refundPollAction({ ...evidence, refunds: [] }, refundIds)).toEqual({ kind: "WAIT" });
  });

  it("will not stamp PASS on a manifest whose own facts disagree", () => {
    const manifest = {
      result: "PASS",
      occurrence: { id: "occ", final_sales_status: "CLOSED", final_visibility: "HIDDEN", public_cleanup_verified: true },
      booking: { after_cancellation: "CANCELLED" }, ticket: { after_cancellation: "VOID" },
      refund: { status: "SUCCEEDED" }, payment: { status: "REFUNDED" },
    };
    expect(manifestDefect(manifest, "occ")).toBeUndefined();
    expect(manifestDefect({ ...manifest, occurrence: { ...manifest.occurrence, final_visibility: "PUBLISHED" } }, "occ")).toBe("CERTIFICATION_MANIFEST_OCCURRENCE_NOT_CLEANED");
    expect(manifestDefect({ ...manifest, payment: { status: "PAID" } }, "occ")).toBe("CERTIFICATION_MANIFEST_PAYMENT_NOT_REFUNDED");
  });
});

describe("what an email timeout reports", () => {
  /** -r1's ticket, as production recorded it on 2026-09-24 (recipient omitted). */
  const r1Ticket = {
    email_outbox: [{
      id: "outbox-ticket", type: "TICKET", payload_ref: "ticket-1", status: "SENT",
      created_at: "2026-09-24 06:17:43", sent_at: "2026-09-24T06:23:25.653Z", delivered_at: null,
      recipient_email: "someone@example.invalid",
    }],
    email_provider_events: [
      { outbox_id: "outbox-ticket", status: "ACCEPTED", provider_status: "accepted", received_at: "2026-09-24 06:17:55" },
      { outbox_id: "outbox-ticket", status: "SENT", provider_status: "sent", received_at: "2026-09-24 06:17:58" },
      { outbox_id: "outbox-ticket", status: "ACCEPTED", provider_status: "accepted", received_at: "2026-09-24 06:23:25" },
      { outbox_id: "outbox-ticket", status: "SENT", provider_status: "sent", received_at: "2026-09-24 06:23:25" },
    ],
  };

  it("says what was seen: stuck at sent, since when, for how long", () => {
    expect(emailTimeoutDiagnosis(r1Ticket, "TICKET", "ticket-1",
      new Date("2026-09-24T06:17:58.000Z"), new Date("2026-09-24T06:32:49.000Z"))).toBe(
      "last_status=SENT last_provider=sent@2026-09-24T06:23:25Z provider_events=4 queued_at=2026-09-24T06:17:43Z "
      + "first_sent_at=2026-09-24T06:17:58Z waited=14m51s observed_at=2026-09-24T06:32:49.000Z "
      + "delivery_status=UNKNOWN evidence_source=UNRECORDED destination_response=UNAVAILABLE");
  });

  it("says what the receiver answered, from the latest event that says anything", () => {
    const deferred = {
      ...r1Ticket,
      email_provider_events: [
        ...r1Ticket.email_provider_events,
        { outbox_id: "outbox-ticket", status: "BOUNCED", provider_status: "soft_bounced", received_at: "2026-09-24 06:24:10", provider_event_time: "2026-09-24T06:24:09Z",
          evidence_source: "WEBHOOK", delivery_status: "err_mailbox_full", destination_response: "452 4.2.2 Mailbox full" },
        { outbox_id: "outbox-ticket", status: "SENT", provider_status: "sent", received_at: "2026-09-24 06:25:00", evidence_source: "EVENT_DUMP" },
      ],
    };
    expect(emailTimeoutDiagnosis(deferred, "TICKET", "ticket-1", new Date("2026-09-24T06:17:58Z"), new Date("2026-09-24T06:32:58Z")))
      .toMatch(/ delivery_status=err_mailbox_full evidence_source=WEBHOOK destination_response="452 4\.2\.2 Mailbox full"$/);
  });

  it("re-sanitizes a stored answer rather than trusting it", () => {
    const hostile = {
      ...r1Ticket,
      email_provider_events: [{ outbox_id: "outbox-ticket", status: "SENT", provider_status: "sent", received_at: "2026-09-24 06:17:58",
        evidence_source: "EVENT_DUMP", delivery_status: "err_will_retry", destination_response: '451 "try" someone@example.invalid\nhttps://x.invalid/a' }],
    };
    const report = emailTimeoutDiagnosis(hostile, "TICKET", "ticket-1", new Date("2026-09-24T06:17:58Z"), new Date("2026-09-24T06:32:58Z"));
    expect(report).toMatch(/ destination_response="451 'try' <address> <url>"$/);
    expect(report).not.toMatch(/someone|https|\n/);
  });

  it("never carries an address or a provider's free text", () => {
    const hostile = {
      ...r1Ticket,
      email_provider_events: [{ outbox_id: "outbox-ticket", status: "SENT", provider_status: "550 5.7.1 user@example.invalid rejected", received_at: "2026-09-24 06:17:58" }],
    };
    const report = emailTimeoutDiagnosis(hostile, "TICKET", "ticket-1", new Date("2026-09-24T06:17:58Z"), new Date("2026-09-24T06:32:58Z"));
    expect(report).not.toContain("@example.invalid");
    expect(report).not.toContain("550");
    expect(report).toContain("last_provider=unrecognised@2026-09-24T06:17:58Z");
  });

  it("says when there is nothing to see", () => {
    expect(emailTimeoutDiagnosis({}, "TICKET", "ticket-1", new Date("2026-09-24T06:00:00Z"), new Date("2026-09-24T06:15:00Z")))
      .toBe("last_status=NO_OUTBOX waited=15m00s observed_at=2026-09-24T06:15:00.000Z");
  });
});
