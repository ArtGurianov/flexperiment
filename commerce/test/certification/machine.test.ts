import { describe, expect, it } from "vitest";
import { certifyProduction, type CertifyPorts } from "../../src/certification/machine";
import { ensureCatalogueClean } from "../../src/certification/cleanup";
import { InMemoryCertificationCapabilityStore, issueCapability } from "../../src/certification/capability";
import { InMemoryCertificationCheckoutAuthority, InMemoryCertificationOrderLedger, isReplay } from "../../src/certification/checkout-authority";
import { InMemoryCertificationCatalogueAuthority } from "../../src/certification/catalogue-authority";
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
  paymentStatus?: string;
  paymentState?: string;
  paymentAbsent?: boolean;
  capturedKopecks?: number;
  cancellationSticks?: boolean;
  refundAppears?: boolean;
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
    payment: options.paymentAbsent ? undefined : {
      id: "pay",
      status: options.paymentStatus ?? (cancelled ? "REFUNDED" : "PAID"),
      // Only a status that claims a capture carries one by default.
      captured_amount_kopecks: options.capturedKopecks
        ?? (["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(options.paymentStatus ?? (cancelled ? "REFUNDED" : "PAID")) ? 100 : 0),
      ...(options.paymentState ? { state: options.paymentState } : {}),
    },
    booking: { id: "booking", status: cancelled ? "CANCELLED" : "CONFIRMED" },
    ticket: { id: "ticket", status: cancelled ? "VOID" : "VALID" },
    refund_obligation: cancelled ? { id: "obligation", initial_source: "CUSTOMER_CANCELLATION_PARTIAL", target_refunded_amount_kopecks: 100, status: "FULFILLED" } : null,
    refunds: cancelled && options.refundAppears !== false
      ? [{ id: "refund", payment_id: "pay", source: "REFUND_OBLIGATION", refund_obligation_id: "obligation", amount_kopecks: 100, status: "SUCCEEDED", provider_reference: "tochka-1" }]
      : [],
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

  // The real catalogue authority, so what the machine can get away with is
  // decided by the contract production will use rather than by the fake.
  const catalogue = new InMemoryCertificationCatalogueAuthority(runs);

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
      async runCatalogueCommand(runId, command, body) {
        return catalogue.admit(runId, command, async () => {
          if (command.kind === "CREATE_OCCURRENCE") { calls.push({ kind: "create", key: command.idempotencyKey }); return occurrence; }
          calls.push({ kind: `patch:${Object.keys(body)[0]}=${Object.values(body)[0]}`, key: command.idempotencyKey, revision: command.expectedRevision });
          occurrence = { ...occurrence, ...body, admin_revision: Number(occurrence.admin_revision) + 1 };
          return occurrence;
        });
      },
      async occurrence() { return occurrence; },
      async occurrenceForCommand(key) { return catalogue.resultFor(key); },
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
  return { calls, log, ports, input, runs, capabilities, capability, orders, catalogue, authority, occurrenceNow: () => occurrence };
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

  it("stands down instead of deciding the run's fate after losing the race", async () => {
    // Two runners read the same revision. The loser finds out at the
    // compare-and-set - before anything left the process, because arming comes
    // first - so it has sent nothing and knows nothing. If it went on to
    // record a failure and shut the catalogue, a loser could stop the winner.
    const { ports, input, calls, runs } = production();
    const stale = runs.load("run")!;
    const winner = runs.update("run", stale.revision, { phase: "OCCURRENCE_CREATED", occurrenceId: "occ" });

    const outcome = await certifyProduction({ ...ports, runs: { create: runs.create.bind(runs), update: runs.update.bind(runs), load: () => stale } }, input);

    expect(outcome).toEqual({ kind: "INCOMPLETE", code: "CERTIFICATION_LOST_AUTHORITY" });
    expect(calls).toEqual([]);
    const after = runs.load("run")!;
    expect(after.revision).toBe(winner.revision);
    expect(after.failure ?? null).toBeNull();
    expect(after.direction).toBe("NORMAL");
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

  it("refuses a request armed before cleanup that arrives after it", async () => {
    // Compare-and-set on the run protects the run, not production: this
    // request left the process before cleanup began, and nothing on the
    // runner's side can call it back. The server is where it is stopped.
    const { ports, runs, catalogue, occurrenceNow } = production({ startAt: { phase: "OCCURRENCE_CREATED", occurrenceId: "occ" } });
    const armedCommand = { kind: "PUBLISH_OCCURRENCE" as const, idempotencyKey: "in-flight", occurrenceId: "occ", expectedRevision: 1 };
    const run = runs.update("run", runs.load("run")!.revision, { pendingCommand: armedCommand });

    // Cleanup wins the race: the intent is retired and the catalogue, already
    // hidden and closed, needs no patch at all - so its revision never moves.
    await ensureCatalogueClean(runs, ports.admin, run);

    await expect(ports.admin.runCatalogueCommand("run", armedCommand, { visibility: "PUBLISHED" }, "late"))
      .rejects.toThrow("CERTIFICATION_COMMAND_NOT_ARMED");
    expect(occurrenceNow().visibility).toBe("HIDDEN");
    expect(runs.load("run")?.direction).toBe("CATALOGUE_CLEAN");
    expect(catalogue.resultFor("in-flight")).toBeUndefined();
  });

  it("closes a catalogue command that won the race before cleanup reached it", async () => {
    // The opposite ordering, and it is equally correct: the command landed, so
    // cleanup sees what it did and shuts it.
    const { ports, runs, occurrenceNow } = production({ startAt: { phase: "OCCURRENCE_CREATED", occurrenceId: "occ" } });
    const armedCommand = { kind: "PUBLISH_OCCURRENCE" as const, idempotencyKey: "in-flight", occurrenceId: "occ", expectedRevision: 1 };
    const run = runs.update("run", runs.load("run")!.revision, { pendingCommand: armedCommand });

    await ports.admin.runCatalogueCommand("run", armedCommand, { visibility: "PUBLISHED" }, "first");
    expect(occurrenceNow().visibility).toBe("PUBLISHED");

    const cleaned = await ensureCatalogueClean(runs, ports.admin, run);

    expect(occurrenceNow().visibility).toBe("HIDDEN");
    expect(cleaned.direction).toBe("CATALOGUE_CLEAN");
  });

  it("recovers the order an ambiguous checkout already created", async () => {
    // The order exists and the capability is spent; only the response was
    // lost. Retiring the command would strand the run with no way to learn its
    // own status id, so it survives cleanup and is re-issued as a lookup.
    const { ports, input, runs, capabilities, capability, orders } = production({
      startAt: { phase: "CHECKOUT_SUBMITTING", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ", quoteId: "quote" },
    });
    const command = { kind: "CREATE_CHECKOUT" as const, idempotencyKey: "checkout-key", quoteId: "quote", requestSha256: "d".repeat(64) };
    let run = runs.update("run", runs.load("run")!.revision, { pendingCommand: command });

    // The request got through: order created, capability spent, response lost.
    await ports.publicApi.createCheckout("{}", command.idempotencyKey, { capabilityId: capability.id, runId: "run", nonce: capability.nonce });
    const spentAt = capabilities.get(capability.id)?.consumedAt;
    run = runs.update("run", run.revision, { failure: { outcome: "INCOMPLETE", code: "CERTIFICATION_CHECKOUT_UNRESOLVED", recordedAt: now.toISOString() } });
    run = await ensureCatalogueClean(runs, ports.admin, runs.load("run")!);
    expect(run.pendingCommand).toEqual(command);

    const outcome = await certifyProduction(ports, input);

    // The reason it failed is the reason reported, not whatever the recovery
    // happened to touch last.
    expect(outcome).toEqual({ kind: "INCOMPLETE", code: "CERTIFICATION_CHECKOUT_UNRESOLVED" });
    expect(runs.load("run")?.statusId).toBe("status");
    // Spent once, by the request that created the order.
    expect(capabilities.get(capability.id)?.consumedAt).toBe(spentAt);
    expect(orders.find("checkout-key")?.orderId).toBe("order");
  });

  it("proves a checkout absent when re-issuing it after cleanup is refused", async () => {
    // The mirror case: the request never got through. The refusal is the
    // answer, and the command is retired rather than left pending forever.
    const { ports, input, runs, capabilities, capability } = production({
      startAt: { phase: "CHECKOUT_SUBMITTING", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ", quoteId: "quote" },
    });
    const command = { kind: "CREATE_CHECKOUT" as const, idempotencyKey: "checkout-key", quoteId: "quote", requestSha256: "d".repeat(64) };
    const armed = runs.update("run", runs.load("run")!.revision, { pendingCommand: command });
    runs.update("run", armed.revision, { failure: { outcome: "INCOMPLETE", code: "CERTIFICATION_CHECKOUT_UNRESOLVED", recordedAt: now.toISOString() } });
    await ensureCatalogueClean(runs, ports.admin, runs.load("run")!);

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "FAILED", code: "CERTIFICATION_CHECKOUT_PROVED_ABSENT" });
    const settled = runs.load("run")!;
    expect(settled.pendingCommand ?? null).toBeNull();
    expect(settled.supersededCommand).toEqual({ command, reason: "CLEANUP_PROVED_CHECKOUT_ABSENT" });
    expect(capabilities.get(capability.id)?.consumedAt).toBeNull();
  });

  it("does not leave a hidden orphan when a creation response is lost", async () => {
    const { ports, input, runs, catalogue } = production();
    const command = { kind: "CREATE_OCCURRENCE" as const, idempotencyKey: "create-key", draft: { cityId: "city", startsAt: "s", endsAt: "e", venueDisclosureText: "v", venueAnnounceBy: "a" } };
    runs.update("run", runs.load("run")!.revision, { pendingCommand: command });
    // The creation landed; the runner never saw the answer.
    await ports.admin.runCatalogueCommand("run", command, {}, "create");
    expect(catalogue.resultFor("create-key")?.id).toBe("occ");
    runs.update("run", runs.load("run")!.revision, { direction: "CLEANUP_STARTED", pendingCommand: null, supersededCommand: { command, reason: "CLEANUP_SUPERSEDED_CATALOGUE_OPENING" } });

    await certifyProduction(ports, input);

    // The id is recovered from the key rather than lost with the response.
    expect(runs.load("run")?.occurrenceId).toBe("occ");
    expect(runs.load("run")?.direction).toBe("CATALOGUE_CLEAN");
  });

  it("does not resolve an unresolved payment by trying again", async () => {
    const { ports, input } = production({ startAt: { phase: "CHECKOUT_CREATED", occurrenceId: "occ", quoteId: "quote", statusId: "status", direction: "FINANCIAL_EFFECT_POSSIBLE" } });
    const stalled: CertifyPorts = { ...ports, waitFor: async () => undefined, publicApi: { ...ports.publicApi, async checkoutStatus() { return { status: "PENDING" }; } } };

    const outcome = await certifyProduction(stalled, input);

    // INCOMPLETE, not FAILED: the money may well have left. Reconcile it.
    expect(outcome).toEqual({ kind: "INCOMPLETE", code: "CERTIFICATION_PAYMENT_UNRESOLVED" });
  });

  it("passes a run that crashed between shutting the catalogue and recording it", async () => {
    // The happy path shuts the fixture as its last step. A crash in that gap
    // leaves a clean catalogue and an unfinished phase, and reading the clean
    // catalogue as failure turned a certification that had worked into a
    // permanent failure.
    const { ports, input, runs } = production({
      startAt: {
        phase: "REFUND_EMAIL_DELIVERED", direction: "CATALOGUE_CLEAN", occurrenceId: "occ",
        orderId: "order", statusId: "status", paymentId: "pay", bookingId: "booking", ticketId: "ticket",
        refundObligationId: "obligation", refundId: "refund",
        humanTicketVerifiedAt: "2026-09-20T01:00:00.000Z",
      },
    });
    // Cancelled and refunded already, exactly as the crashed run left it.
    await ports.admin.cancelBookingCustomerInitiated("booking", "before-the-crash");

    const outcome = await certifyProduction(ports, input);

    expect(outcome.kind).toBe("PASS");
    expect(runs.load("run")?.failure ?? null).toBeNull();
  });

  it("refunds a captured rouble even when the run failed for another reason", async () => {
    // An email that never arrived must not be the reason a customer keeps a
    // charge. The reported outcome is still the original failure.
    const { ports, input, runs, calls } = production({
      startAt: {
        phase: "PAYMENT_PROVEN", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status", paymentId: "pay", bookingId: "booking", ticketId: "ticket",
        failure: { outcome: "FAILED", code: "CERTIFICATION_EMAIL_TERMINAL:TICKET:BOUNCED", recordedAt: now.toISOString() },
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "FAILED", code: "CERTIFICATION_EMAIL_TERMINAL:TICKET:BOUNCED" });
    // It cancelled and saw the refund converge, at a phase the cancellation
    // command does not belong to.
    expect(calls.some((call) => call.kind.startsWith("cancel:"))).toBe(true);
    const settled = runs.load("run")!;
    expect(settled.refundId).toBe("refund");
    expect(settled.direction).toBe("CATALOGUE_CLEAN");
  });

  it("will not call a failed run recovered while the money is still out", async () => {
    // A payment that is still PAID is a rouble a real person has not got back.
    // Filing the incident now would lose the obligation with it.
    const { ports, input, runs } = production({
      cancellationSticks: false,
      startAt: {
        phase: "PAYMENT_PROVEN", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status", paymentId: "pay", bookingId: "booking", ticketId: "ticket",
        failure: { outcome: "FAILED", code: "CERTIFICATION_EMAIL_TERMINAL:TICKET:BOUNCED", recordedAt: now.toISOString() },
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "INCOMPLETE", code: "CERTIFICATION_CANCELLATION_NOT_APPLIED" });
    // The original reason survives for the next attempt; the recovery's own
    // trouble does not overwrite it.
    expect(runs.load("run")?.failure).toMatchObject({ code: "CERTIFICATION_EMAIL_TERMINAL:TICKET:BOUNCED" });
  });

  it("will not call a recovery done while the refund has not converged", async () => {
    // The cancellation landed and the obligation exists, but no refund has
    // answered it yet. Reporting the incident closed here would file it with a
    // real rouble still outstanding.
    const { ports, input, runs } = production({
      refundAppears: false,
      startAt: {
        phase: "PAYMENT_PROVEN", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status", paymentId: "pay", bookingId: "booking", ticketId: "ticket",
        failure: { outcome: "FAILED", code: "CERTIFICATION_EMAIL_TERMINAL:TICKET:BOUNCED", recordedAt: now.toISOString() },
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "INCOMPLETE", code: "CERTIFICATION_RECOVERY_MONEY_UNRESOLVED" });
    expect(runs.load("run")?.refundId ?? null).toBeNull();
    expect(runs.load("run")?.failure).toMatchObject({ code: "CERTIFICATION_EMAIL_TERMINAL:TICKET:BOUNCED" });
  });

  it.each([
    ["the provider refused the payment", { paymentStatus: "CANCELLED" }],
    ["the payment window closed", { paymentStatus: "EXPIRED" }],
  ])("finishes a failed run safely when %s", async (_label, override) => {
    // Nothing was captured, so no refund obligation exists - and none should.
    // Demanding one would leave the run unable to finish for the rest of its
    // life over money that was never taken.
    const { ports, input, calls } = production({
      ...override,
      startAt: {
        phase: "CHECKOUT_CREATED", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status",
        failure: { outcome: "FAILED", code: "CERTIFICATION_PAYMENT_FAILED", recordedAt: now.toISOString() },
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "FAILED", code: "CERTIFICATION_PAYMENT_FAILED" });
    expect(calls.some((call) => call.kind.startsWith("cancel:"))).toBe(false);
  });

  it.each([
    ["the provider has not answered yet", { paymentStatus: "PENDING" }],
    ["the payment is still reconciling", { paymentStatus: "RECONCILING" }],
    ["the payment needs review", { paymentStatus: "REVIEW_REQUIRED" }],
    // A cancelled-looking payment whose create call never got an answer is
    // still not proof that no payment exists at the provider.
    ["the create call itself was ambiguous", { paymentStatus: "CANCELLED", paymentState: "CREATE_UNKNOWN" }],
  ])("refuses to finish a failed run while %s", async (_label, override) => {
    // Not proven in either direction. Reading it as no-capture is the mistake
    // that files the incident while a real rouble is gone.
    const { ports, input, runs } = production({
      ...override,
      startAt: {
        phase: "CHECKOUT_CREATED", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status",
        failure: { outcome: "FAILED", code: "CERTIFICATION_PAYMENT_FAILED", recordedAt: now.toISOString() },
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect(outcome.kind).toBe("INCOMPLETE");
    expect((outcome as { code: string }).code).toContain("CERTIFICATION_RECOVERY_PAYMENT_UNRESOLVED");
    expect(runs.load("run")?.failure).toMatchObject({ code: "CERTIFICATION_PAYMENT_FAILED" });
  });

  it.each([
    ["a cancelled payment", "CANCELLED"],
    ["an expired payment", "EXPIRED"],
  ])("will not let %s with money against it count as no capture", async (_label, paymentStatus) => {
    // Nothing in the schema ties captured_amount_kopecks to status, and the
    // reconciler writes CANCELLED on a provider FAILED without requiring the
    // capture to be zero. Believing the label would close the incident with a
    // real rouble still out.
    const { ports, input, runs } = production({
      paymentStatus, capturedKopecks: 100, refundAppears: false,
      startAt: {
        phase: "PAYMENT_PROVEN", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status", paymentId: "pay", bookingId: "booking", ticketId: "ticket",
        failure: { outcome: "FAILED", code: "CERTIFICATION_PAYMENT_FAILED", recordedAt: now.toISOString() },
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect(outcome.kind).toBe("INCOMPLETE");
    expect(runs.load("run")?.refundId ?? null).toBeNull();
  });

  it("will not read an unreadable captured amount as proof of no capture", async () => {
    const { ports, input } = production({
      paymentStatus: "CANCELLED", capturedKopecks: Number.NaN,
      startAt: {
        phase: "CHECKOUT_CREATED", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status",
        failure: { outcome: "FAILED", code: "CERTIFICATION_PAYMENT_FAILED", recordedAt: now.toISOString() },
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect((outcome as { code: string }).code).toContain("CERTIFICATION_RECOVERY_PAYMENT_UNRESOLVED");
  });

  it("will not read missing payment evidence as proof that nothing was charged", async () => {
    // Checkout creates the order, the booking and a PENDING payment together,
    // so an order without a payment is an inconsistent reading.
    const { ports, input, runs } = production({
      paymentAbsent: true,
      startAt: {
        phase: "CHECKOUT_CREATED", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
        orderId: "order", statusId: "status",
        failure: { outcome: "FAILED", code: "CERTIFICATION_PAYMENT_FAILED", recordedAt: now.toISOString() },
      },
    });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "INCOMPLETE", code: "CERTIFICATION_RECOVERY_PAYMENT_EVIDENCE_ABSENT" });
    expect(runs.load("run")?.failure).toMatchObject({ code: "CERTIFICATION_PAYMENT_FAILED" });
  });

  it("refuses to certify a release other than the one it is running against", async () => {
    const { ports, input } = production();
    const outcome = await certifyProduction(ports, { ...input, candidate: { ...candidate, sha: "b".repeat(40) } });
    expect(outcome.kind).toBe("FAILED");
    expect((outcome as { code: string }).code).toContain("CERTIFICATION_BASELINE_");
  });

  it("stops rather than sells when something shut the fixture mid-run", async () => {
    // The happy path only shuts the fixture at its last step, so a catalogue
    // closed at this phase was closed from outside.
    const { ports, input, runs } = production({ startAt: { phase: "OCCURRENCE_OPEN", occurrenceId: "occ", direction: "CLEANUP_STARTED" } });

    const outcome = await certifyProduction(ports, input);

    expect(outcome).toEqual({ kind: "FAILED", code: "CERTIFICATION_CATALOGUE_SHUT_MID_RUN" });
    expect(runs.load("run")?.direction).toBe("CATALOGUE_CLEAN");
    expect(runs.load("run")?.failure).toMatchObject({ outcome: "FAILED", code: "CERTIFICATION_CATALOGUE_SHUT_MID_RUN" });
  });
});
