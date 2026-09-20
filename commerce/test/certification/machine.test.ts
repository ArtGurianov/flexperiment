import { describe, expect, it } from "vitest";
import { certifyProduction, type CertifyPorts } from "../../src/certification/machine";
import { InMemoryCertificationCapabilityStore, issueCapability } from "../../src/certification/capability";
import { InMemoryCertificationCheckoutAuthority, InMemoryCertificationOrderLedger, isReplay } from "../../src/certification/checkout-authority";
import { InMemoryCertificationRunStore, type CertificationRun } from "../../src/certification/run";
import type { OccurrenceView, OrderEvidence } from "../../src/certification/evidence";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import type { ReleaseCandidate } from "../../src/release/candidate";

const sha = "a".repeat(40);
const versions = ["0001_launch_baseline.sql"];
const scope = { citySlug: "kemerovo", title: "FLEXPERIMENT — Кемерово — production E2E run", timezone: "Asia/Novokuznetsk", priceKopecks: 100, capacity: 1 };
const candidate: ReleaseCandidate = {
  id: "candidate", sha, releaseClass: "LAUNCH_BASELINE",
  expectation: { schemaInventory: schemaInventoryExpectation(versions), legalVersion: "2026-09-20.1", legalManifestSha256: "e".repeat(64) },
};
const now = new Date("2026-09-20T00:00:00.000Z");

type Options = {
  emailStatus?: string;
  cancellationSticks?: boolean;
  startAt?: Partial<CertificationRun>;
  occurrenceRevision?: number;
};

/**
 * One production, shaped by whatever the test wants to go wrong. The checkout
 * endpoint is wired to the real admission authority, so what the machine can
 * and cannot get away with is decided by the same contract production will use.
 */
const production = (options: Options = {}) => {
  const calls: { kind: string; key: string; revision?: number }[] = [];
  const log: string[] = [];
  let occurrence: OccurrenceView = {
    id: "occ", city_slug: "kemerovo", title: scope.title, timezone: scope.timezone, price_kopecks: 100, capacity: 1,
    visibility: "HIDDEN", sales_status: "CLOSED", availability: 1, admin_revision: options.occurrenceRevision ?? 1,
  };
  let cancelled = false;

  const evidence = (): OrderEvidence => ({
    order: { id: "order", public_status_id: "status", occurrence_id: "occ", amount_kopecks: 100, currency: "RUB" },
    payment: { id: "pay", status: cancelled ? "REFUNDED" : "PAID" },
    booking: { id: "booking", status: cancelled ? "CANCELLED" : "CONFIRMED" },
    ticket: { id: "ticket", status: cancelled ? "VOID" : "VALID" },
    refund_obligation: cancelled ? { id: "obligation", initial_source: "CUSTOMER_CANCELLATION_PARTIAL", target_refunded_amount_kopecks: 100, status: "FULFILLED" } : null,
    refunds: cancelled ? [{ id: "refund", payment_id: "pay", source: "REFUND_OBLIGATION", refund_obligation_id: "obligation", amount_kopecks: 100, status: "SUCCEEDED", provider_reference: "tochka-1" }] : [],
    email_outbox: [
      { id: "outbox-ticket", type: "TICKET", payload_ref: "ticket", status: options.emailStatus ?? "DELIVERED", job_id: "job-1" },
      { id: "outbox-cancel", type: "BOOKING_CANCELLED", payload_ref: "booking", status: "DELIVERED", job_id: "job-2" },
      { id: "outbox-refund", type: "REFUND_SUCCEEDED", payload_ref: "refund", status: "DELIVERED", job_id: "job-3" },
    ],
    email_provider_events: [
      { outbox_id: "outbox-ticket", status: "DELIVERED", provider_status: "delivered", job_id: "job-1" },
      { outbox_id: "outbox-cancel", status: "DELIVERED", provider_status: "delivered", job_id: "job-2" },
      { outbox_id: "outbox-refund", status: "DELIVERED", provider_status: "delivered", job_id: "job-3" },
    ],
    tochka_webhook_events: [{ provider: "TOCHKA", status: "APPLIED", entity_id: "pay" }],
  });

  const runtime = { sourceCommit: sha, startedAt: "2026-09-19T23:00:00.000Z", heartbeatAt: now.toISOString() };
  const runs = new InMemoryCertificationRunStore();
  const created = runs.create({
    runId: "run", revision: 1, releaseSha: sha, phase: "NEW", direction: "NORMAL", startedAt: now.toISOString(), ...options.startAt,
  });

  const capabilities = new InMemoryCertificationCapabilityStore();
  const capability = issueCapability(capabilities, { runId: "run", deploymentSessionId: "deploy", releaseSha: sha, maxAmountKopecks: 100, ttlMs: 900_000 }, now);
  const orders = new InMemoryCertificationOrderLedger();
  const authority = new InMemoryCertificationCheckoutAuthority(capabilities, runs, orders);

  let minted = 0;
  const ports: CertifyPorts = {
    runs, clock: () => now,
    newIdempotencyKey: () => `key-${(minted += 1)}`,
    waitFor: async (poll) => poll(),
    admin: {
      async systemEvidence() {
        return {
          commerce: runtime, worker: { ...runtime, lastSuccessfulSweepAt: now.toISOString() },
          schema: { lineage: "SUPPORTED" as const, versions },
          legal: { version: candidate.expectation.legalVersion, manifestSha256: candidate.expectation.legalManifestSha256 },
        };
      },
      async cityIdBySlug() { return "city"; },
      async createOccurrence(_body, key) { calls.push({ kind: "create", key }); return occurrence; },
      async occurrence() { return occurrence; },
      async patchOccurrence(_id, patch, revision, _reason, key) {
        calls.push({ kind: `patch:${Object.keys(patch)[0]}=${Object.values(patch)[0]}`, key, revision });
        occurrence = { ...occurrence, ...patch, admin_revision: Number(occurrence.admin_revision) + 1 };
        return occurrence;
      },
      async orderIdsForCheckoutStatus() { return ["order"]; },
      async orderEvidence() { return evidence(); },
      async cancelBookingCustomerInitiated(bookingId, key) {
        calls.push({ kind: `cancel:${bookingId}`, key });
        // An ambiguous cancellation: the request went out, the effect did not
        // land, and nobody can tell from here which.
        if (options.cancellationSticks === false) return;
        cancelled = true;
        occurrence = { ...occurrence, availability: 1 };
      },
      async occurrenceIsPubliclyVisible() { return occurrence.visibility === "PUBLISHED"; },
      async tourIncludes() { return occurrence.visibility === "PUBLISHED"; },
    },
    publicApi: {
      async checkoutContext() { return { quoteId: "quote" }; },
      async createCheckout(_body, key, claim) {
        calls.push({ kind: "checkout", key });
        // The real admission contract, with the facts a server would derive.
        const admitted = authority.createOrReplay(
          { idempotencyKey: key, claim, now, facts: { deploymentSessionId: "deploy", runtimeReleaseSha: sha, actualAmountKopecks: 100, checkoutOccurrenceId: occurrence.id } },
          () => { occurrence = { ...occurrence, availability: 0 }; return { orderId: "order", statusId: "status", paymentUrl: "https://provider.example/pay/secret" }; },
        );
        return isReplay(admitted) ? { statusId: admitted.order.statusId } : admitted;
      },
      async checkoutStatus() { return { status: "PAID" }; },
    },
    operator: {
      async occurrenceDraft() { return { startsAt: "2026-10-01T18:00:00+07:00", endsAt: "2026-10-01T20:00:00+07:00", venueDisclosureText: "Место будет объявлено", venueAnnounceBy: "2026-09-25T12:00:00+07:00" }; },
      async checkoutRequest() { return { body: "{}", sha256: "d".repeat(64) }; },
      async openPaymentPage(url) { log.push(url.startsWith("https://") ? "payment-page-opened" : "payment-page-leaked"); },
      async confirmTicketVerified() { calls.push({ kind: "human-verified", key: "" }); return true; },
    },
  };

  const input = { runId: created.runId, candidate, capability, scope, citySlug: "kemerovo", timeouts: { paymentMs: 1000, emailMs: 1000, refundMs: 1000 } };
  return { calls, log, ports, input, runs, capabilities, capability, orders };
};

describe("certifying production", () => {
  it("runs the whole purchase and refund, and only then says PASS", async () => {
    const { ports, input, calls, log, capabilities, capability } = production();

    const outcome = await certifyProduction(ports, input);

    expect(outcome.kind).toBe("PASS");
    // A seat is never sellable before it exists, a person confirms the ticket
    // before the booking is cancelled, and the catalogue is shut before the
    // manifest is written.
    expect(calls.map((call) => call.kind)).toEqual([
      "create", "patch:visibility=PUBLISHED", "patch:sales_status=OPEN", "checkout",
      "human-verified", "cancel:booking", "patch:sales_status=CLOSED", "patch:visibility=HIDDEN",
    ]);
    expect(log).toContain("payment-page-opened");
    expect(capabilities.get(capability.id)?.consumedAt).toBe(now.toISOString());
  });

  it("does not touch production after losing the race to arm a command", async () => {
    // Two runners read the same revision. The loser finds out at the
    // compare-and-set, which happens before anything leaves the process.
    const { ports, input, calls, runs } = production();
    const stale = runs.load("run")!;
    runs.update("run", stale.revision, { phase: "OCCURRENCE_CREATED", occurrenceId: "occ" });

    const outcome = await certifyProduction({ ...ports, runs: { create: runs.create.bind(runs), update: runs.update.bind(runs), load: () => stale } }, input);

    expect(outcome).toMatchObject({ kind: "INCOMPLETE", code: expect.stringContaining("CERTIFICATION_RUN_REVISION_CONFLICT") });
    expect(calls.filter((call) => call.kind === "create")).toEqual([]);
  });

  it("replays an interrupted command with the revision and key it was armed with", async () => {
    // Production has moved on to revision 9 since the command was written. A
    // resume that re-read the revision would turn a compare-and-set into a
    // blind overwrite of whatever is there now.
    const { ports, input, calls } = production({
      occurrenceRevision: 9,
      startAt: {
        phase: "OCCURRENCE_CREATED", occurrenceId: "occ",
        pendingCommand: { kind: "PUBLISH_OCCURRENCE", idempotencyKey: "armed-before-the-crash", occurrenceId: "occ", expectedRevision: 2 },
      },
    });

    await certifyProduction(ports, input);

    expect(calls[0]).toEqual({ kind: "patch:visibility=PUBLISHED", key: "armed-before-the-crash", revision: 2 });
  });

  it("keeps an ambiguous cancellation command through the cleanup that follows it", async () => {
    // The catalogue has to shut, and the exact command and key still have to
    // be there afterwards: that is what a reconciliation needs to find out
    // whether the customer was charged.
    const { ports, input, runs, calls } = production({
      cancellationSticks: false,
      startAt: {
        phase: "TICKET_EMAIL_DELIVERED", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status", paymentId: "pay", bookingId: "booking", ticketId: "ticket",
        humanTicketVerifiedAt: "2026-09-20T01:00:00.000Z",
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "INCOMPLETE", code: "CERTIFICATION_CANCELLATION_NOT_APPLIED" });
    const settled = runs.load("run")!;
    expect(settled.pendingCommand).toMatchObject({ kind: "CANCEL_BOOKING", bookingId: "booking" });
    expect(settled.pendingCommand?.idempotencyKey).toBe(calls.find((call) => call.kind.startsWith("cancel:"))?.key);
    expect(settled.direction).toBe("CATALOGUE_CLEAN");
  });

  it("retires a catalogue-opening intent when a failure turns the run to cleanup", async () => {
    // It must never execute again, but its record - and its key - survive.
    const { ports, input, runs } = production({ emailStatus: "SEND_UNKNOWN" });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "FAILED", code: "CERTIFICATION_EMAIL_TERMINAL:TICKET:SEND_UNKNOWN" });
    const settled = runs.load("run")!;
    expect(settled.direction).toBe("CATALOGUE_CLEAN");
    expect(settled.pendingCommand ?? null).toBeNull();
  });

  it("does not resolve an unresolved payment by trying again", async () => {
    const { ports, input } = production({ startAt: { phase: "CHECKOUT_CREATED", occurrenceId: "occ", quoteId: "quote", statusId: "status", direction: "FINANCIAL_EFFECT_POSSIBLE" } });
    const stalled: CertifyPorts = { ...ports, waitFor: async () => undefined, publicApi: { ...ports.publicApi, async checkoutStatus() { return { status: "PENDING" }; } } };

    const outcome = await certifyProduction(stalled, input);

    // INCOMPLETE, not FAILED: the money may well have left. Reconcile it.
    expect(outcome).toEqual({ kind: "INCOMPLETE", code: "CERTIFICATION_PAYMENT_UNRESOLVED" });
  });

  it("refuses to certify a release other than the one it is running against", async () => {
    const { ports, input } = production();
    const outcome = await certifyProduction(ports, { ...input, candidate: { ...candidate, sha: "b".repeat(40) } });
    expect(outcome.kind).toBe("FAILED");
    expect((outcome as { code: string }).code).toContain("CERTIFICATION_BASELINE_");
  });

  it("finishes the cleanup and stays failed when resumed mid-cleanup", async () => {
    const { ports, input, runs } = production({ startAt: { phase: "OCCURRENCE_OPEN", occurrenceId: "occ", direction: "CLEANUP_STARTED" } });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "FAILED", code: "CERTIFICATION_CLEANUP_REQUIRED" });
    expect(runs.load("run")?.direction).toBe("CATALOGUE_CLEAN");
  });
});
