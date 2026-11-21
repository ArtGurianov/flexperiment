import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { revokeEntitlementForOrderLine } from "./entitlements";
import {
  admitRefund, applyRefundObservation, beginRefund, cancelReservedSettlement, refundKeys, type FiscalEventState, type NativePaymentState,
  type NativeRefundState, type ProductKind, type RefundDecision, type RefundObservation,
} from "./native-payment-contract";
import { auditNative, insertFiscalEvent, type NativeLedgerContext } from "./native-payment-ledger";
import type { FrozenNativeRefundRequest } from "./native-payment-provider";
import { openPayload, sealPayload } from "./refund-envelope";

/**
 * FLEX-119 · native refund execution (contract §5). Eligibility, amount and the operator's decision stay
 * in refunds.ts (FLEX-36/48); this executes an APPROVED full-line refund of a NATIVE order: frozen
 * sealed request, same key on every replay, access revoked only on a bound provider SUCCEEDED.
 */
type RefundContext = {
  request_id: string; request_public_id: string; request_state: string; amount_kopecks: number | null; line_id: string;
  unit_amount_kopecks: number; fiscal_item_json: string | null; order_id: string; order_public_id: string; kind: ProductKind;
  email_normalized: string; payment_id: string | null; payment_state: NativePaymentState | null; provider_payment_id: string | null;
};
const refundContext = (db: Database.Database, requestPublicId: string) => db.prepare(`SELECT request.id AS request_id,
    request.public_id AS request_public_id,request.state AS request_state,decision.amount_kopecks,line.id AS line_id,line.unit_amount_kopecks,
    line.fiscal_item_json,orders.id AS order_id,orders.public_id AS order_public_id,product.kind,customer.email_normalized,
    payment.id AS payment_id,payment.state AS payment_state,payment.provider_payment_id
  FROM refund_requests request JOIN order_lines line ON line.id=request.order_line_id JOIN orders ON orders.id=line.order_id
  JOIN products product ON product.id=line.product_id JOIN customers customer ON customer.id=orders.customer_id
  LEFT JOIN refund_decisions decision ON decision.refund_request_id=request.id AND decision.outcome='APPROVE'
  LEFT JOIN native_payments payment ON payment.order_id=orders.id WHERE request.public_id=?`).get(requestPublicId) as RefundContext | undefined;

type NativeRefundRow = {
  id: string; refund_request_id: string; native_payment_id: string; refund_ref: string; idempotency_key: string; amount_kopecks: number;
  state: NativeRefundState; provider_refund_id: string | null; request_envelope: string | null; envelope_key_id: string | null; created_at: string;
};
const refundRow = (db: Database.Database, id: string) => db.prepare("SELECT * FROM native_refunds WHERE id=?").get(id) as NativeRefundRow | undefined;
const clock = (ctx: Pick<NativeLedgerContext, "now">) => (ctx.now ? ctx.now() : new Date().toISOString());
const settlementState = (db: Database.Database, lineId: string) => (db.prepare(`SELECT state FROM fiscal_events
  WHERE order_line_id=? AND kind='FINAL_SETTLEMENT'`).get(lineId) as { state: FiscalEventState } | undefined)?.state ?? null;
const paymentReceiptMethod = (db: Database.Database, lineId: string) => (db.prepare(`SELECT payment_method FROM fiscal_events
  WHERE order_line_id=? AND kind='PAYMENT_RECEIPT'`).get(lineId) as { payment_method: "FULL_PAYMENT" | "FULL_PREPAYMENT" } | undefined)?.payment_method;

export async function executeApprovedNativeRefund(db: Database.Database, ctx: NativeLedgerContext, requestPublicId: string) {
  const now = clock(ctx);
  const begun = db.transaction(() => {
    const context = refundContext(db, requestPublicId);
    if (!context) throw new Error("REFUND_REQUEST_NOT_FOUND");
    if (!context.payment_id || !context.payment_state || !context.provider_payment_id) throw new Error("REFUND_ROUTED_TO_ORIGINAL_CONTOUR");
    const existing = db.prepare("SELECT id FROM native_refunds WHERE refund_request_id=?").get(context.request_id) as { id: string } | undefined;
    if (existing) return { refund: refundRow(db, existing.id)!, created: false };
    if (context.request_state !== "APPROVED" || context.amount_kopecks === null) throw new Error("REFUND_APPROVAL_REQUIRED");
    const refunded = (db.prepare(`SELECT COALESCE(SUM(refund.amount_kopecks),0) AS n FROM native_refunds refund
      JOIN refund_requests request ON request.id=refund.refund_request_id WHERE request.order_line_id=? AND refund.state='SUCCEEDED'`)
      .get(context.line_id) as { n: number }).n;
    const admission = admitRefund({ contour: "NATIVE", paymentState: context.payment_state, lineAmountKopecks: context.unit_amount_kopecks,
      approvedAmountKopecks: context.amount_kopecks, alreadyRefundedKopecks: refunded, finalSettlementState: settlementState(db, context.line_id) });
    if (!admission.admitted) throw new Error(admission.code);
    const keys = refundKeys(requestPublicId);
    const id = randomUUID();
    const request: FrozenNativeRefundRequest = {
      idempotencyKey: keys.idempotencyKey, refundRef: keys.refundRef, providerPaymentId: context.provider_payment_id,
      amountKopecks: context.amount_kopecks, currency: "RUB", receiptEmail: context.email_normalized,
      fiscalItems: context.fiscal_item_json ? [JSON.parse(context.fiscal_item_json)] : [],
    };
    const sealed = sealPayload(ctx.keyring, "native-refund-envelope", id, request);
    db.prepare(`INSERT INTO native_refunds(id,refund_request_id,native_payment_id,refund_ref,idempotency_key,amount_kopecks,state,
      request_envelope,envelope_key_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'SUBMITTING',?,?,?,?)`)
      .run(id, context.request_id, context.payment_id, keys.refundRef, keys.idempotencyKey, context.amount_kopecks, sealed.sealed, sealed.keyId, now, now);
    db.prepare("UPDATE refund_requests SET state='EXECUTING',updated_at=? WHERE id=? AND state='APPROVED'").run(now, context.request_id);
    db.prepare("UPDATE orders SET state='REFUND_PENDING',updated_at=? WHERE id=?").run(now, context.order_id);
    return { refund: refundRow(db, id)!, created: true };
  }).immediate();
  if (begun.created && beginRefund().effects.includes("PROVIDER_REFUND_SUBMIT")) await sendRefund(db, ctx, begun.refund.id);
  return { requestPublicId, state: refundRow(db, begun.refund.id)!.state };
}

async function sendRefund(db: Database.Database, ctx: NativeLedgerContext, refundId: string) {
  const row = refundRow(db, refundId)!;
  if (!row.request_envelope || !row.envelope_key_id) throw new Error("NATIVE_REFUND_ENVELOPE_MISSING");
  const request = openPayload<FrozenNativeRefundRequest>(ctx.keyring, "native-refund-envelope", row.envelope_key_id, row.id, row.request_envelope);
  let observation: RefundObservation;
  try {
    const answer = await ctx.provider.submitRefund(request);
    observation = answer.outcome === "ACCEPTED"
      ? { source: "SUBMIT_RESPONSE", outcome: "ACCEPTED", providerRefundId: answer.providerRefundId }
      : { source: "SUBMIT_RESPONSE", outcome: "REFUSED", code: answer.code, proven: answer.proven };
  } catch {
    observation = { source: "SUBMIT_RESPONSE", outcome: "LOST" };
  }
  await driveNativeRefund(db, ctx, refundId, applyNativeRefundObservation(db, ctx, refundId, observation));
}

async function readBackRefund(ctx: NativeLedgerContext, refundRef: string): Promise<RefundObservation> {
  try {
    const found = await ctx.provider.readRefund(refundRef);
    return found.outcome === "NOT_FOUND" ? { source: "READ_BACK", outcome: "NOT_FOUND" } : {
      source: "READ_BACK", outcome: "FOUND", providerRefundId: found.providerRefundId, status: found.status,
      providerPaymentId: found.providerPaymentId, amountKopecks: found.amountKopecks, currency: found.currency, refundRef: found.refundRef,
    };
  } catch {
    return { source: "READ_BACK", outcome: "UNAVAILABLE" };
  }
}

export async function driveNativeRefund(db: Database.Database, ctx: NativeLedgerContext, refundId: string, first: RefundDecision) {
  let decision = first;
  for (let step = 0; step < 6; step += 1) {
    // No admission gate on refunds (contract I7): the same sealed request under the same key.
    if (decision.effects.includes("REPLAY_REFUND_SAME_KEY")) { await sendRefund(db, ctx, refundId); return { ...decision, effects: [] }; }
    if (!decision.effects.includes("READ_BACK")) return decision;
    decision = applyNativeRefundObservation(db, ctx, refundId, await readBackRefund(ctx, refundRow(db, refundId)!.refund_ref));
  }
  return decision;
}

export function applyNativeRefundObservation(db: Database.Database, ctx: NativeLedgerContext, refundId: string, observation: RefundObservation) {
  const now = clock(ctx);
  return db.transaction(() => {
    const refund = refundRow(db, refundId);
    if (!refund) throw new Error("NATIVE_REFUND_NOT_FOUND");
    const request = db.prepare("SELECT public_id FROM refund_requests WHERE id=?").get(refund.refund_request_id) as { public_id: string };
    const context = refundContext(db, request.public_id)!;
    const decision = applyRefundObservation({ state: refund.state, providerRefundId: refund.provider_refund_id },
      { providerPaymentId: context.provider_payment_id!, amountKopecks: refund.amount_kopecks, currency: "RUB", refundRef: refund.refund_ref },
      observation, { fiscalizationMode: ctx.fiscalizationMode });
    const envelope = decision.effects.includes("ISSUE_REFUND_RECEIPT") && refund.request_envelope && refund.envelope_key_id
      ? openPayload<FrozenNativeRefundRequest>(ctx.keyring, "native-refund-envelope", refund.envelope_key_id, refund.id, refund.request_envelope)
      : undefined;
    const purge = decision.effects.includes("PURGE_ENVELOPE");
    db.prepare(`UPDATE native_refunds SET state=?,provider_refund_id=COALESCE(provider_refund_id,?),last_reason=?,updated_at=?,
      request_envelope=CASE WHEN ? THEN NULL ELSE request_envelope END,
      envelope_purged_at=CASE WHEN ? AND request_envelope IS NOT NULL THEN ? ELSE envelope_purged_at END WHERE id=?`)
      .run(decision.state, decision.providerRefundId, decision.reason ?? null, now, purge ? 1 : 0, purge ? 1 : 0, now, refund.id);
    db.prepare(`INSERT INTO native_payment_observations(id,native_refund_id,source,observation_json,decided_state,reason,observed_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), refund.id, observation.source, JSON.stringify(observation), decision.state, decision.reason ?? null, now);
    for (const effect of decision.effects) {
      if (effect === "REVOKE_ACCESS") {
        revokeEntitlementForOrderLine(db, context.line_id, "REFUNDED", now);
        db.prepare("UPDATE refund_requests SET state='REFUNDED',updated_at=? WHERE id=?").run(now, context.request_id);
        // A LAB ticket is void once its order is REFUNDED (lab-tickets.ts statusFor).
        db.prepare("UPDATE orders SET state='REFUNDED',updated_at=? WHERE id=?").run(now, context.order_id);
        const settlement = settlementState(db, context.line_id);
        if (settlement) {
          const cancelled = cancelReservedSettlement(settlement, "REFUND_SUCCEEDED");
          if (cancelled.effects.includes("PURGE_CONTACT")) {
            db.prepare(`UPDATE fiscal_events SET state='CANCELLED',last_reason=?,sealed_contact=NULL,contact_purged_at=?,updated_at=?
              WHERE order_line_id=? AND kind='FINAL_SETTLEMENT' AND state='AWAITING_SERVICE'`).run(cancelled.reason, now, now, context.line_id);
          } else if (cancelled.effects.includes("ALERT")) {
            auditNative(db, "NATIVE_SETTLEMENT_REVIEW_REQUIRED", "ORDER", context.order_public_id, { reason: cancelled.reason }, now);
          }
        }
      } else if (effect === "ISSUE_REFUND_RECEIPT") {
        insertFiscalEvent(db, ctx.keyring, { kind: "REFUND_RECEIPT", orderLineId: context.line_id, refundRequestId: context.request_id,
          refundRequestPublicId: context.request_public_id, paymentMethod: paymentReceiptMethod(db, context.line_id) ?? "FULL_PAYMENT",
          amountKopecks: refund.amount_kopecks, items: context.fiscal_item_json ? [JSON.parse(context.fiscal_item_json)] : [], mode: "MERCHANT",
          state: "SUBMITTING", receiptEmail: envelope?.receiptEmail ?? context.email_normalized, now });
      } else if (effect === "ALERT") {
        auditNative(db, "NATIVE_REFUND_REVIEW_REQUIRED", "REFUND_REQUEST", context.request_public_id, { reason: decision.reason, observation }, now);
      }
    }
    if (decision.state === "FAILED" && refund.state !== "FAILED") {
      // A proven refusal: a person decides; the customer keeps access meanwhile.
      db.prepare("UPDATE refund_requests SET state='REVIEW_REQUIRED',updated_at=? WHERE id=?").run(now, context.request_id);
      db.prepare("UPDATE orders SET state='FULFILLED',updated_at=? WHERE id=? AND state='REFUND_PENDING'").run(now, context.order_id);
    } else if (decision.state === "REVIEW_REQUIRED" && refund.state !== "REVIEW_REQUIRED") {
      db.prepare("UPDATE refund_requests SET state='REVIEW_REQUIRED',updated_at=? WHERE id=?").run(now, context.request_id);
      db.prepare("UPDATE orders SET state='REVIEW_REQUIRED',updated_at=? WHERE id=? AND state<>'REFUNDED'").run(now, context.order_id);
    }
    return decision;
  }).immediate();
}

export async function reconcilePendingNativeRefunds(db: Database.Database, ctx: NativeLedgerContext) {
  const now = clock(ctx);
  const rows = db.prepare(`SELECT id FROM native_refunds WHERE state IN ('SUBMIT_UNKNOWN','PROCESSING')
      OR (state='SUBMITTING' AND julianday(?) - julianday(created_at) >= 60000 / 86400000.0)
    ORDER BY updated_at LIMIT 100`).all(now) as { id: string }[];
  let reconciled = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      await driveNativeRefund(db, ctx, id, { state: refundRow(db, id)!.state, providerRefundId: null, effects: ["READ_BACK"] });
      reconciled += 1;
    } catch {
      failed += 1;
    }
  }
  return { selected: rows.length, reconciled, failed };
}
