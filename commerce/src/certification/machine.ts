import { readinessExpectation, type ReleaseCandidate } from "../release/candidate";
import { evaluateReadiness, type ReleaseReadinessEvidence } from "../release/readiness";
import type { CertificationCapability, CertificationClaim } from "./capability";
import { assertCatalogueClean, ensureCatalogueClean, type CatalogueCleanupPorts } from "./cleanup";
import {
  emailEvidence, manifestDefect, occurrenceIdentityDefect, orderIdentityDefect, refundConvergenceDefect, refundPollAction,
  type CertificationScope, type OccurrenceView, type OrderEvidence, type RefundIdentifiers, type RunIdentifiers,
} from "./evidence";
import {
  commandPermitted, directionAtLeast, enterCleanup, planRecovery,
  type BusinessCommand, type CertificationPhase, type CertificationRun, type CertificationRunStore, type OccurrenceDraft,
} from "./run";

/**
 * One real rouble through the deployed production system: create a single-seat
 * occurrence, sell it, pay for it, receive the ticket, cancel it, refund it,
 * and prove every one of those by the system's own durable evidence.
 *
 * This module owns ordering and nothing else. The run is the authority, the
 * capability is possession, the checkout authority owns admission, the
 * classifiers own judgement, and cleanup owns convergence. What is left here
 * is the sequence, which is the part that has to be read as prose:
 *
 *   load the run
 *   decide the one permitted next action
 *   arm the exact command by compare-and-set
 *   execute it
 *   settle by compare-and-set
 *
 * An ambiguous outside boundary is never resolved by trying again. Every path
 * out of "the provider may or may not have my money" ends in INCOMPLETE, which
 * means reconcile the effect that may exist, not issue a second one.
 */
export type CertifyOutcome =
  | { readonly kind: "PASS"; readonly manifest: Record<string, unknown> }
  /** An external effect may exist. Reconcile it; never re-issue. */
  | { readonly kind: "INCOMPLETE"; readonly code: string }
  | { readonly kind: "FAILED"; readonly code: string };

export interface AdminPort extends CatalogueCleanupPorts {
  systemEvidence(): Promise<ReleaseReadinessEvidence>;
  cityIdBySlug(slug: string): Promise<string | undefined>;
  createOccurrence(body: Record<string, unknown>, idempotencyKey: string): Promise<OccurrenceView>;
  orderIdsForCheckoutStatus(statusId: string): Promise<readonly string[]>;
  orderEvidence(orderId: string): Promise<OrderEvidence>;
  cancelBookingCustomerInitiated(bookingId: string, idempotencyKey: string): Promise<void>;
}

export interface PublicPort {
  checkoutContext(occurrenceId: string): Promise<{ readonly quoteId: string }>;
  /**
   * The claim proves possession only. The server establishes the release SHA,
   * the deployment session, the occurrence and the price this quote actually
   * costs, and admits the checkout and spends the capability together.
   */
  createCheckout(body: string, idempotencyKey: string, claim: CertificationClaim): Promise<{ readonly statusId: string; readonly paymentUrl?: string }>;
  checkoutStatus(statusId: string): Promise<{ readonly status: string }>;
}

/**
 * The human half. Certification exists to prove a person can buy a ticket and
 * read it, and no automated observation substitutes for someone opening the
 * mailbox.
 */
export interface OperatorPort {
  occurrenceDraft(cityId: string): Promise<Omit<OccurrenceDraft, "cityId">>;
  /** Returns the request body and its digest. The body itself is never persisted. */
  checkoutRequest(quoteId: string): Promise<{ readonly body: string; readonly sha256: string }>;
  /** Opens the provider page without the URL passing through a log or a state file. */
  openPaymentPage(paymentUrl: string): Promise<void>;
  confirmTicketVerified(): Promise<boolean>;
}

export type CertifyPorts = {
  readonly admin: AdminPort;
  readonly publicApi: PublicPort;
  readonly operator: OperatorPort;
  readonly runs: CertificationRunStore;
  readonly clock: () => Date;
  readonly newIdempotencyKey: () => string;
  /** Returns undefined when the deadline passed, so no caller can loop forever. */
  readonly waitFor: <T>(poll: () => Promise<T | undefined>, timeoutMs: number) => Promise<T | undefined>;
};

export type CertifyInput = {
  readonly runId: string;
  readonly candidate: ReleaseCandidate;
  readonly capability: CertificationCapability;
  readonly scope: CertificationScope;
  readonly citySlug: string;
  readonly timeouts: { readonly paymentMs: number; readonly emailMs: number; readonly refundMs: number };
};

export class CertificationIncomplete extends Error {
  constructor(readonly code: string) { super(code); this.name = "CertificationIncomplete"; }
}
export class CertificationFailed extends Error {
  constructor(readonly code: string) { super(code); this.name = "CertificationFailed"; }
}

export const certifyProduction = async (ports: CertifyPorts, input: CertifyInput): Promise<CertifyOutcome> => {
  const machine = new CertificationMachine(ports, input);
  try {
    return await machine.run();
  } catch (error) {
    const outcome: CertifyOutcome = error instanceof CertificationFailed
      ? { kind: "FAILED", code: error.code }
      // An unclassified throw is not evidence that nothing left the system.
      : { kind: "INCOMPLETE", code: error instanceof CertificationIncomplete ? error.code : (error instanceof Error ? error.message : "CERTIFICATION_UNKNOWN_FAILURE") };
    await machine.shutCatalogueAfterFailure();
    return outcome;
  }
};

const reasonFor = (runId: string) => `Production E2E certification ${runId}`;

class CertificationMachine {
  constructor(private readonly ports: CertifyPorts, private readonly input: CertifyInput) {}

  async run(): Promise<CertifyOutcome> {
    await this.assertBaseline();
    let run = this.load();
    const action = planRecovery(run, true);
    if (action.kind === "BLOCKED_BASELINE") throw new CertificationFailed("CERTIFICATION_BASELINE_NOT_VERIFIED");
    if (action.kind === "CLEAN_CATALOGUE" && run.direction === "CLEANUP_STARTED") {
      // A run that entered cleanup has one thing left to do, whatever phase it
      // reached first. It never becomes a PASS.
      await ensureCatalogueClean(this.ports.runs, this.ports.admin, run);
      throw new CertificationFailed("CERTIFICATION_CLEANUP_REQUIRED");
    }
    if (action.kind === "REPLAY_PENDING") run = await this.execute(run, action.command);

    while (run.phase !== "COMPLETE") {
      const before = run.phase;
      run = await this.step(run);
      if (run.phase === before) throw new CertificationFailed(`CERTIFICATION_PHASE_DID_NOT_ADVANCE:${before}`);
    }
    return { kind: "PASS", manifest: await this.buildManifest(run) };
  }

  private load(): CertificationRun {
    const run = this.ports.runs.load(this.input.runId);
    if (!run) throw new CertificationFailed("CERTIFICATION_RUN_NOT_FOUND");
    if (run.releaseSha !== this.input.candidate.sha) throw new CertificationFailed("CERTIFICATION_RUN_RELEASE_MISMATCH");
    return run;
  }

  /** Every advance is a compare-and-set on the revision this caller read. */
  private commit(run: CertificationRun, mutation: Parameters<CertificationRunStore["update"]>[2]): CertificationRun {
    return this.ports.runs.update(run.runId, run.revision, mutation);
  }

  /**
   * Production is still the exact revision this run is certifying, and it is
   * admitted by the same readiness predicate the deploy used. The expectation
   * comes from the candidate, so there is no way to type in the wrong one.
   */
  private async assertBaseline(): Promise<void> {
    const evidence = await this.ports.admin.systemEvidence();
    const readiness = evaluateReadiness(readinessExpectation(this.input.candidate), evidence, this.ports.clock());
    if (readiness.state !== "ADMITTED") throw new CertificationFailed(`CERTIFICATION_BASELINE_${readiness.state}:${readiness.code}`);
  }

  /**
   * Writes the command down before the request leaves. After this returns, a
   * crash is recoverable by re-issuing exactly this; before it, nothing was
   * sent and there is nothing to recover.
   */
  private arm(run: CertificationRun, command: BusinessCommand): CertificationRun {
    const forbidden = commandPermitted(run, command.kind);
    if (forbidden) throw new CertificationFailed(forbidden);
    return this.commit(run, { pendingCommand: command });
  }

  /**
   * The one path that performs a business effect, used identically by the
   * first attempt and by a replay. The command's own key and its own expected
   * revision are used as they were written; nothing is re-derived from what
   * production looks like now.
   */
  private async execute(run: CertificationRun, command: BusinessCommand): Promise<CertificationRun> {
    const forbidden = commandPermitted(run, command.kind);
    if (forbidden) throw new CertificationFailed(forbidden);
    const reason = reasonFor(run.runId);

    switch (command.kind) {
      case "CREATE_OCCURRENCE": {
        const occurrence = await this.ports.admin.createOccurrence(this.occurrenceBody(command.draft), command.idempotencyKey);
        if (occurrence.visibility !== "HIDDEN" || occurrence.sales_status !== "CLOSED") throw new CertificationFailed("CERTIFICATION_OCCURRENCE_BORN_SELLABLE");
        const defect = occurrenceIdentityDefect(occurrence, this.input.scope);
        if (defect) throw new CertificationFailed(defect);
        return this.commit(run, { pendingCommand: null, occurrenceId: occurrence.id, phase: "OCCURRENCE_CREATED" });
      }
      case "PUBLISH_OCCURRENCE":
      case "OPEN_SALES": {
        const patch = command.kind === "PUBLISH_OCCURRENCE" ? { visibility: "PUBLISHED" } : { sales_status: "OPEN" };
        await this.ports.admin.patchOccurrence(command.occurrenceId, patch, command.expectedRevision, reason, command.idempotencyKey);
        return this.commit(run, { pendingCommand: null, phase: command.kind === "PUBLISH_OCCURRENCE" ? "OCCURRENCE_PUBLISHED" : "OCCURRENCE_OPEN" });
      }
      case "CREATE_CHECKOUT": {
        const request = await this.ports.operator.checkoutRequest(command.quoteId);
        // Permanent idempotency rejects a body that is not identical, so this
        // proves the re-entered data before a second checkout could exist.
        if (command.requestSha256 !== request.sha256) throw new CertificationFailed("CERTIFICATION_CHECKOUT_REQUEST_CHANGED");
        const claim: CertificationClaim = { capabilityId: this.input.capability.id, runId: run.runId, nonce: this.input.capability.nonce };
        const checkout = await this.ports.publicApi.createCheckout(request.body, command.idempotencyKey, claim);
        if (run.statusId && checkout.statusId !== run.statusId) throw new CertificationFailed("CERTIFICATION_CHECKOUT_REPLAY_DIVERGED");
        const next = this.commit(run, { pendingCommand: null, statusId: checkout.statusId, phase: "CHECKOUT_CREATED" });
        if (checkout.paymentUrl) await this.ports.operator.openPaymentPage(checkout.paymentUrl);
        return next;
      }
      case "CANCEL_BOOKING": {
        await this.ports.admin.cancelBookingCustomerInitiated(command.bookingId, command.idempotencyKey);
        const after = await this.ports.admin.orderEvidence(this.requireOrder(run));
        if ((after.booking ?? {}).status !== "CANCELLED" || (after.ticket ?? {}).status !== "VOID") throw new CertificationIncomplete("CERTIFICATION_CANCELLATION_NOT_APPLIED");
        const occurrence = await this.ports.admin.occurrence(this.requireOccurrence(run));
        if (Number(occurrence.availability) !== this.input.scope.capacity) throw new CertificationFailed("CERTIFICATION_SEAT_NOT_RELEASED");
        return this.commit(run, { pendingCommand: null, phase: "BOOKING_CANCELLED" });
      }
    }
  }

  private occurrenceBody(draft: OccurrenceDraft): Record<string, unknown> {
    return {
      city_id: draft.cityId, title: this.input.scope.title, starts_at: draft.startsAt, ends_at: draft.endsAt,
      timezone: this.input.scope.timezone, price_kopecks: this.input.scope.priceKopecks, capacity: this.input.scope.capacity,
      venue_status: "TO_BE_ANNOUNCED", venue_disclosure_text: draft.venueDisclosureText, venue_announce_by: draft.venueAnnounceBy,
      reason: "Production E2E certification",
    };
  }

  private async step(run: CertificationRun): Promise<CertificationRun> {
    switch (run.phase) {
      case "NEW": return this.createOccurrence(run);
      case "OCCURRENCE_CREATED": return this.patchOccurrence(run, "PUBLISH_OCCURRENCE");
      case "OCCURRENCE_PUBLISHED": return this.patchOccurrence(run, "OPEN_SALES");
      case "OCCURRENCE_OPEN": return this.openQuote(run);
      case "QUOTE_READY":
      case "CHECKOUT_SUBMITTING": return this.submitCheckout(run);
      case "CHECKOUT_CREATED": return this.awaitPayment(run);
      case "ORDER_IDENTIFIED": return this.provePayment(run);
      case "PAYMENT_PROVEN": return this.awaitEmail(run, "TICKET", run.ticketId, "TICKET_EMAIL_DELIVERED");
      case "TICKET_EMAIL_DELIVERED": return this.cancelBooking(run);
      case "BOOKING_CANCELLED": return this.awaitEmail(run, "BOOKING_CANCELLED", run.bookingId, "BOOKING_CANCELLED_EMAIL_DELIVERED");
      case "BOOKING_CANCELLED_EMAIL_DELIVERED": return this.awaitRefund(run);
      case "REFUND_SUCCEEDED": return this.awaitEmail(run, "REFUND_SUCCEEDED", run.refundId, "REFUND_EMAIL_DELIVERED");
      case "REFUND_EMAIL_DELIVERED": return this.cleanCatalogue(run);
      case "OCCURRENCE_CLEANED": return this.proveFinalEvidence(run);
      case "COMPLETE": return run;
    }
  }

  private async createOccurrence(run: CertificationRun): Promise<CertificationRun> {
    await this.assertBaseline();
    const cityId = await this.ports.admin.cityIdBySlug(this.input.citySlug);
    if (!cityId) throw new CertificationFailed("CERTIFICATION_CITY_ABSENT");
    const drafted = await this.ports.operator.occurrenceDraft(cityId);
    const command = { kind: "CREATE_OCCURRENCE" as const, idempotencyKey: this.ports.newIdempotencyKey(), draft: { ...drafted, cityId } };
    return this.execute(this.arm(run, command), command);
  }

  private async patchOccurrence(run: CertificationRun, kind: "PUBLISH_OCCURRENCE" | "OPEN_SALES"): Promise<CertificationRun> {
    await this.assertBaseline();
    const occurrence = await this.assertOccurrenceIdentity(run);
    const expectedRevision = Number(occurrence.admin_revision);
    if (!Number.isSafeInteger(expectedRevision)) throw new CertificationFailed("CERTIFICATION_OCCURRENCE_REVISION_INVALID");
    const command = { kind, idempotencyKey: this.ports.newIdempotencyKey(), occurrenceId: occurrence.id, expectedRevision };
    return this.execute(this.arm(run, command), command);
  }

  private async openQuote(run: CertificationRun): Promise<CertificationRun> {
    await this.assertBaseline();
    const { quoteId } = await this.ports.publicApi.checkoutContext(this.requireOccurrence(run));
    return this.commit(run, { quoteId, phase: "QUOTE_READY" });
  }

  private async submitCheckout(run: CertificationRun): Promise<CertificationRun> {
    await this.assertBaseline();
    const quoteId = run.quoteId;
    if (!quoteId) throw new CertificationFailed("CERTIFICATION_QUOTE_MISSING");
    let current = run;

    // Money becomes possible at the next request, so the run records that it
    // might exist before it can. Recording afterwards is recording too late,
    // and the checkout authority refuses a run that has not recorded it.
    if (!directionAtLeast(current.direction, "FINANCIAL_EFFECT_POSSIBLE")) current = this.commit(current, { direction: "FINANCIAL_EFFECT_POSSIBLE" });
    if (current.phase === "QUOTE_READY") current = this.commit(current, { phase: "CHECKOUT_SUBMITTING" });

    const request = await this.ports.operator.checkoutRequest(quoteId);
    const command = { kind: "CREATE_CHECKOUT" as const, idempotencyKey: this.ports.newIdempotencyKey(), quoteId, requestSha256: request.sha256 };
    return this.execute(this.arm(current, command), command);
  }

  private async awaitPayment(run: CertificationRun): Promise<CertificationRun> {
    const statusId = run.statusId;
    if (!statusId) throw new CertificationFailed("CERTIFICATION_CHECKOUT_STATUS_MISSING");

    const settled = await this.ports.waitFor(async () => {
      const { status } = await this.ports.publicApi.checkoutStatus(statusId);
      return status === "PAID" || status === "FAILED" ? status : undefined;
    }, this.input.timeouts.paymentMs);
    // A payment that has not resolved is not a payment that did not happen.
    if (!settled) throw new CertificationIncomplete("CERTIFICATION_PAYMENT_UNRESOLVED");
    if (settled === "FAILED") throw new CertificationFailed("CERTIFICATION_PAYMENT_FAILED");

    const orderIds = await this.ports.admin.orderIdsForCheckoutStatus(statusId);
    if (orderIds.length !== 1) throw new CertificationIncomplete("CERTIFICATION_ORDER_NOT_UNIQUE");
    return this.commit(run, { orderId: orderIds[0], phase: "ORDER_IDENTIFIED" });
  }

  private async provePayment(run: CertificationRun): Promise<CertificationRun> {
    const evidence = await this.ports.admin.orderEvidence(this.requireOrder(run));
    const payment = evidence.payment ?? {};
    const booking = evidence.booking ?? {};
    const ticket = evidence.ticket ?? {};
    const identifiers: RunIdentifiers = {
      orderId: this.requireOrder(run), statusId: String(run.statusId), occurrenceId: this.requireOccurrence(run),
      paymentId: String(payment.id), bookingId: String(booking.id), ticketId: String(ticket.id),
      amountKopecks: this.input.scope.priceKopecks,
    };
    const defect = orderIdentityDefect(evidence, identifiers);
    if (defect) throw new CertificationFailed(defect);
    if (payment.status !== "PAID") throw new CertificationIncomplete("CERTIFICATION_PAYMENT_NOT_PAID");
    if (booking.status !== "CONFIRMED" || ticket.status !== "VALID") throw new CertificationIncomplete("CERTIFICATION_ENTITLEMENT_INCOMPLETE");
    // The provider's own signed callback, applied. Our record of a payment is
    // not independent evidence that the provider took the money.
    const applied = (evidence.tochka_webhook_events ?? []).filter((event) => event.provider === "TOCHKA" && event.status === "APPLIED" && event.entity_id === identifiers.paymentId);
    if (applied.length === 0) throw new CertificationIncomplete("CERTIFICATION_PROVIDER_CALLBACK_MISSING");
    const occurrence = await this.ports.admin.occurrence(identifiers.occurrenceId);
    if (Number(occurrence.availability) !== 0) throw new CertificationFailed("CERTIFICATION_SEAT_NOT_HELD");

    return this.commit(run, { paymentId: identifiers.paymentId, bookingId: identifiers.bookingId, ticketId: identifiers.ticketId, phase: "PAYMENT_PROVEN" });
  }

  private async awaitEmail(run: CertificationRun, type: string, payloadRef: string | null | undefined, next: CertificationPhase): Promise<CertificationRun> {
    if (!payloadRef) throw new CertificationFailed(`CERTIFICATION_EMAIL_REF_MISSING:${type}`);
    const orderId = this.requireOrder(run);
    const settled = await this.ports.waitFor(async () => {
      const evidence = await this.ports.admin.orderEvidence(orderId);
      const result = emailEvidence(evidence, type, payloadRef);
      if (result.delivered) return result;
      // Terminal non-delivery stops the run. It never resends: a second send
      // for one message is the duplicate-email defect the outbox exists to
      // prevent, and an operator retrying by hand is the same defect.
      if (result.code.startsWith("CERTIFICATION_EMAIL_NOT_DELIVERED:")) {
        const status = result.code.split(":")[1];
        if (status === "BOUNCED" || status === "FAILED" || status === "SEND_UNKNOWN") throw new CertificationFailed(`CERTIFICATION_EMAIL_TERMINAL:${type}:${status}`);
        return undefined;
      }
      if (result.code === "CERTIFICATION_EMAIL_OUTBOX_MISSING") return undefined;
      throw new CertificationFailed(result.code);
    }, this.input.timeouts.emailMs);
    if (!settled) throw new CertificationIncomplete(`CERTIFICATION_EMAIL_TIMEOUT:${type}`);
    return this.commit(run, { phase: next });
  }

  private async cancelBooking(run: CertificationRun): Promise<CertificationRun> {
    let current = run;
    if (!current.humanTicketVerifiedAt) {
      // Nothing automated substitutes for a person opening the mailbox and the
      // ticket, and this is the last moment it can be asked for honestly.
      const verified = await this.ports.operator.confirmTicketVerified();
      if (!verified) throw new CertificationIncomplete("CERTIFICATION_TICKET_NOT_HUMAN_VERIFIED");
      current = this.commit(current, { humanTicketVerifiedAt: this.ports.clock().toISOString() });
    }
    await this.assertBaseline();
    const evidence = await this.ports.admin.orderEvidence(this.requireOrder(current));
    const defect = orderIdentityDefect(evidence, this.identifiers(current));
    if (defect) throw new CertificationFailed(defect);
    if (!current.bookingId) throw new CertificationFailed("CERTIFICATION_BOOKING_MISSING");

    const command = { kind: "CANCEL_BOOKING" as const, idempotencyKey: this.ports.newIdempotencyKey(), bookingId: current.bookingId };
    return this.execute(this.arm(current, command), command);
  }

  private async awaitRefund(run: CertificationRun): Promise<CertificationRun> {
    const orderId = this.requireOrder(run);
    const paymentId = String(run.paymentId);
    const settled = await this.ports.waitFor(async () => {
      const evidence = await this.ports.admin.orderEvidence(orderId);
      const obligationId = String((evidence.refund_obligation ?? {}).id ?? "");
      if (!obligationId) return undefined;
      const answering = (evidence.refunds ?? []).filter((refund) => refund.payment_id === paymentId && refund.source === "REFUND_OBLIGATION" && refund.refund_obligation_id === obligationId);
      if (answering.length > 1) throw new CertificationFailed("CERTIFICATION_REFUND_NOT_UNIQUE");
      if (answering.length === 0) return undefined;

      const identifiers: RefundIdentifiers = { paymentId, obligationId, refundId: String(answering[0].id), amountKopecks: this.input.scope.priceKopecks };
      const action = refundPollAction(evidence, identifiers);
      if (action.kind === "TERMINAL") throw new CertificationFailed(`CERTIFICATION_REFUND_TERMINAL:${action.status}`);
      return action.kind === "CONVERGED" ? identifiers : undefined;
    }, this.input.timeouts.refundMs);
    if (!settled) throw new CertificationIncomplete("CERTIFICATION_REFUND_UNRESOLVED");
    return this.commit(run, { refundObligationId: settled.obligationId, refundId: settled.refundId, phase: "REFUND_SUCCEEDED" });
  }

  private async cleanCatalogue(run: CertificationRun): Promise<CertificationRun> {
    await this.assertOccurrenceIdentity(run);
    const cleaned = await ensureCatalogueClean(this.ports.runs, this.ports.admin, run);
    return this.commit(cleaned, { phase: "OCCURRENCE_CLEANED" });
  }

  /**
   * Called on every failure path. The outcome is already decided and is never
   * changed by what happens here: the point is only that a run which opened a
   * fixture does not leave it sellable, and that the record says so first.
   */
  async shutCatalogueAfterFailure(): Promise<void> {
    try {
      const run = this.ports.runs.load(this.input.runId);
      if (!run?.occurrenceId || run.direction === "CATALOGUE_CLEAN") return;
      await ensureCatalogueClean(this.ports.runs, this.ports.admin, run);
    } catch {
      // Best effort by construction, but the direction is armed inside
      // `ensureCatalogueClean` before anything is touched, so even a failing
      // close leaves a run no later resume will reopen. A second failure must
      // not replace the diagnosis the operator needs.
    }
  }

  private async assertOccurrenceIdentity(run: CertificationRun): Promise<OccurrenceView> {
    const occurrence = await this.ports.admin.occurrence(this.requireOccurrence(run));
    const defect = occurrenceIdentityDefect(occurrence, this.input.scope);
    if (defect) throw new CertificationFailed(defect);
    return occurrence;
  }

  /**
   * Read live, never from the record. The record says what was true when it
   * was written; an external reopen after a crash must prevent a PASS rather
   * than be papered over by it.
   */
  private async proveFinalEvidence(run: CertificationRun): Promise<CertificationRun> {
    await this.assertBaseline();
    await assertCatalogueClean(this.ports.admin, this.requireOccurrence(run));
    if (!run.humanTicketVerifiedAt) throw new CertificationFailed("CERTIFICATION_HUMAN_VERIFICATION_ABSENT");

    const evidence = await this.ports.admin.orderEvidence(this.requireOrder(run));
    const identityDefect = orderIdentityDefect(evidence, this.identifiers(run));
    if (identityDefect) throw new CertificationFailed(identityDefect);
    const refundDefect = refundConvergenceDefect(evidence, {
      paymentId: String(run.paymentId), obligationId: String(run.refundObligationId),
      refundId: String(run.refundId), amountKopecks: this.input.scope.priceKopecks,
    });
    if (refundDefect) throw new CertificationFailed(refundDefect);
    for (const [type, ref] of [["TICKET", run.ticketId], ["BOOKING_CANCELLED", run.bookingId], ["REFUND_SUCCEEDED", run.refundId]] as const) {
      const result = emailEvidence(evidence, type, String(ref));
      if (!result.delivered) throw new CertificationFailed(result.code);
    }
    return this.commit(run, { completedAt: this.ports.clock().toISOString(), phase: "COMPLETE" });
  }

  private async buildManifest(run: CertificationRun): Promise<Record<string, unknown>> {
    const evidence = await this.ports.admin.orderEvidence(this.requireOrder(run));
    const occurrence = await this.ports.admin.occurrence(this.requireOccurrence(run));
    const manifest = {
      result: "PASS", run_id: run.runId, environment: "production",
      release_sha: run.releaseSha, candidate_id: this.input.candidate.id,
      started_at: run.startedAt, completed_at: run.completedAt,
      occurrence: {
        id: occurrence.id, final_sales_status: occurrence.sales_status, final_visibility: occurrence.visibility,
        public_cleanup_verified: true, availability_after_cancellation: occurrence.availability,
      },
      order: evidence.order, payment: evidence.payment,
      booking: { ...evidence.booking, after_cancellation: (evidence.booking ?? {}).status },
      ticket: { ...evidence.ticket, after_cancellation: (evidence.ticket ?? {}).status, human_verified_at: run.humanTicketVerifiedAt },
      refund_obligation: evidence.refund_obligation,
      refund: (evidence.refunds ?? []).find((refund) => refund.id === run.refundId),
      tochka_webhook_events: evidence.tochka_webhook_events ?? [],
    };
    const defect = manifestDefect(manifest, occurrence.id);
    if (defect) throw new CertificationFailed(defect);
    return manifest;
  }

  private identifiers(run: CertificationRun): RunIdentifiers {
    return {
      orderId: this.requireOrder(run), statusId: String(run.statusId), occurrenceId: this.requireOccurrence(run),
      paymentId: String(run.paymentId), bookingId: String(run.bookingId), ticketId: String(run.ticketId),
      amountKopecks: this.input.scope.priceKopecks,
    };
  }

  private requireOccurrence(run: CertificationRun): string {
    if (!run.occurrenceId) throw new CertificationFailed("CERTIFICATION_OCCURRENCE_UNKNOWN");
    return run.occurrenceId;
  }

  private requireOrder(run: CertificationRun): string {
    if (!run.orderId) throw new CertificationFailed("CERTIFICATION_ORDER_UNKNOWN");
    return run.orderId;
  }
}
