import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyV2Database } from "./db";
import { checkoutSnapshotHash, type SharedCheckoutSnapshot } from "./checkout-snapshot";
import { applyIsolatedRestoreErasure, assertReviewedRestoreSchema } from "./erasure-restore";
import { VerifiedErasureLedger, type ErasureKeys } from "./erasure-ledger";
import { grantEntitlement, revokeEntitlementForOrderLine } from "./entitlements";
import { issueLabTicket } from "./lab-tickets";
import { legalManifestHash } from "./legal-control";
import { recoveryObservationSchema, type RecoveryObservation, type RestoreRefrefReader } from "./restore-refref-reader";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().min(1).max(256);
export const restoreInventorySchema = z.object({
  version: z.literal(1), scope: z.enum(["canary", "production"]), merchantId: ref,
  backupSha256: sha256, sourceEvidenceSha256: sha256,
  // An owner-reviewed export, independent of the restored SQLite; API lookup cannot enumerate lost orders.
  completeThrough: z.string().datetime({ offset: true }),
  orders: z.array(z.object({ orderPublicId: ref, snapshotHash: z.string().regex(/^refref-jcs-1:[a-f0-9]{64}$/),
    refundIds: z.array(ref).max(1),
  }).strict()).max(100_000),
}).strict();
export type RestoreInventory = z.infer<typeof restoreInventorySchema>;
function fail(code: string): never { throw new Error(code); }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
export const recoveryDigest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Logical read-back includes every table and schema object; independent of WAL/checkpoint layout. */
export function restoredDatabaseDigest(db: Database.Database) {
  return db.transaction(() => {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return recoveryDigest({ schema, tables: tables.map(({ name }) => ({ name,
      rows: db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all().map(canonical).sort(),
    })) });
  })();
}

/** Independent local read-back, also usable after closing/reopening the recovered SQLite.
 * Does not attest current remote state, inventory completeness, owner GO or runtime admission. */
export function verifyRestoreReport(db: Database.Database, value: unknown) {
  const report = z.object({ version: z.literal(1), scope: z.enum(["canary", "production"]), state: z.literal("RECONCILED_CLOSED"),
    ownerGo: z.literal("REQUIRED"), runtimeAdmission: z.literal("PENDING"), inventorySha256: sha256,
    remoteSha256: sha256, erasureSha256: sha256, databaseSha256: sha256, reportSha256: sha256,
    orders: z.array(z.object({ orderPublicId: ref, state: z.enum(["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"]),
      fulfillment: z.enum(["NOT_READY", "READY", "DELIVERED", "FAILED", "ACTION_REQUIRED"]) }).strict()),
  }).strict().parse(value);
  const { reportSha256, ...body } = report;
  return db.transaction(() => {
    assertRestoreSalesClosed(db);
    if (reportSha256 !== recoveryDigest(body) || classifyV2Database(db) !== "SUPPORTED"
      || db.pragma("quick_check", { simple: true }) !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length
      || restoredDatabaseDigest(db) !== report.databaseSha256) fail("RESTORE_READBACK_FAILED");
    return { state: "LOCAL_READBACK_VERIFIED", reportSha256, runtimeAdmission: "PENDING" } as const;
  })();
}

export function assertRestoreSalesClosed(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM offers WHERE sale_mode<>'CLOSED' LIMIT 1").get()
    || (legacyLabSalesColumn(db) && db.prepare("SELECT 1 FROM lab_occurrences WHERE sales_status<>'CLOSED' LIMIT 1").get())
    || db.prepare("SELECT 1 FROM sales_activation WHERE revoked_at IS NULL LIMIT 1").get()) fail("RESTORE_SALES_OPEN");
}
const legacyLabSalesColumn = (db: Database.Database) => (db.pragma("table_info(lab_occurrences)") as { name: string }[])
  .some(column => column.name === "sales_status");
function freezeSales(db: Database.Database, now: string) {
  db.transaction(() => {
    db.prepare("UPDATE offers SET sale_mode='CLOSED',updated_at=? WHERE sale_mode<>'CLOSED'").run(now);
    // 0029 removed this second gate. Older reviewed restores still have it.
    if (legacyLabSalesColumn(db)) db.prepare("UPDATE lab_occurrences SET sales_status='CLOSED',updated_at=? WHERE sales_status<>'CLOSED'").run(now);
    db.prepare("UPDATE sales_activation SET revoked_at=?,revocation_reason='ISOLATED_RESTORE' WHERE revoked_at IS NULL").run(now);
  }).immediate();
}
type LocalOrderState = "DRAFT" | "PAYMENT_PENDING" | "FULFILLED" | "EXPIRED" | "CANCELLED" | "REFUND_PENDING" | "REFUNDED" | "REVIEW_REQUIRED";
type LocalAttemptState = "CREATING" | "CREATE_UNKNOWN" | "PENDING" | "CUSTOMER_ACTION_REQUIRED" | "PAID" | "DECLINED" | "EXPIRED"
  | "REFUND_PENDING" | "PARTIALLY_REFUNDED" | "REFUNDED" | "REVIEW_REQUIRED";
type RecoveryOrderState = "FULFILLED" | "REFUNDED" | "CANCELLED" | "EXPIRED";
// Both local witnesses must admit the independently verified remote outcome. A terminal unpaid
// outcome is never replaced by accepted money (or another unpaid terminal), and paid/refunded
// evidence is never erased by an unpaid outcome. Unknown states have no permitted transition.
const ORDER_RECOVERY_TARGETS: Readonly<Record<LocalOrderState, readonly RecoveryOrderState[]>> = {
  DRAFT: ["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"],
  PAYMENT_PENDING: ["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"],
  REVIEW_REQUIRED: ["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"],
  FULFILLED: ["FULFILLED", "REFUNDED"], REFUND_PENDING: ["FULFILLED", "REFUNDED"],
  CANCELLED: ["CANCELLED"], EXPIRED: ["EXPIRED"], REFUNDED: ["REFUNDED"],
};
const ATTEMPT_RECOVERY_TARGETS: Readonly<Record<LocalAttemptState, readonly RecoveryOrderState[]>> = {
  CREATING: ["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"],
  CREATE_UNKNOWN: ["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"],
  PENDING: ["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"],
  CUSTOMER_ACTION_REQUIRED: ["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"],
  REVIEW_REQUIRED: ["FULFILLED", "REFUNDED", "CANCELLED", "EXPIRED"],
  PAID: ["FULFILLED", "REFUNDED"], REFUND_PENDING: ["FULFILLED", "REFUNDED"],
  DECLINED: ["CANCELLED"], EXPIRED: ["EXPIRED"], REFUNDED: ["REFUNDED"],
  PARTIALLY_REFUNDED: [], // This recovery tool supports only a single full refund.
};
function assertLocalRecoveryTransition(order: LocalOrder, attempt: LocalAttempt, target: RecoveryOrderState) {
  if (!ORDER_RECOVERY_TARGETS[order.state]?.includes(target) || !ATTEMPT_RECOVERY_TARGETS[attempt.state]?.includes(target)) {
    fail("RESTORE_LOCAL_MONEY_AHEAD");
  }
}
type LocalOrder = { id: string; public_id: string; customer_id: string; state: LocalOrderState; total_kopecks: number;
  currency: string; checkout_snapshot_json: string; snapshot_hash: string; legal_release_id: string };
type LocalLine = { id: string; order_id: string; offer_ref_snapshot: string; unit_amount_kopecks: number;
  kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB"; course_ref: string | null; occurrence_ref: string | null };
type LocalAttempt = { id: string; state: LocalAttemptState; refref_attempt_id: string | null; refref_resolution_id: string | null;
  refref_snapshot_hash: string | null; request_payload_json: string; fulfillment_acknowledged_at: string | null };
type Entitlement = { customer_id: string; scope: string; course_ref: string | null; revoked_at: string | null; revocation_reason: string | null };
type Plan = { order: LocalOrder; line: LocalLine; localAttempt: LocalAttempt; observation: RecoveryObservation;
  state: RecoveryOrderState; entitlement?: Entitlement };

function localOrders(db: Database.Database) {
  const rows = db.prepare("SELECT * FROM orders ORDER BY public_id").all() as LocalOrder[];
  return rows.filter(row => {
    const snapshot = JSON.parse(row.checkout_snapshot_json) as { schema?: string };
    if (snapshot.schema === "flexperiment.manual-entitlement/1" && row.total_kopecks === 0
      && !db.prepare("SELECT 1 FROM checkout_attempts WHERE order_id=?").get(row.id)) return false;
    if (snapshot.schema !== "refref.shared-checkout-snapshot/1" && snapshot.schema !== "refref.shared-checkout-snapshot/2") fail("RESTORE_ORDER_SCHEMA_UNCLASSIFIED");
    return true;
  });
}

function planOrder(db: Database.Database, order: LocalOrder, item: RestoreInventory["orders"][number],
  observation: RecoveryObservation, inventory: RestoreInventory, now: Date): Plan {
  const snapshot = JSON.parse(order.checkout_snapshot_json) as SharedCheckoutSnapshot;
  const hash = checkoutSnapshotHash(snapshot);
  if (hash !== item.snapshotHash || hash !== `refref-jcs-1:${order.snapshot_hash}` || snapshot.merchantId !== inventory.merchantId
    || snapshot.merchantOrderRef !== order.public_id || snapshot.currency !== order.currency
    || snapshot.totalContractAmountKopecks !== order.total_kopecks || order.total_kopecks <= 0
    || snapshot.lines.length !== 1 || snapshot.paymentObligations.length !== 1) fail("RESTORE_LOCAL_SNAPSHOT_MISMATCH");
  const legal = db.prepare("SELECT version,manifest_json FROM legal_releases WHERE id=?").get(order.legal_release_id) as { version: string; manifest_json: string } | undefined;
  if (!legal || legal.version !== snapshot.legalReleaseRef || legalManifestHash(JSON.parse(legal.manifest_json)) !== snapshot.legalReleaseHash) fail("RESTORE_LEGAL_BINDING_MISMATCH");
  const lines = db.prepare(`SELECT line.*,product.kind,product.course_ref,product.occurrence_ref FROM order_lines line
    JOIN products product ON product.id=line.product_id WHERE line.order_id=?`).all(order.id) as LocalLine[];
  const localAttempt = db.prepare("SELECT * FROM checkout_attempts WHERE order_id=?").get(order.id) as LocalAttempt | undefined;
  const line = lines[0]; const frozen = snapshot.lines[0];
  if (lines.length !== 1 || !localAttempt || line.id !== frozen.lineRef || line.offer_ref_snapshot !== frozen.offerRef
    || line.unit_amount_kopecks !== order.total_kopecks || frozen.finalAmountKopecks !== order.total_kopecks
    || (line.kind === "LAB" && line.occurrence_ref !== frozen.unitRef)
    || !db.prepare("SELECT 1 FROM offers offer JOIN order_lines line ON line.product_id=offer.product_id WHERE line.id=? AND offer.offer_ref=?")
      .get(line.id, frozen.offerRef)) fail("RESTORE_LOCAL_BINDING_MISMATCH");
  const request = JSON.parse(localAttempt.request_payload_json) as { orderPublicId?: string; snapshotHash?: string; snapshot: SharedCheckoutSnapshot };
  if (request.orderPublicId !== order.public_id || request.snapshotHash !== hash || checkoutSnapshotHash(request.snapshot) !== hash) fail("RESTORE_LOCAL_REQUEST_MISMATCH");
  if (observation.order.merchantOrderId !== order.public_id || observation.order.checkoutAttempts.length !== 1) fail("RESTORE_ATTEMPT_AMBIGUOUS");
  const attempt = observation.order.checkoutAttempts[0];
  if (attempt.merchantOrderId !== order.public_id || attempt.snapshotHash !== hash
    || attempt.referralResolutionId !== snapshot.referralResolutionId || attempt.termsVersionId !== snapshot.termsVersionId
    || attempt.currency !== order.currency || attempt.totalContractAmountKopecks !== order.total_kopecks
    || (localAttempt.refref_attempt_id !== null && localAttempt.refref_attempt_id !== attempt.id)
    || (localAttempt.refref_resolution_id !== null && localAttempt.refref_resolution_id !== snapshot.referralResolutionId)
    || (localAttempt.refref_snapshot_hash !== null && localAttempt.refref_snapshot_hash !== hash)
    || attempt.lineItems.length !== 1 || attempt.obligations.length !== 1) fail("RESTORE_REMOTE_BINDING_MISMATCH");
  const remoteLine = attempt.lineItems[0]; const obligation = attempt.obligations[0]; const payment = obligation.payment;
  if (remoteLine.lineRef !== frozen.lineRef || remoteLine.offerRef !== frozen.offerRef || remoteLine.unitRef !== frozen.unitRef
    || remoteLine.merchantOfferAmountKopecks !== frozen.merchantOfferAmountKopecks
    || remoteLine.referralDiscountAmountKopecks !== frozen.referralDiscountAmountKopecks
    || remoteLine.finalAmountKopecks !== frozen.finalAmountKopecks || obligation.obligationRef !== "full"
    || obligation.amountKopecks !== order.total_kopecks) fail("RESTORE_REMOTE_LINE_MISMATCH");
  const fulfillment = observation.fulfillment;
  if (fulfillment.checkoutAttemptId !== attempt.id || (fulfillment.externalFulfillmentId !== null && fulfillment.externalFulfillmentId !== order.public_id)
    || ["FAILED", "ACTION_REQUIRED"].includes(fulfillment.status)
    || (fulfillment.status === "DELIVERED" && (!fulfillment.acknowledgedAt || fulfillment.externalFulfillmentId !== order.public_id))) fail("RESTORE_FULFILLMENT_REVIEW_REQUIRED");
  if (observation.refunds.length !== item.refundIds.length || new Set(observation.refunds.map(r => r.id)).size !== observation.refunds.length
    || observation.refunds.some(r => !item.refundIds.includes(r.id))) fail("RESTORE_REFUND_INVENTORY_MISMATCH");
  let state: Plan["state"];
  if (payment) {
    // Accepted money must be an exact full payment on a satisfied deal. Late/partial money needs a person.
    if (attempt.status !== "SETTLED" || obligation.status !== "SATISFIED" || payment.amountKopecks !== order.total_kopecks
      || Date.parse(payment.succeededAt) > now.getTime() || Date.parse(payment.succeededAt) > Date.parse(inventory.completeThrough)) fail("RESTORE_PAYMENT_REVIEW_REQUIRED");
    const refunded = observation.refunds.reduce((sum, refund) => sum + refund.amountKopecks, 0);
    if (payment.remainingRefundableAmountKopecks !== order.total_kopecks - refunded
      || remoteLine.refundableAmountKopecks !== payment.remainingRefundableAmountKopecks
      || (refunded !== 0 && refunded !== order.total_kopecks)
      || (payment.status === "REFUNDED" && refunded !== order.total_kopecks)
      || payment.status === "PARTIALLY_REFUNDED") fail("RESTORE_REFUND_INVENTORY_MISMATCH");
    for (const refund of observation.refunds) {
      if (refund.paymentId !== payment.id || refund.checkoutAttemptId !== attempt.id || refund.amountKopecks !== order.total_kopecks
        || Date.parse(refund.succeededAt) < Date.parse(payment.succeededAt) || Date.parse(refund.succeededAt) > now.getTime()
        || Date.parse(refund.succeededAt) > Date.parse(inventory.completeThrough)
        || refund.lineAllocations.length !== 1 || refund.lineAllocations[0].amountKopecks !== refund.amountKopecks) fail("RESTORE_REFUND_BINDING_MISMATCH");
    }
    if (fulfillment.status === "NOT_READY") fail("RESTORE_FULFILLMENT_REVIEW_REQUIRED");
    state = refunded ? "REFUNDED" : "FULFILLED";
  } else {
    if (observation.refunds.length || remoteLine.refundableAmountKopecks !== 0 || fulfillment.status !== "NOT_READY"
      || !["CANCELLED", "EXPIRED"].includes(attempt.status)) fail("RESTORE_PAYMENT_REVIEW_REQUIRED");
    state = attempt.status === "EXPIRED" ? "EXPIRED" : "CANCELLED";
  }
  assertLocalRecoveryTransition(order, localAttempt, state);
  const entitlement = db.prepare("SELECT * FROM course_entitlements WHERE source_order_line_id=?").get(line.id) as Entitlement | undefined;
  if (entitlement && (entitlement.customer_id !== order.customer_id || line.kind === "LAB"
    || entitlement.scope !== (line.kind === "COURSE_BUNDLE" ? "ALL_COURSES" : "COURSE") || entitlement.course_ref !== line.course_ref
    || (entitlement.revoked_at !== null && (state !== "REFUNDED" || entitlement.revocation_reason !== "REFUNDED")))) fail("RESTORE_ENTITLEMENT_MISMATCH");
  if (["CANCELLED", "EXPIRED"].includes(state) && (entitlement || order.state === "FULFILLED"
    || db.prepare("SELECT 1 FROM lab_tickets WHERE order_line_id=?").get(line.id))) fail("RESTORE_LOCAL_MONEY_AHEAD");
  const requests = db.prepare(`SELECT request.id,request.state,decision.outcome,decision.amount_kopecks AS decision_amount,
    execution.refref_payment_id,execution.amount_kopecks,execution.canonical_refund_id,execution.state AS execution_state
    FROM refund_requests request LEFT JOIN refund_decisions decision ON decision.refund_request_id=request.id
    LEFT JOIN refund_executions execution ON execution.refund_request_id=request.id WHERE request.order_line_id=?`).all(line.id) as
    Array<{ id: string; state: string; outcome: string | null; decision_amount: number | null; refref_payment_id: string | null;
      amount_kopecks: number | null; canonical_refund_id: string | null; execution_state: string | null }>;
  if (requests.filter(request => request.execution_state !== null).length > 1) fail("RESTORE_LOCAL_REFUND_REVIEW_REQUIRED");
  for (const request of requests) {
    if (["REQUESTED", "REJECTED"].includes(request.state)) {
      if (request.execution_state !== null || (state === "REFUNDED" && request.state === "REQUESTED")) fail("RESTORE_LOCAL_REFUND_REVIEW_REQUIRED");
      continue;
    }
    const refund = observation.refunds[0];
    if (!refund || !request.execution_state || request.outcome !== "APPROVE" || request.decision_amount !== refund.amountKopecks
      || request.refref_payment_id !== refund.paymentId || request.amount_kopecks !== refund.amountKopecks
      || (request.canonical_refund_id !== null && request.canonical_refund_id !== refund.id)) fail("RESTORE_LOCAL_REFUND_REVIEW_REQUIRED");
  }
  return { order, line, localAttempt, observation, state, entitlement };
}

function recordFact(db: Database.Database, orderPublicId: string, kind: "PAYMENT" | "REFUND", fact: unknown, id: string, at: string) {
  const key = `restore-${kind.toLowerCase()}-${recoveryDigest(id)}`;
  const evidence = JSON.stringify(fact);
  const existing = db.prepare("SELECT subject_ref,evidence_json FROM audit_log WHERE id=?").get(key) as { subject_ref: string; evidence_json: string } | undefined;
  if (existing) {
    if (existing.subject_ref !== orderPublicId || existing.evidence_json !== evidence) fail("RESTORE_FACT_CONFLICT");
    return;
  }
  db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
    VALUES (?,'ISOLATED_RESTORE',?,'ORDER',?,?,?)`).run(key, `RESTORE_ACCEPTED_${kind}`, orderPublicId, evidence, at);
}
function applyPlan(db: Database.Database, plan: Plan, now: string) {
  const { order, line, localAttempt, observation, state } = plan;
  const attempt = observation.order.checkoutAttempts[0]; const payment = attempt.obligations[0].payment;
  if (payment) recordFact(db, order.public_id, "PAYMENT", { id: payment.id, attemptId: attempt.id, snapshotHash: attempt.snapshotHash,
    amountKopecks: payment.amountKopecks, succeededAt: payment.succeededAt }, payment.id, payment.succeededAt);
  for (const refund of observation.refunds) {
    recordFact(db, order.public_id, "REFUND", refund, refund.id, refund.succeededAt);
    // Only recover an existing, matching merchant approval. Never fabricate one for a lost/external refund.
    db.prepare(`UPDATE refund_executions SET state='SUCCEEDED',canonical_refund_id=?,request_envelope=NULL,
      envelope_purged_at=CASE WHEN request_envelope IS NOT NULL THEN ? ELSE envelope_purged_at END,
      observed_projection_json=?,last_error_code=NULL,updated_at=? WHERE refund_request_id IN
      (SELECT id FROM refund_requests WHERE order_line_id=?) AND refref_payment_id=? AND amount_kopecks=?`)
      .run(refund.id, now, JSON.stringify({ refund, source: "ISOLATED_RESTORE" }), now, line.id, refund.paymentId, refund.amountKopecks);
    db.prepare(`UPDATE refund_requests SET state='REFUNDED',updated_at=? WHERE order_line_id=? AND id IN
      (SELECT refund_request_id FROM refund_executions WHERE canonical_refund_id=? AND state='SUCCEEDED')`).run(now, line.id, refund.id);
  }
  if (state === "FULFILLED") {
    if (line.kind === "LAB") issueLabTicket(db, line.id, payment!.succeededAt);
    else grantEntitlement(db, { customerId: order.customer_id, sourceOrderLineId: line.id,
      scope: line.kind === "COURSE_BUNDLE" ? "ALL_COURSES" : "COURSE", courseRef: line.course_ref ?? undefined }, payment!.succeededAt);
  } else if (state === "REFUNDED") revokeEntitlementForOrderLine(db, line.id, "REFUNDED", observation.refunds[0].succeededAt);
  db.prepare("UPDATE orders SET state=?,updated_at=? WHERE id=? AND state<>?").run(state, now, order.id, state);
  // Repair the local grant before trusting Refref's operational ACK. A READY ACK stays pending for the
  // normal idempotent runtime sweep after separate admission; recovery sends no external mutation.
  db.prepare(`UPDATE checkout_attempts SET state=?,refref_attempt_id=?,refref_resolution_id=?,refref_snapshot_hash=?,
    checkout_url=NULL,fulfillment_acknowledged_at=?,observed_payment_projection_json=?,last_reconciled_at=?,updated_at=? WHERE id=?`)
    .run(state === "FULFILLED" ? "PAID" : state === "CANCELLED" ? "DECLINED" : state, attempt.id, attempt.referralResolutionId,
      attempt.snapshotHash, observation.fulfillment.status === "DELIVERED" ? observation.fulfillment.acknowledgedAt : null,
      JSON.stringify({ source: "ISOLATED_RESTORE", state, attemptId: attempt.id, snapshotHash: attempt.snapshotHash }), now, now, localAttempt.id);
  db.prepare("UPDATE checkout_quotes SET state=?,updated_at=? WHERE order_public_id=? AND consumed_at IS NOT NULL AND state<>?")
    .run(payment ? "PAID" : state === "CANCELLED" ? "DECLINED" : "EXPIRED", now, order.public_id, payment ? "PAID" : state === "CANCELLED" ? "DECLINED" : "EXPIRED");
}

/** Owner-only isolated database operation. The caller keeps all runtimes/jobs/mail stopped.
 * Sales closure and erasure survive a refused reconciliation; money/access changes are all-or-nothing.
 * No receipt returned by this function opens a runtime or constitutes owner GO. */
export async function reconcileIsolatedRestore(input: {
  db: Database.Database; inventory: unknown; reader: RestoreRefrefReader; keys: ErasureKeys;
  readErasure: () => Promise<VerifiedErasureLedger>; now?: () => Date;
}) {
  const { db } = input; const now = input.now ?? (() => new Date());
  const inventory = restoreInventorySchema.parse(input.inventory);
  if (db.inTransaction || classifyV2Database(db) !== "SUPPORTED" || db.pragma("foreign_keys", { simple: true }) !== 1
    || db.pragma("quick_check", { simple: true }) !== "ok") fail("RESTORE_DATABASE_REFUSED");
  // Reject unreviewed triggers before even closing sales; they could otherwise mutate money/PII.
  assertReviewedRestoreSchema(db);
  if (Date.parse(inventory.completeThrough) > now().getTime() || new Set(inventory.orders.map(o => o.orderPublicId)).size !== inventory.orders.length
    || new Set(inventory.orders.flatMap(o => o.refundIds)).size !== inventory.orders.flatMap(o => o.refundIds).length) fail("RESTORE_INVENTORY_INVALID");
  freezeSales(db, now().toISOString());
  const ledger = await input.readErasure();
  applyIsolatedRestoreErasure(db, ledger, input.keys, inventory.scope, now());
  const orders = localOrders(db);
  if (orders.length !== inventory.orders.length || inventory.orders.some(item => !orders.some(o => o.public_id === item.orderPublicId))) fail("RESTORE_MERCHANT_TAIL_REQUIRED");
  const baseline = restoredDatabaseDigest(db);
  const observations: RecoveryObservation[] = [];
  for (const item of inventory.orders) observations.push(recoveryObservationSchema.parse(await input.reader.read(item.orderPublicId, item.refundIds)));
  // Re-read current custody and every Refref fact; a moving tail is not a stable recovery boundary.
  for (const [index, item] of inventory.orders.entries()) {
    const second = recoveryObservationSchema.parse(await input.reader.read(item.orderPublicId, item.refundIds));
    if (recoveryDigest(second) !== recoveryDigest(observations[index])) fail("RESTORE_REFREF_CHANGED");
  }
  // Refresh custody AFTER potentially long order reads, immediately before the local transaction.
  const current = await input.readErasure();
  VerifiedErasureLedger.prototype.assertFresh.call(current, now());
  if (current.bundle.scope !== inventory.scope || recoveryDigest(current.bundle) !== recoveryDigest(ledger.bundle)) fail("RESTORE_ERASURE_CHANGED");
  const result = db.transaction(() => {
    VerifiedErasureLedger.prototype.assertFresh.call(current, now());
    assertRestoreSalesClosed(db);
    if (restoredDatabaseDigest(db) !== baseline) fail("RESTORE_DATABASE_CHANGED");
    const plans = inventory.orders.map((item, index) => planOrder(db, orders.find(o => o.public_id === item.orderPublicId)!, item, observations[index], inventory, now()));
    for (const plan of plans) applyPlan(db, plan, now().toISOString());
    // Deterministic post-write read-back also validates repaired entitlement/financial bindings.
    for (const plan of plans) {
      const order = db.prepare("SELECT * FROM orders WHERE id=?").get(plan.order.id) as LocalOrder;
      const readback = planOrder(db, order, inventory.orders.find(i => i.orderPublicId === order.public_id)!, plan.observation, inventory, now());
      if (order.state !== plan.state || (plan.state === "FULFILLED" && (plan.line.kind === "LAB"
        ? !db.prepare("SELECT 1 FROM lab_tickets WHERE order_line_id=?").get(plan.line.id) : !readback.entitlement))) fail("RESTORE_READBACK_FAILED");
      if (plan.state === "REFUNDED" && readback.entitlement && readback.entitlement.revoked_at === null) fail("RESTORE_READBACK_FAILED");
    }
    assertRestoreSalesClosed(db);
    if ((db.pragma("foreign_key_check") as unknown[]).length) fail("RESTORE_READBACK_FAILED");
    return { version: 1, scope: inventory.scope, state: "RECONCILED_CLOSED", ownerGo: "REQUIRED", runtimeAdmission: "PENDING",
      inventorySha256: recoveryDigest(inventory), remoteSha256: recoveryDigest(observations), erasureSha256: recoveryDigest(current.bundle),
      databaseSha256: restoredDatabaseDigest(db), orders: plans.map(p => ({ orderPublicId: p.order.public_id, state: p.state,
        fulfillment: p.observation.fulfillment.status })),
    } as const;
  }).immediate();
  return { ...result, reportSha256: recoveryDigest(result) };
}
