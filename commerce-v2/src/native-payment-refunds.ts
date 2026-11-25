import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { revokeEntitlementForOrderLine } from "./entitlements";
import {
  admitRefund, applyRefundObservation, beginRefund, cancelReservedSettlement, refundKeys, type FiscalEventState, type FiscalizationMode, type NativePaymentState,
  type NativeRefundState, type ProductKind, type RefundDecision, type RefundObservation,
} from "./native-payment-contract";
import { auditNative, findNativeProvider, insertFiscalEvent, nativeProviderForPayment, type NativeLedgerContext } from "./native-payment-ledger";
import { NativeReadBackError, NativeReadBackUnavailable } from "./native-payment-provider";
import type { FrozenNativeRefundRequest, NativePaymentProvider, NativeRefundPreflight, RefundReadKey } from "./native-payment-provider";
import { openPayload, sealPayload } from "./refund-envelope";

/**
 * FLEX-119 · native refund execution (contract §5). Eligibility, amount and the operator's decision stay
 * in refunds.ts (FLEX-36/48); this executes an APPROVED full-line refund of a NATIVE order: frozen
 * sealed request, same key on every replay, access revoked only on a bound provider SUCCEEDED.
 */
type RefundContext = {
  request_id: string; request_public_id: string; request_state: string; amount_kopecks: number | null; line_id: string;
  unit_amount_kopecks: number; fiscal_item_json: string | null; order_id: string; order_public_id: string; kind: ProductKind;
  executor_key: string | null; snapshot_hash: string; fiscalization_mode: FiscalizationMode | null;
  email_normalized: string; payment_id: string | null; payment_state: NativePaymentState | null; provider_payment_id: string | null;
};
const refundContext = (db: Database.Database, requestPublicId: string) => db.prepare(`SELECT request.id AS request_id,
    request.public_id AS request_public_id,request.state AS request_state,decision.amount_kopecks,line.id AS line_id,line.unit_amount_kopecks,
    line.fiscal_item_json,orders.id AS order_id,orders.public_id AS order_public_id,product.kind,customer.email_normalized,
    payment.id AS payment_id,payment.state AS payment_state,payment.provider_payment_id,payment.executor_key,payment.fiscalization_mode,orders.snapshot_hash
  FROM refund_requests request JOIN order_lines line ON line.id=request.order_line_id JOIN orders ON orders.id=line.order_id
  JOIN products product ON product.id=line.product_id JOIN customers customer ON customer.id=orders.customer_id
  LEFT JOIN refund_decisions decision ON decision.refund_request_id=request.id AND decision.outcome='APPROVE'
  LEFT JOIN native_payments payment ON payment.order_id=orders.id WHERE request.public_id=?`).get(requestPublicId) as RefundContext | undefined;

type NativeRefundRow = {
  id: string; refund_request_id: string; native_payment_id: string; refund_ref: string; idempotency_key: string; amount_kopecks: number;
  dispatch_started: 0 | 1; state: NativeRefundState; last_reason: string | null; provider_refund_id: string | null; request_envelope: string | null; envelope_key_id: string | null; created_at: string;
};
const refundRow = (db: Database.Database, id: string) => db.prepare("SELECT * FROM native_refunds WHERE id=?").get(id) as NativeRefundRow | undefined;
const clock = (ctx: Pick<NativeLedgerContext, "now">) => (ctx.now ? ctx.now() : new Date().toISOString());
// Only the live connection that committed this row can retry a first, read-only preflight.
const liveRefunds = new WeakMap<Database.Database, Set<string>>();
const LIVE_REFUND_WINDOW_MS = 10 * 60_000;
function canResumePreflight(db: Database.Database, refund: NativeRefundRow, now: string) {
  return liveRefunds.get(db)?.has(refund.id) === true && Date.parse(now) - Date.parse(refund.created_at) < LIVE_REFUND_WINDOW_MS;
}

const settlementState = (db: Database.Database, lineId: string) => (db.prepare(`SELECT state FROM fiscal_events
  WHERE order_line_id=? AND kind='FINAL_SETTLEMENT'`).get(lineId) as { state: FiscalEventState } | undefined)?.state ?? null;
const paymentReceiptMethod = (db: Database.Database, lineId: string) => (db.prepare(`SELECT payment_method FROM fiscal_events
  WHERE order_line_id=? AND kind='PAYMENT_RECEIPT'`).get(lineId) as { payment_method: "FULL_PAYMENT" | "FULL_PREPAYMENT" } | undefined)?.payment_method;

export async function executeApprovedNativeRefund(db: Database.Database, ctx: NativeLedgerContext, requestPublicId: string) {
  const now = clock(ctx);
  const begun = db.transaction(() => {
    const context = refundContext(db, requestPublicId);
    if (!context) throw new Error("REFUND_REQUEST_NOT_FOUND");
    if (!context.payment_id || !context.payment_state || !context.provider_payment_id || !context.executor_key) throw new Error("REFUND_ROUTED_TO_ORIGINAL_CONTOUR");
    const existing = db.prepare("SELECT id FROM native_refunds WHERE refund_request_id=?").get(context.request_id) as { id: string } | undefined;
    if (existing) return { refund: refundRow(db, existing.id)!, created: false };
    if (context.request_state !== "APPROVED" || context.amount_kopecks === null) throw new Error("REFUND_APPROVAL_REQUIRED");
    const refunded = (db.prepare(`SELECT COALESCE(SUM(refund.amount_kopecks),0) AS n FROM native_refunds refund
      JOIN refund_requests request ON request.id=refund.refund_request_id WHERE request.order_line_id=? AND refund.state='SUCCEEDED'`)
      .get(context.line_id) as { n: number }).n;
    const admission = admitRefund({ contour: "NATIVE", paymentState: context.payment_state, lineAmountKopecks: context.unit_amount_kopecks,
      approvedAmountKopecks: context.amount_kopecks, alreadyRefundedKopecks: refunded, finalSettlementState: settlementState(db, context.line_id) });
    if (!admission.admitted) throw new Error(admission.code);
    nativeProviderForPayment(ctx, context.executor_key);
    const keys = refundKeys(requestPublicId);
    const id = randomUUID();
    const request: FrozenNativeRefundRequest = {
      idempotencyKey: keys.idempotencyKey, refundRef: keys.refundRef, providerPaymentId: context.provider_payment_id,
      paymentKey: { providerPaymentId: context.provider_payment_id, merchantOrderRef: context.order_public_id, snapshotHash: context.snapshot_hash },
      amountKopecks: context.amount_kopecks, currency: "RUB", receiptEmail: context.email_normalized,
      fiscalItems: context.fiscal_item_json ? [JSON.parse(context.fiscal_item_json)] : [],
    };
    const sealed = sealPayload(ctx.keyring, "native-refund-envelope", id, request);
    db.prepare(`INSERT INTO native_refunds(id,refund_request_id,native_payment_id,refund_ref,idempotency_key,amount_kopecks,state,
      request_envelope,envelope_key_id,created_at,updated_at,dispatch_started) VALUES (?,?,?,?,?,?,'SUBMITTING',?,?,?,?,0)`)
      .run(id, context.request_id, context.payment_id, keys.refundRef, keys.idempotencyKey, context.amount_kopecks, sealed.sealed, sealed.keyId, now, now);
    db.prepare("UPDATE refund_requests SET state='EXECUTING',updated_at=? WHERE id=? AND state='APPROVED'").run(now, context.request_id);
    db.prepare("UPDATE orders SET state='REFUND_PENDING',updated_at=? WHERE id=?").run(now, context.order_id);
    return { refund: refundRow(db, id)!, created: true };
  }).immediate();
  if (begun.created && beginRefund().effects.includes("PROVIDER_REFUND_SUBMIT")) {
    const live = liveRefunds.get(db) ?? new Set<string>();
    liveRefunds.set(db, live);
    live.add(begun.refund.id);
    await sendRefund(db, ctx, begun.refund.id);
  }
  return { requestPublicId, state: refundRow(db, begun.refund.id)!.state };
}

type ReplayBudget = { replays: number };

function refundExecutor(db: Database.Database, ctx: NativeLedgerContext, id: string) {
  const payment = db.prepare(`SELECT p.executor_key,p.provider_payment_id,o.public_id,p.snapshot_hash
    FROM native_refunds r JOIN native_payments p ON p.id=r.native_payment_id JOIN orders o ON o.id=p.order_id WHERE r.id=?`).get(id) as {
    executor_key: string; provider_payment_id: string; public_id: string; snapshot_hash: string;
  };
  return { provider: findNativeProvider(ctx, payment.executor_key),
    key: { providerPaymentId: payment.provider_payment_id, merchantOrderRef: payment.public_id, snapshotHash: payment.snapshot_hash } };
}

async function checkRefundPreflight(provider: NativePaymentProvider, request: FrozenNativeRefundRequest): Promise<NativeRefundPreflight> {
  try {
    return await provider.prepareRefund?.(request) ?? { outcome: "READY" };
  } catch (error) {
    return error instanceof NativeReadBackError ? { outcome: "CONFLICT", code: error.code } : { outcome: "UNAVAILABLE" };
  }
}

function applyRefundPreflight(db: Database.Database, ctx: NativeLedgerContext, refund: NativeRefundRow,
  decision: NativeRefundPreflight, freshlyStaged: boolean) {
  if (decision.outcome === "READY" && freshlyStaged) return true;
  const observation: RefundObservation =
    decision.outcome === "UNAVAILABLE" && freshlyStaged
      ? { source: "READ_BACK", outcome: "UNAVAILABLE", code: "NATIVE_REFUND_PREFLIGHT_UNAVAILABLE" }
      : decision.outcome === "READY" || decision.outcome === "UNAVAILABLE"
        ? { source: "READ_BACK", outcome: "DISPATCH_UNCERTAIN" }
        : decision.outcome === "DEFINITIVE_REFUSAL" && freshlyStaged
          ? { source: "SUBMIT_RESPONSE", outcome: "REFUSED", proven: true, code: decision.code }
          : { source: "READ_BACK", outcome: "REVIEW_REQUIRED", code: decision.code };
  db.transaction(() => {
    if (refundRow(db, refund.id)!.dispatch_started === 0) applyNativeRefundObservation(db, ctx, refund.id, observation, refund);
  }).immediate();
  if (observation.outcome !== "UNAVAILABLE") liveRefunds.get(db)?.delete(refund.id);
  return false;
}

async function sendRefund(db: Database.Database, ctx: NativeLedgerContext, refundId: string, budget: ReplayBudget = { replays: 1 }, replay = false) {
  const row = refundRow(db, refundId)!;
  if (row.state !== "SUBMITTING" && row.state !== "SUBMIT_UNKNOWN") return;
  if ((row.dispatch_started === 1) !== replay) return;
  if (!row.request_envelope || !row.envelope_key_id) throw new Error("NATIVE_REFUND_ENVELOPE_MISSING");
  const request = openPayload<FrozenNativeRefundRequest>(ctx.keyring, "native-refund-envelope", row.envelope_key_id, row.id, row.request_envelope);
  const { provider } = refundExecutor(db, ctx, refundId);

  if (!provider) return;
  if (!replay && provider.prepareRefund) {
    if (!provider.replayGuarantees.refund && !canResumePreflight(db, row, clock(ctx))) return;
    const preflight = await checkRefundPreflight(provider, request);
    const maySend = provider.replayGuarantees.refund || canResumePreflight(db, row, clock(ctx));
    if (!applyRefundPreflight(db, ctx, row, preflight, maySend)) return;
  }
  if (!replay && db.prepare(`UPDATE native_refunds SET dispatch_started=1,updated_at=?
      WHERE id=? AND dispatch_started=0 AND state='SUBMITTING'`).run(clock(ctx), refundId).changes !== 1) return;
  liveRefunds.get(db)?.delete(refundId);

  let observation: RefundObservation;
  try {
    const answer = await provider.submitRefund(request);
    observation = answer.outcome === "ACCEPTED"
      ? { source: "SUBMIT_RESPONSE", outcome: "ACCEPTED", providerRefundId: answer.providerRefundId }
      : { source: "SUBMIT_RESPONSE", outcome: "REFUSED", code: answer.code, proven: answer.proven };
  } catch {
    observation = { source: "SUBMIT_RESPONSE", outcome: "LOST" };
  }
  await driveNativeRefund(db, ctx, refundId, applyNativeRefundObservation(db, ctx, refundId, observation), budget);
}

async function readBackRefund(provider: NativePaymentProvider | undefined, refundRef: string, key: RefundReadKey): Promise<RefundObservation> {
  if (!provider) return { source: "READ_BACK", outcome: "UNAVAILABLE", code: "NATIVE_ORIGINAL_EXECUTOR_UNAVAILABLE" };
  try {
    const found = await provider.readRefund(refundRef, key);
    return found.outcome === "NOT_FOUND" ? { source: "READ_BACK", outcome: "NOT_FOUND" } : {
      source: "READ_BACK", outcome: "FOUND", providerRefundId: found.providerRefundId, status: found.status,
      providerPaymentId: found.providerPaymentId, amountKopecks: found.amountKopecks, currency: found.currency, refundRef: found.refundRef,
    };
  } catch (error) {
    return error instanceof NativeReadBackError ? { source: "READ_BACK", outcome: "REVIEW_REQUIRED", code: error.code }
      : { source: "READ_BACK", outcome: "UNAVAILABLE", ...(error instanceof NativeReadBackUnavailable ? { code: error.code } : {}) };
  }
}

export async function driveNativeRefund(db: Database.Database, ctx: NativeLedgerContext, refundId: string, first: RefundDecision,
  budget: ReplayBudget = { replays: 1 }) {
  const executor = refundExecutor(db, ctx, refundId);
  let decision = first;
  for (let step = 0; step < 6; step += 1) {
    // No admission gate on refunds (contract I7): the same sealed request under the same key.
    // At most one replay per drive (shared with nested sends); further retries belong to the sweep.
    if (decision.effects.includes("REPLAY_REFUND_SAME_KEY")) {
      if (!executor.provider?.replayGuarantees.refund || budget.replays <= 0) return decision;
      budget.replays -= 1;
      await sendRefund(db, ctx, refundId, budget, true);
      return { ...decision, effects: [] };
    }
    if (!decision.effects.includes("READ_BACK")) return decision;
    const refund = refundRow(db, refundId)!;
    const observation = await readBackRefund(executor.provider, refund.refund_ref, executor.key);
    decision = applyNativeRefundObservation(db, ctx, refundId, observation, refund);
  }
  return decision;
}

export function applyNativeRefundObservation(db: Database.Database, ctx: NativeLedgerContext, refundId: string, observation: RefundObservation,
  beforeRead?: Pick<NativeRefundRow, "state" | "provider_refund_id">) {
  const now = clock(ctx);
  return db.transaction(() => {
    const refund = refundRow(db, refundId);
    if (!refund) throw new Error("NATIVE_REFUND_NOT_FOUND");
    if ((refund.dispatch_started === 0 && observation.source === "READ_BACK" && observation.outcome === "FOUND")
      || (beforeRead && (refund.state !== beforeRead.state || refund.provider_refund_id !== beforeRead.provider_refund_id))) {
      return { state: refund.state, providerRefundId: refund.provider_refund_id, effects: [] } satisfies RefundDecision;
    }
    const request = db.prepare("SELECT public_id FROM refund_requests WHERE id=?").get(refund.refund_request_id) as { public_id: string };
    const context = refundContext(db, request.public_id)!;
    const decision = applyRefundObservation({ state: refund.state, providerRefundId: refund.provider_refund_id },
      { providerPaymentId: context.provider_payment_id!, amountKopecks: refund.amount_kopecks, currency: "RUB", refundRef: refund.refund_ref },
      observation, { fiscalizationMode: context.fiscalization_mode ?? "MERCHANT" });
    const envelope = decision.effects.includes("ISSUE_REFUND_RECEIPT") && refund.request_envelope && refund.envelope_key_id
      ? openPayload<FrozenNativeRefundRequest>(ctx.keyring, "native-refund-envelope", refund.envelope_key_id, refund.id, refund.request_envelope)
      : undefined;
    const purge = decision.effects.includes("PURGE_ENVELOPE");
    db.prepare(`UPDATE native_refunds SET state=?,provider_refund_id=COALESCE(provider_refund_id,?),last_reason=?,updated_at=?,
      request_envelope=CASE WHEN ? THEN NULL ELSE request_envelope END,
      envelope_purged_at=CASE WHEN ? AND request_envelope IS NOT NULL THEN ? ELSE envelope_purged_at END WHERE id=?`)
      .run(decision.state, decision.providerRefundId, decision.reason ?? null, now, purge ? 1 : 0, purge ? 1 : 0, now, refund.id);
    if (decision.reason === "NATIVE_ORIGINAL_EXECUTOR_UNAVAILABLE" && decision.reason !== refund.last_reason) {
      auditNative(db, "NATIVE_REFUND_READ_BACK_UNAVAILABLE", "REFUND_REQUEST", context.request_public_id, { reason: decision.reason }, now);
    }
    if (observation.source !== "READ_BACK" || observation.outcome === "FOUND"
      || decision.state !== refund.state || decision.reason !== refund.last_reason) db.prepare(`INSERT INTO native_payment_observations(id,native_refund_id,source,observation_json,decided_state,reason,observed_at)
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
        if (context.fiscalization_mode === "PROVIDER" && context.executor_key
          && nativeProviderForPayment(ctx, context.executor_key).readAutomaticReceipt) {
          insertFiscalEvent(db, ctx.keyring, { kind: "REFUND_RECEIPT", orderLineId: context.line_id, refundRequestId: context.request_id,
            refundRequestPublicId: context.request_public_id, paymentMethod: paymentReceiptMethod(db, context.line_id) ?? "FULL_PAYMENT",
            amountKopecks: refund.amount_kopecks, items: context.fiscal_item_json ? [JSON.parse(context.fiscal_item_json)] : [], mode: "PROVIDER",
            state: "PENDING", receiptEmail: null, now });
        }
      } else if (effect === "ISSUE_REFUND_RECEIPT") {
        insertFiscalEvent(db, ctx.keyring, { kind: "REFUND_RECEIPT", orderLineId: context.line_id, refundRequestId: context.request_id,
          refundRequestPublicId: context.request_public_id, paymentMethod: paymentReceiptMethod(db, context.line_id) ?? "FULL_PAYMENT",
          amountKopecks: refund.amount_kopecks, items: context.fiscal_item_json ? [JSON.parse(context.fiscal_item_json)] : [], mode: "MERCHANT",
          state: "SUBMITTING", receiptEmail: envelope?.receiptEmail ?? context.email_normalized, now });
      } else if (effect === "ALERT" && (decision.state !== refund.state || decision.reason !== refund.last_reason)) {
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
      OR (state='SUBMITTING' AND julianday(?) - julianday(updated_at) >= 60000 / 86400000.0)
    ORDER BY updated_at LIMIT 100`).all(now) as { id: string }[];
  let reconciled = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      const refund = refundRow(db, id)!;
      const { provider } = refundExecutor(db, ctx, id);
      if (refund.dispatch_started === 0 && provider && refund.state === "SUBMITTING" && (provider.replayGuarantees.refund || canResumePreflight(db, refund, now))) {
        await sendRefund(db, ctx, id);
      } else if (refund.dispatch_started === 0 && provider) {
        // A restored row cannot prove the refund is ours, even if the parent records one.
        if (!refund.request_envelope || !refund.envelope_key_id) throw new Error("NATIVE_REFUND_ENVELOPE_MISSING");
        const request = openPayload<FrozenNativeRefundRequest>(ctx.keyring, "native-refund-envelope", refund.envelope_key_id, id, refund.request_envelope);
        applyRefundPreflight(db, ctx, refund, await checkRefundPreflight(provider, request), false);
      } else {
        await driveNativeRefund(db, ctx, id, { state: refund.state, providerRefundId: refund.provider_refund_id, effects: ["READ_BACK"] });
      }
      reconciled += 1;
    } catch {
      failed += 1;
    }
  }
  return { selected: rows.length, reconciled, failed };
}
