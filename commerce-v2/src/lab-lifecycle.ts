import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { labLegalReview, type LabAcceptance } from "./lab-tickets";
import { occurrenceRow, recordRevision } from "./lab-occurrences";

/**
 * LAB lifecycle on a confirmed account (FLEX-57–62, owner decision 18.11.2026).
 *
 * - A new LAB hold, order or payment needs a customer whose email a verified sign-in bound
 *   (customers.auth_user_id). An order-scoped guest capability proves no mailbox and buys nothing new;
 *   it keeps read-back, ticket, recovery and refunds of the orders it already has.
 * - The purchase acceptance is stored with the confirmed customer and the order snapshot in the
 *   order-confirmation transaction, independent of lab_guest_access.
 * - Who reconciles and refunds an order (its contour) is C's `routeContour(order)` (FLEX-119, #289),
 *   injected here; a historical purchase keeps its original contour and a missing one fails closed.
 */
export class LabLifecycleError extends Error {
  constructor(code: string) { super(code); this.name = "LabLifecycleError"; }
}
const fail = (code: string): never => { throw new LabLifecycleError(code); };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** C's contour of an order (e.g. "NATIVE", "REFREF_RC2"), never derived here. */
export type LabRouteContour = (order: { orderId: string; orderPublicId: string }) => string | null;

/**
 * Server-side refusal of a new LAB hold, order or payment before account confirmation.
 * Call before a hold is written (preview) and again under the order's write lock (confirm).
 */
export function assertLabPurchaseAuthority(db: Database.Database, customerId: string, orderPublicId: string | null | undefined) {
  // Confirmed = a verified sign-in bound this customer to a user whose email was verified, for this email.
  const confirmed = db.prepare(`SELECT 1 FROM customers customer JOIN "user" account ON account.id=customer.auth_user_id
    WHERE customer.id=? AND account.email_verified=1 AND lower(account.email)=customer.email_normalized`).get(customerId);
  if (!confirmed) fail("LAB_ACCOUNT_CONFIRMATION_REQUIRED");
  // A guest-scoped order stays guest-scoped: its capability is not an account, even after sign-in.
  if (orderPublicId && db.prepare("SELECT 1 FROM lab_guest_access WHERE order_public_id=?").get(orderPublicId)) {
    fail("LAB_ACCOUNT_CONFIRMATION_REQUIRED");
  }
}

export type LabPurchaseAcceptanceInput = {
  orderId: string; orderPublicId: string; customerId: string; quoteId: string; legalReleaseId: string;
  acceptance: LabAcceptance | undefined; orderSnapshotHash: string; occurrenceSnapshotJson: string;
};

/**
 * Called inside confirmCheckout's write transaction after the order and its line exist and before
 * the payment attempt leaves Commerce. Re-reads the confirmed customer under the same lock.
 */
export function recordLabPurchaseAcceptance(db: Database.Database, input: LabPurchaseAcceptanceInput, now: string) {
  assertLabPurchaseAuthority(db, input.customerId, input.orderPublicId);
  const review = labLegalReview(db);
  const accepted = input.acceptance;
  if (accepted?.personalDataConsent !== true || accepted.termsAccepted !== true || accepted.receiptContactAccepted !== true
    || accepted.releaseVersion !== review.releaseVersion || accepted.manifestSha256 !== review.manifestSha256) fail("LAB_CONSENT_REQUIRED");
  // The order was priced under its quote's release; an activation in between is a new review.
  if (review.releaseId !== input.legalReleaseId) fail("LAB_LEGAL_RELEASE_CHANGED");
  const consents = review.documents.filter(document => ["personal_data", "course_offer", "receipt_contact", "refund_terms", "privacy", "fiscal_items"]
    .includes(document.kind)).map(document => ({ kind: document.kind, version: document.version, sha256: document.sha256 }));
  db.prepare(`INSERT INTO lab_purchase_acceptances(order_id,customer_id,quote_id,legal_release_id,release_version,manifest_sha256,
      consents_json,order_snapshot_hash,occurrence_snapshot_sha256,accepted_at,source,evidence_status)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'CONFIRMED_ACCOUNT_ORDER_CONFIRM','VERIFIED_ACCOUNT')`).run(
    input.orderId, input.customerId, input.quoteId, review.releaseId, review.releaseVersion, review.manifestSha256,
    // Choices and document identities only: no email, IP, free text or marketing (E, 21.11.2026).
    JSON.stringify({ personalDataConsent: true, termsAccepted: true, receiptContactAccepted: true, documents: consents }),
    input.orderSnapshotHash, sha256(input.occurrenceSnapshotJson), now);
}

/** Order states whose payment may still settle: their seat and money barrier stay. */
export const LAB_OPEN_ORDER_STATES = ["DRAFT", "PAYMENT_PENDING", "REVIEW_REQUIRED"] as const;
export const LAB_PAID_ORDER_STATES = ["FULFILLED", "REFUND_PENDING"] as const;

export type LabOccurrenceOrder = {
  orderId: string; orderPublicId: string; orderLineId: string; orderState: string; attemptState: string | null;
  ticketId: string | null; ticketUsedAt: string | null; refundState: string | null;
};

export function labOccurrenceOrders(db: Database.Database, occurrenceRef: string): LabOccurrenceOrder[] {
  return (db.prepare(`SELECT orders.id AS orderId,orders.public_id AS orderPublicId,line.id AS orderLineId,orders.state AS orderState,
      attempt.state AS attemptState,ticket.id AS ticketId,ticket.used_at AS ticketUsedAt,
      (SELECT request.state FROM refund_requests request WHERE request.order_line_id=line.id ORDER BY request.requested_at DESC LIMIT 1) AS refundState
    FROM order_lines line JOIN orders ON orders.id=line.order_id JOIN products product ON product.id=line.product_id
    LEFT JOIN checkout_attempts attempt ON attempt.order_id=orders.id
    LEFT JOIN lab_tickets ticket ON ticket.order_line_id=line.id
    WHERE product.occurrence_ref=? AND product.kind='LAB' ORDER BY orders.created_at,orders.id`).all(occurrenceRef)) as LabOccurrenceOrder[];
}

const occurrenceFor = (db: Database.Database, occurrenceRef: string) => db.prepare(
  "SELECT id,occurrence_ref,lifecycle,starts_at,ends_at,version FROM lab_occurrences WHERE occurrence_ref=?").get(occurrenceRef) as
  { id: string; occurrence_ref: string; lifecycle: string; starts_at: string; ends_at: string; version: number } | undefined;

const audit = (db: Database.Database, actor: string, action: string, subjectRef: string, evidence: unknown, now: string) =>
  db.prepare("INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?,?, 'LAB_OCCURRENCE',?,?,?)")
    .run(randomUUID(), actor, action, subjectRef, JSON.stringify(evidence), now);

/**
 * Step 1 of a cancellation with committed seats (FLEX-59): new sales stop now, unconfirmed holds end,
 * and no seat of a started payment is released. Idempotent for the same occurrence.
 */
export function beginLabOccurrenceCancellation(db: Database.Database, command: { occurrenceRef: string; actor: string; reason: string }, now: string) {
  const actor = command.actor?.trim(), reason = command.reason?.trim();
  if (!actor) fail("LAB_COMMAND_INVALID");
  // An operational reason, shown to buyers: no personal data, short (E review item 6).
  if (!reason || reason.length > 200) fail("LAB_CHANGE_REASON_REQUIRED");
  return db.transaction(() => {
    const occurrence = occurrenceFor(db, command.occurrenceRef) ?? fail("LAB_OCCURRENCE_NOT_FOUND");
    if (occurrence.lifecycle === "CANCELLED") fail("LAB_OCCURRENCE_CANCELLED");
    if (Date.parse(occurrence.ends_at) <= Date.parse(now)) fail("LAB_OCCURRENCE_FINISHED");
    const existing = db.prepare("SELECT state,requested_at FROM lab_occurrence_cancellations WHERE occurrence_ref=?").get(command.occurrenceRef) as
      { state: string; requested_at: string } | undefined;
    if (existing) return { occurrenceRef: command.occurrenceRef, state: existing.state, requestedAt: existing.requested_at, replayed: true };
    const product = db.prepare("SELECT id FROM products WHERE occurrence_ref=?").get(command.occurrenceRef) as { id: string } | undefined;
    if (product) {
      db.prepare(`UPDATE offers SET sale_mode='CLOSED',acceptance_allowlist_json='[]',acceptance_expires_at=NULL,updated_at=?
        WHERE product_id=?`).run(now, product.id);
      db.prepare("UPDATE products SET version=version+1,updated_at=? WHERE id=?").run(now, product.id);
      // An unconfirmed hold has no payment behind it; a consumed intent keeps its order's seat.
      db.prepare(`UPDATE checkout_quotes SET state='EXPIRED',failure_code='LAB_OCCURRENCE_CANCELLING',updated_at=?
        WHERE consumed_at IS NULL AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED','REVIEW')
          AND offer_id IN (SELECT id FROM offers WHERE product_id=?)`).run(now, product.id);
    }
    db.prepare("INSERT INTO lab_occurrence_cancellations(occurrence_ref,state,actor,reason,requested_at) VALUES (?, 'REQUESTED',?,?,?)")
      .run(command.occurrenceRef, actor, reason, now);
    audit(db, actor!, "LAB_OCCURRENCE_CANCELLATION_REQUESTED", command.occurrenceRef, { reason }, now);
    return { occurrenceRef: command.occurrenceRef, state: "REQUESTED", requestedAt: now, replayed: false };
  }).immediate();
}

export type LabReconcileRails = Partial<Record<string, (orderPublicId: string) => Promise<unknown>>>;

/**
 * Reads every started payment of the occurrence back through its own executor of record. Read-back
 * only: no new money is initiated. An order whose executor is unavailable stays open and is reported.
 */
export async function reconcileLabOccurrenceAttempts(db: Database.Database, occurrenceRef: string, routeContour: LabRouteContour,
  rails: LabReconcileRails) {
  const open = labOccurrenceOrders(db, occurrenceRef).filter(order => (LAB_OPEN_ORDER_STATES as readonly string[]).includes(order.orderState));
  const outcome = { selected: open.length, reconciled: 0, failed: 0, executorUnavailable: [] as string[] };
  for (const order of open) {
    const contour = routeContour(order);
    const reconcile = contour ? rails[contour] : undefined;
    if (!reconcile) { outcome.executorUnavailable.push(order.orderPublicId); continue; }
    try { await reconcile(order.orderPublicId); outcome.reconciled += 1; }
    catch { outcome.failed += 1; }
  }
  return outcome;
}

export type LabRefundObligation = {
  orderPublicId: string; orderLineId: string; contour: string | null; ticketUsedAt: string | null;
  refundState: string | null; reasonCode: "OCCURRENCE_CHANGED";
};

/**
 * Step 2: completes only while no started payment can still settle. Paid lines become refund
 * obligations of their own contour (FLEX-62; C executes, a missing contour is a person's to route); tickets turn VOID through the lifecycle,
 * an already-used ticket keeps its use record.
 */
export function completeLabOccurrenceCancellation(db: Database.Database, command: { occurrenceRef: string; actor: string },
  routeContour: LabRouteContour, now: string) {
  const actor = command.actor?.trim() || fail("LAB_COMMAND_INVALID");
  return db.transaction(() => {
    const cancellation = db.prepare("SELECT state,reason FROM lab_occurrence_cancellations WHERE occurrence_ref=?").get(command.occurrenceRef) as
      { state: string; reason: string } | undefined;
    if (!cancellation) fail("LAB_CANCELLATION_NOT_REQUESTED");
    const orders = labOccurrenceOrders(db, command.occurrenceRef);
    if (cancellation!.state === "COMPLETED") {
      const row = db.prepare("SELECT obligations_json FROM lab_occurrence_cancellations WHERE occurrence_ref=?").get(command.occurrenceRef) as { obligations_json: string };
      return { occurrenceRef: command.occurrenceRef, state: "COMPLETED", obligations: JSON.parse(row.obligations_json) as LabRefundObligation[], replayed: true };
    }
    const open = orders.filter(order => (LAB_OPEN_ORDER_STATES as readonly string[]).includes(order.orderState));
    if (open.length) fail("LAB_CANCELLATION_OPEN_PAYMENTS");
    const obligations: LabRefundObligation[] = orders.filter(order => (LAB_PAID_ORDER_STATES as readonly string[]).includes(order.orderState)).map(order => ({
      orderPublicId: order.orderPublicId, orderLineId: order.orderLineId, contour: routeContour(order),
      ticketUsedAt: order.ticketUsedAt, refundState: order.refundState, reasonCode: "OCCURRENCE_CHANGED" as const,
    }));
    const occurrence = occurrenceRow(db, command.occurrenceRef)!;
    const updated = db.prepare(`UPDATE lab_occurrences SET lifecycle='CANCELLED',cancelled_at=?,cancellation_reason=?,
        version=version+1,material_revision=material_revision+1,updated_at=? WHERE id=? AND version=? AND lifecycle='SCHEDULED'`)
      .run(now, cancellation!.reason, now, occurrence.id, occurrence.version);
    if (updated.changes !== 1) fail("LAB_OCCURRENCE_VERSION_CONFLICT");
    recordRevision(db, { before: occurrence, after: occurrenceRow(db, command.occurrenceRef)!, kind: "CANCELLED", changedFields: ["lifecycle"],
      customerFacing: true, actor, reason: cancellation!.reason, now });
    db.prepare("UPDATE lab_occurrence_cancellations SET state='COMPLETED',completed_at=?,obligations_json=? WHERE occurrence_ref=?")
      .run(now, JSON.stringify(obligations), command.occurrenceRef);
    return { occurrenceRef: command.occurrenceRef, state: "COMPLETED", obligations, replayed: false };
  }).immediate();
}
