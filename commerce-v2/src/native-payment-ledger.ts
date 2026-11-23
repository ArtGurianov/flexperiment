import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { grantEntitlement } from "./entitlements";
import { issueLabTicket } from "./lab-tickets";
import {
  admitErasure, applyPaymentObservation, beginPayment, buyerPaymentStatus, buyerRefundStatus, fiscalEventRef, paymentKeys, paymentReceiptMethod,
  routeContour, type FiscalEventState, type FiscalizationMode, type NativePaymentState, type NativeRefundState, type PaymentDecision,
  type PaymentObservation, type ProductKind,
} from "./native-payment-contract";
import type { FrozenNativePaymentRequest, NativePaymentProvider } from "./native-payment-provider";
import { openPayload, sealPayload, type RefundEnvelopeKeyring } from "./refund-envelope";

/**
 * FLEX-119 · the durable native payment ledger (contract §3). Every observation is applied in one
 * SQLite transaction together with the effects the contract assigns to it (grant, ticket, fiscal event
 * creation, order state); external effects (read-back, replay) are performed after commit by the
 * driver. Nothing here imports or calls Refref.
 */
export type NativeLedgerContext = {
  readonly provider: NativePaymentProvider;
  readonly keyring: RefundEnvelopeKeyring;
  readonly fiscalizationMode: FiscalizationMode;
  /** Sales admission (storefront switch + FLEX-90) for the order's storefront, read at each new-money send. */
  readonly mayInitiate: (kind: ProductKind, orderPublicId: string) => boolean;
  readonly now?: () => string;
};

const INTENT_STATE: Record<NativePaymentState, string> = {
  CREATING: "PAYMENT_CREATING", CREATE_UNKNOWN: "UNCERTAIN", PENDING: "PENDING", PAID: "PAID", DECLINED: "DECLINED", EXPIRED: "EXPIRED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
};

/** A CREATING row younger than this may still be in flight in another request; the sweep leaves it. */
export const NATIVE_CREATING_UNANSWERED_AFTER_MS = 60_000;
const MAX_DRIVE_STEPS = 6;

const clock = (ctx: Pick<NativeLedgerContext, "now">) => (ctx.now ? ctx.now() : new Date().toISOString());

export function auditNative(db: Database.Database, action: string, subjectType: string, subjectRef: string, evidence: unknown, now: string) {
  db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?, 'NATIVE_PAYMENTS',?,?,?,?,?)`)
    .run(randomUUID(), action, subjectType, subjectRef, JSON.stringify(evidence), now);
}

type OrderContext = {
  order_id: string; public_id: string; customer_id: string; order_state: string; total_kopecks: number; snapshot_hash: string;
  checkout_snapshot_json: string; line_id: string; unit_amount_kopecks: number; fiscal_item_json: string | null; kind: ProductKind;
  course_ref: string | null; email_normalized: string; refref_attempt_id: string | null; has_attempt: number | null;
};
const orderContext = (db: Database.Database, orderPublicId: string) => db.prepare(`SELECT orders.id AS order_id,orders.public_id,
    orders.customer_id,orders.state AS order_state,orders.total_kopecks,orders.snapshot_hash,orders.checkout_snapshot_json,line.id AS line_id,
    line.unit_amount_kopecks,line.fiscal_item_json,product.kind,product.course_ref,customer.email_normalized,attempt.refref_attempt_id,
    attempt.id IS NOT NULL AS has_attempt
  FROM orders JOIN order_lines line ON line.order_id=orders.id JOIN products product ON product.id=line.product_id
  JOIN customers customer ON customer.id=orders.customer_id LEFT JOIN checkout_attempts attempt ON attempt.order_id=orders.id
  WHERE orders.public_id=?`).get(orderPublicId) as OrderContext | undefined;

export type NativePaymentRow = {
  id: string; order_id: string; payment_ref: string; idempotency_key: string; amount_kopecks: number; snapshot_hash: string;
  state: NativePaymentState; provider_payment_id: string | null; payment_url: string | null; request_envelope: string | null;
  envelope_key_id: string | null; created_at: string; updated_at: string;
};
const paymentById = (db: Database.Database, id: string) => db.prepare("SELECT * FROM native_payments WHERE id=?").get(id) as NativePaymentRow | undefined;
const paymentOfOrder = (db: Database.Database, orderId: string) =>
  db.prepare("SELECT * FROM native_payments WHERE order_id=?").get(orderId) as NativePaymentRow | undefined;
const orderOfPayment = (db: Database.Database, payment: NativePaymentRow) =>
  orderContext(db, (db.prepare("SELECT public_id FROM orders WHERE id=?").get(payment.order_id) as { public_id: string }).public_id)!;

type FiscalItem = { name: string; quantity: 1; amountKopecks: number; vatCode: string; paymentMethod: string; paymentObject: string; lineRef?: string };
const fiscalItemOf = (order: OrderContext): FiscalItem => {
  if (!order.fiscal_item_json) throw new Error("NATIVE_FISCAL_ITEM_MISSING");
  return JSON.parse(order.fiscal_item_json) as FiscalItem;
};

/** Fiscal content and the contact for one receipt, sealed under this event's own row id. */
export function insertFiscalEvent(db: Database.Database, keyring: RefundEnvelopeKeyring, input: {
  kind: "PAYMENT_RECEIPT" | "REFUND_RECEIPT" | "FINAL_SETTLEMENT"; orderLineId: string; refundRequestId?: string; refundRequestPublicId?: string;
  paymentMethod: "FULL_PAYMENT" | "FULL_PREPAYMENT"; amountKopecks: number; items: unknown[]; mode: FiscalizationMode;
  state: FiscalEventState; receiptEmail: string | null; evidence?: unknown; now: string;
}) {
  const id = randomUUID();
  const sealed = input.receiptEmail ? sealPayload(keyring, "fiscal-contact", id, { kind: "EMAIL", value: input.receiptEmail }) : null;
  db.prepare(`INSERT INTO fiscal_events(id,event_ref,kind,order_line_id,refund_request_id,payment_method,amount_kopecks,items_json,mode,state,
      evidence_json,sealed_contact,contact_key_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_ref) DO NOTHING`).run(id, fiscalEventRef(input.kind, input.orderLineId, input.refundRequestPublicId), input.kind,
    input.orderLineId, input.refundRequestId ?? null, input.paymentMethod, input.amountKopecks, JSON.stringify(input.items), input.mode, input.state,
    input.evidence === undefined ? null : JSON.stringify(input.evidence), sealed?.sealed ?? null, sealed?.keyId ?? null, input.now, input.now);
}

/** Stages the sealed request with the order. The enclosing checkout transaction owns the commit. */
function stageNativePayment(db: Database.Database, ctx: NativeLedgerContext, orderPublicId: string) {
  const now = clock(ctx);
  return db.transaction(() => {
    const order = orderContext(db, orderPublicId);
    if (!order) throw new Error("ORDER_NOT_FOUND");
    if (order.has_attempt) throw new Error("PAYMENT_CONTOUR_AMBIGUOUS");
    const existing = paymentOfOrder(db, order.order_id);
    if (existing) return { payment: existing, created: false };
    if (order.order_state !== "PAYMENT_PENDING") throw new Error("NATIVE_PAYMENT_ORDER_NOT_PAYABLE");
    // A closed storefront leaves no payment row and calls no provider (owner directive v4.8, item 4).
    if (!ctx.mayInitiate(order.kind, order.public_id)) throw new Error("NATIVE_PAYMENT_INITIATION_STOPPED");
    if (order.total_kopecks <= 0 || order.unit_amount_kopecks !== order.total_kopecks) throw new Error("NATIVE_PAYMENT_AMOUNT_INVALID");
    const item = fiscalItemOf(order);
    // Refused before any money: a combination the contract cannot fiscalize never becomes a payment (I8).
    paymentReceiptMethod(order.kind, item.paymentMethod);
    const purpose = (JSON.parse(order.checkout_snapshot_json) as { paymentPurpose?: string }).paymentPurpose;
    if (!purpose) throw new Error("NATIVE_PAYMENT_PURPOSE_REQUIRED");
    const keys = paymentKeys(order.public_id);
    const id = randomUUID();
    const request: FrozenNativePaymentRequest = {
      idempotencyKey: keys.idempotencyKey, paymentRef: keys.paymentRef, merchantOrderRef: order.public_id, amountKopecks: order.total_kopecks,
      currency: "RUB", snapshotHash: order.snapshot_hash, purpose, receiptEmail: order.email_normalized, fiscalItems: [item],
    };
    const sealed = sealPayload(ctx.keyring, "native-payment-envelope", id, request);
    db.prepare(`INSERT INTO native_payments(id,order_id,payment_ref,idempotency_key,amount_kopecks,snapshot_hash,state,request_envelope,
      envelope_key_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'CREATING',?,?,?,?)`)
      .run(id, order.order_id, keys.paymentRef, keys.idempotencyKey, order.total_kopecks, order.snapshot_hash, sealed.sealed, sealed.keyId, now, now);
    return { payment: paymentById(db, id)!, created: true };
  }).immediate();
}

async function dispatchNativePayment(db: Database.Database, ctx: NativeLedgerContext, orderPublicId: string) {
  const order = orderContext(db, orderPublicId);
  const payment = order && paymentOfOrder(db, order.order_id);
  if (!order || !payment) throw new Error("NATIVE_PAYMENT_NOT_FOUND");
  const start = beginPayment({ mayInitiate: ctx.mayInitiate(order.kind, orderPublicId) });
  if (payment.state === "CREATING" && start.effects.includes("PROVIDER_CREATE")) await sendCreate(db, ctx, payment.id);
  const current = paymentById(db, payment.id)!;
  return { orderPublicId, state: current.state, paymentUrl: current.payment_url };
}

export async function startNativePayment(db: Database.Database, ctx: NativeLedgerContext, orderPublicId: string) {
  const begun = stageNativePayment(db, ctx, orderPublicId);
  return begun.created
    ? dispatchNativePayment(db, ctx, orderPublicId)
    : { orderPublicId, state: begun.payment.state, paymentUrl: begun.payment.payment_url };
}

/**
 * One drive of a payment may replay an unanswered create at most this many times; further retries
 * belong to the sweep. Without a shared budget a provider that keeps losing answers would recurse
 * create → LOST → NOT_FOUND → replay forever inside one request.
 */
type ReplayBudget = { replays: number };
const replayBudget = (): ReplayBudget => ({ replays: 1 });

async function sendCreate(db: Database.Database, ctx: NativeLedgerContext, paymentId: string, budget: ReplayBudget = replayBudget()) {
  const row = paymentById(db, paymentId)!;
  if (!row.request_envelope || !row.envelope_key_id) throw new Error("NATIVE_PAYMENT_ENVELOPE_MISSING");
  const request = openPayload<FrozenNativePaymentRequest>(ctx.keyring, "native-payment-envelope", row.envelope_key_id, row.id, row.request_envelope);
  let observation: PaymentObservation;
  try {
    const answer = await ctx.provider.createPayment(request);
    observation = answer.outcome === "ACCEPTED"
      ? { source: "CREATE_RESPONSE", outcome: "ACCEPTED", providerPaymentId: answer.providerPaymentId }
      : { source: "CREATE_RESPONSE", outcome: "REFUSED", code: answer.code };
    if (answer.outcome === "ACCEPTED" && answer.paymentUrl) {
      db.prepare("UPDATE native_payments SET payment_url=COALESCE(payment_url,?) WHERE id=?").run(answer.paymentUrl, paymentId);
    }
  } catch {
    observation = { source: "CREATE_RESPONSE", outcome: "LOST" };
  }
  await driveNativePayment(db, ctx, paymentId, applyNativePaymentObservation(db, ctx, paymentId, observation), budget);
}

async function readBack(ctx: NativeLedgerContext, merchantOrderRef: string): Promise<PaymentObservation> {
  try {
    const found = await ctx.provider.readPaymentByOrder(merchantOrderRef);
    return found.outcome === "NOT_FOUND" ? { source: "READ_BACK", outcome: "NOT_FOUND" } : {
      source: "READ_BACK", outcome: "FOUND", providerPaymentId: found.providerPaymentId, status: found.status, merchantOrderRef: found.merchantOrderRef,
      amountKopecks: found.amountKopecks, currency: found.currency, snapshotHash: found.snapshotHash,
    };
  } catch {
    return { source: "READ_BACK", outcome: "UNAVAILABLE" };
  }
}

/** Performs the external effects of a decision (read-back, replay) until none remain. */
export async function driveNativePayment(db: Database.Database, ctx: NativeLedgerContext, paymentId: string, first: PaymentDecision,
  budget: ReplayBudget = replayBudget()) {
  let decision = first;
  for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
    if (decision.effects.includes("REPLAY_CREATE_SAME_KEY")) {
      // Admission is read again at the moment of sending; a stop since the decision keeps it unknown.
      const order = orderOfPayment(db, paymentById(db, paymentId)!);
      if (!ctx.mayInitiate(order.kind, order.public_id)) return decision;
      if (budget.replays <= 0) return decision;
      budget.replays -= 1;
      await sendCreate(db, ctx, paymentId, budget);
      return { ...decision, effects: [] };
    }
    if (!decision.effects.includes("READ_BACK")) return decision;
    const order = orderOfPayment(db, paymentById(db, paymentId)!);
    decision = applyNativePaymentObservation(db, ctx, paymentId, await readBack(ctx, order.public_id));
  }
  return decision;
}

/** One observation, applied with its in-database effects in a single transaction (contract I5). */
export function applyNativePaymentObservation(db: Database.Database, ctx: NativeLedgerContext, paymentId: string, observation: PaymentObservation) {
  const now = clock(ctx);
  return db.transaction(() => {
    const payment = paymentById(db, paymentId);
    if (!payment) throw new Error("NATIVE_PAYMENT_NOT_FOUND");
    const order = orderOfPayment(db, payment);
    const decision = applyPaymentObservation({ state: payment.state, providerPaymentId: payment.provider_payment_id },
      { merchantOrderRef: order.public_id, amountKopecks: payment.amount_kopecks, currency: "RUB", snapshotHash: payment.snapshot_hash },
      observation, { mayInitiate: ctx.mayInitiate(order.kind, order.public_id), kind: order.kind, fiscalizationMode: ctx.fiscalizationMode });
    const terminal = decision.state === "PAID" || decision.state === "DECLINED" || decision.state === "EXPIRED";
    const envelope = terminal && payment.request_envelope && payment.envelope_key_id
      ? openPayload<FrozenNativePaymentRequest>(ctx.keyring, "native-payment-envelope", payment.envelope_key_id, payment.id, payment.request_envelope)
      : undefined;
    // The terminal state and the purge of the sealed request are one statement (0036 trigger).
    db.prepare(`UPDATE native_payments SET state=?,provider_payment_id=COALESCE(provider_payment_id,?),last_reason=?,updated_at=?,
      request_envelope=CASE WHEN ? THEN NULL ELSE request_envelope END,
      envelope_purged_at=CASE WHEN ? AND request_envelope IS NOT NULL THEN ? ELSE envelope_purged_at END WHERE id=?`)
      .run(decision.state, decision.providerPaymentId, decision.reason ?? null, now, terminal ? 1 : 0, terminal ? 1 : 0, now, payment.id);
    db.prepare(`INSERT INTO native_payment_observations(id,native_payment_id,source,observation_json,decided_state,reason,observed_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), payment.id, observation.source, JSON.stringify(observation), decision.state, decision.reason ?? null, now);
    const item = order.fiscal_item_json ? fiscalItemOf(order) : undefined;
    for (const effect of decision.effects) {
      if (effect === "GRANT") {
        db.prepare("UPDATE orders SET state='FULFILLED',updated_at=? WHERE id=?").run(now, order.order_id);
        if (order.kind === "LAB") issueLabTicket(db, order.line_id, now);
        if (order.kind === "ONLINE_COURSE") grantEntitlement(db, { customerId: order.customer_id, scope: "COURSE", courseRef: order.course_ref!, sourceOrderLineId: order.line_id }, now);
        if (order.kind === "COURSE_BUNDLE") grantEntitlement(db, { customerId: order.customer_id, scope: "ALL_COURSES", sourceOrderLineId: order.line_id }, now);
        if (ctx.fiscalizationMode === "PROVIDER") {
          // The provider fiscalized the payment itself; its record here is evidence, not a submission.
          insertFiscalEvent(db, ctx.keyring, { kind: "PAYMENT_RECEIPT", orderLineId: order.line_id, paymentMethod: paymentReceiptMethod(order.kind, item!.paymentMethod),
            amountKopecks: payment.amount_kopecks, items: [item], mode: "PROVIDER", state: "NOT_REQUIRED", receiptEmail: null,
            evidence: { providerPaymentId: decision.providerPaymentId }, now });
        }
      } else if (effect === "ISSUE_PAYMENT_RECEIPT") {
        insertFiscalEvent(db, ctx.keyring, { kind: "PAYMENT_RECEIPT", orderLineId: order.line_id, paymentMethod: paymentReceiptMethod(order.kind, item!.paymentMethod),
          amountKopecks: payment.amount_kopecks, items: [item], mode: "MERCHANT", state: "SUBMITTING", receiptEmail: envelope?.receiptEmail ?? order.email_normalized, now });
      } else if (effect === "RESERVE_FINAL_SETTLEMENT") {
        // §6.1: the contact for the closing receipt is copied, sealed, before the payment's envelope goes.
        insertFiscalEvent(db, ctx.keyring, { kind: "FINAL_SETTLEMENT", orderLineId: order.line_id, paymentMethod: "FULL_PAYMENT",
          amountKopecks: payment.amount_kopecks, items: [{ ...item, paymentMethod: "FULL_PAYMENT" }], mode: ctx.fiscalizationMode, state: "AWAITING_SERVICE",
          receiptEmail: envelope?.receiptEmail ?? order.email_normalized, now });
      } else if (effect === "ALERT") {
        auditNative(db, "NATIVE_PAYMENT_REVIEW_REQUIRED", "ORDER", order.public_id, { reason: decision.reason, observation }, now);
      }
    }
    // A provider-terminal non-payment closes the order; a LAB seat counts only while the order is open
    // (lab-occurrences.ts), so this is also RELEASE_HOLD.
    if ((decision.state === "DECLINED" || decision.state === "EXPIRED") && payment.state !== decision.state) {
      db.prepare("UPDATE orders SET state=?,updated_at=? WHERE id=? AND state='PAYMENT_PENDING'")
        .run(decision.state === "EXPIRED" ? "EXPIRED" : "CANCELLED", now, order.order_id);
    }
    // The consumed purchase intent mirrors the payment, as applyRailProjection does on the RC.2 contour,
    // so checkout's open-payment admission and intent replacement see the native outcome.
    db.prepare("UPDATE checkout_quotes SET state=?,updated_at=? WHERE order_public_id=? AND consumed_at IS NOT NULL AND state<>'PAID'")
      .run(INTENT_STATE[decision.state], now, order.public_id);
    if (decision.state === "REVIEW_REQUIRED" && payment.state !== "REVIEW_REQUIRED") {
      db.prepare("UPDATE orders SET state='REVIEW_REQUIRED',updated_at=? WHERE id=? AND state<>'REFUNDED'").run(now, order.order_id);
    }
    return decision;
  }).immediate();
}

/** The sweep: every unsettled payment is read back, whether or not a callback arrived. */
export async function reconcilePendingNativePayments(db: Database.Database, ctx: NativeLedgerContext) {
  const now = clock(ctx);
  const rows = db.prepare(`SELECT id FROM native_payments WHERE state IN ('CREATE_UNKNOWN','PENDING')
      OR (state='CREATING' AND julianday(?) - julianday(created_at) >= ? / 86400000.0)
    ORDER BY updated_at LIMIT 100`).all(now, NATIVE_CREATING_UNANSWERED_AFTER_MS) as { id: string }[];
  let reconciled = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      await driveNativePayment(db, ctx, id, { state: paymentById(db, id)!.state, providerPaymentId: null, effects: ["READ_BACK"] });
      reconciled += 1;
    } catch {
      failed += 1;
    }
  }
  return { selected: rows.length, reconciled, failed };
}

// ─── Read models for checkout (FLEX-122), LAB, refunds and erasure ──────────────────────────────────

export function contourOfOrder(db: Database.Database, orderPublicId: string) {
  const row = db.prepare(`SELECT payment.payment_ref,attempt.refref_attempt_id FROM orders LEFT JOIN native_payments payment ON payment.order_id=orders.id
    LEFT JOIN checkout_attempts attempt ON attempt.order_id=orders.id WHERE orders.public_id=?`).get(orderPublicId) as
    { payment_ref: string | null; refref_attempt_id: string | null } | undefined;
  if (!row) throw new Error("ORDER_NOT_FOUND");
  return routeContour({ nativePaymentRef: row.payment_ref, refrefAttemptId: row.refref_attempt_id });
}

/** The §8 order status DTO (shared-DTO request pending with the coordinator). */
export function nativeOrderStatus(db: Database.Database, orderPublicId: string) {
  const order = orderContext(db, orderPublicId);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  const payment = paymentOfOrder(db, order.order_id);
  if (!payment) throw new Error("NATIVE_PAYMENT_NOT_FOUND");
  const refund = db.prepare(`SELECT refund.state FROM native_refunds refund WHERE refund.native_payment_id=? ORDER BY refund.created_at DESC LIMIT 1`)
    .get(payment.id) as { state: NativeRefundState } | undefined;
  return {
    orderPublicId, contour: "NATIVE" as const, payment: buyerPaymentStatus(payment.state, order.kind),
    ...(payment.state === "PENDING" && payment.payment_url ? { paymentUrl: payment.payment_url } : {}),
    ...(refund ? { refund: buyerRefundStatus(refund.state) } : {}),
    ...(payment.state === "REVIEW_REQUIRED" ? { supportReference: payment.payment_ref } : {}),
  };
}

/** Erasure admission for one customer (contract §11): blocked while any native operation is unfinished. */
export function nativeErasureAdmission(db: Database.Database, customerId: string) {
  const pick = <T>(sql: string) => (db.prepare(sql).all(customerId) as { state: T }[]).map(({ state }) => state);
  return admitErasure({
    payments: pick<NativePaymentState>(`SELECT payment.state FROM native_payments payment JOIN orders ON orders.id=payment.order_id WHERE orders.customer_id=?`),
    refunds: pick<NativeRefundState>(`SELECT refund.state FROM native_refunds refund JOIN refund_requests request ON request.id=refund.refund_request_id
      WHERE request.customer_id=?`),
    fiscalEvents: pick<FiscalEventState>(`SELECT event.state FROM fiscal_events event JOIN order_lines line ON line.id=event.order_line_id
      JOIN orders ON orders.id=line.order_id WHERE orders.customer_id=?`),
  });
}

/** The confirm hook checkout.ts takes on the native contour (structural NativeConfirm). */
export function nativeConfirm(db: Database.Database, ctx: NativeLedgerContext) {
  const status = (orderPublicId: string) => {
    const order = orderContext(db, orderPublicId);
    const payment = order && paymentOfOrder(db, order.order_id);
    if (!payment) throw new Error("NATIVE_PAYMENT_NOT_FOUND");
    return { orderPublicId, state: payment.state as string, paymentUrl: payment.state === "PENDING" ? payment.payment_url : null };
  };
  return {
    stage: (orderPublicId: string) => { stageNativePayment(db, ctx, orderPublicId); },
    dispatch: (orderPublicId: string) => dispatchNativePayment(db, ctx, orderPublicId),
    status,
  };
}
