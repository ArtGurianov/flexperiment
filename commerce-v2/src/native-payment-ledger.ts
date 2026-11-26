import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { grantEntitlement } from "./entitlements";
import { issueLabTicket } from "./lab-tickets";
import {
  admitErasure, applyPaymentObservation, buyerPaymentStatus, buyerRefundStatus, fiscalEventRef, paymentKeys, paymentReceiptMethod,
  routeContour, type FiscalEventState, type FiscalizationMode, type NativePaymentState, type NativeRefundState, type PaymentDecision,
  type PaymentObservation, type ProductKind,
} from "./native-payment-contract";
import { NativeReadBackError, NativeReadBackUnavailable } from "./native-payment-provider";
import type { FrozenNativePaymentRequest, NativePaymentProvider, PaymentReadKey } from "./native-payment-provider";
import { openPayload, sealPayload, type RefundEnvelopeKeyring } from "./refund-envelope";

/**
 * FLEX-119 · the durable native payment ledger (contract §3). Every observation is applied in one
 * SQLite transaction together with the effects the contract assigns to it (grant, ticket, fiscal event
 * creation, order state); external effects (read-back, replay) are performed after commit by the
 * driver. Nothing here imports or calls Refref.
 */
export type NativeLedgerContext = {
  readonly provider: NativePaymentProvider;
  readonly historicalProviders?: readonly NativePaymentProvider[];
  readonly keyring: RefundEnvelopeKeyring;
  readonly fiscalizationMode: FiscalizationMode;
  /** Sales admission (storefront switch + FLEX-90) for the order's storefront, read at each new-money send. */
  readonly mayInitiate: (kind: ProductKind, orderPublicId: string) => boolean;
  readonly now?: () => string;
};

export const executorKey = (provider: NativePaymentProvider) => provider.executorKey ?? provider.name;

export const findNativeProvider = (ctx: NativeLedgerContext, key: string) =>
  [ctx.provider, ...(ctx.historicalProviders ?? [])].find(candidate => executorKey(candidate) === key);

export function nativeProviderForPayment(ctx: NativeLedgerContext, key: string) {
  const provider = findNativeProvider(ctx, key);
  if (!provider) throw new Error("NATIVE_ORIGINAL_EXECUTOR_UNAVAILABLE");
  return provider;
}

const INTENT_STATE: Record<NativePaymentState, string> = {
  CREATING: "PAYMENT_CREATING", CREATE_UNKNOWN: "UNCERTAIN", PENDING: "PENDING", PAID: "PAID", DECLINED: "DECLINED", EXPIRED: "EXPIRED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
};

/** A CREATING row younger than this may still be in flight in another request; the sweep leaves it. */
export const NATIVE_CREATING_UNANSWERED_AFTER_MS = 60_000;
const MAX_DRIVE_STEPS = 6;
const READ_BACK_ALERT_AFTER_MS = 60 * 60_000;

const clock = (ctx: Pick<NativeLedgerContext, "now">) => (ctx.now ? ctx.now() : new Date().toISOString());

export function auditNative(db: Database.Database, action: string, subjectType: string, subjectRef: string, evidence: unknown, now: string) {
  db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?, 'NATIVE_PAYMENTS',?,?,?,?,?)`)
    .run(randomUUID(), action, subjectType, subjectRef, JSON.stringify(evidence), now);
}

/** Call in the immediate transaction that applies the read-back observation. */
export function auditStalledNativeReadBack(db: Database.Database,
  action: "NATIVE_PAYMENT_READ_BACK_STALLED" | "NATIVE_REFUND_READ_BACK_STALLED",
  subjectType: "ORDER" | "REFUND_REQUEST", subjectRef: string, reason: string, createdAt: string, now: string) {
  const ageMs = Date.parse(now) - Date.parse(createdAt);
  if (!Number.isFinite(ageMs) || ageMs < READ_BACK_ALERT_AFTER_MS) return;
  if (!db.prepare("SELECT 1 FROM audit_log WHERE action=? AND subject_type=? AND subject_ref=? LIMIT 1")
    .get(action, subjectType, subjectRef)) {
    auditNative(db, action, subjectType, subjectRef, { reason }, now);
  }
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
  executor_key: string; fiscalization_mode: FiscalizationMode | null;
  dispatch_started: 0 | 1; last_reason: string | null;
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
function stageNativePayment(db: Database.Database, ctx: NativeLedgerContext, orderPublicId: string, successUrl?: string) {
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
    const snapshot = JSON.parse(order.checkout_snapshot_json) as { paymentPurpose?: string; paymentObligations?: { fiscal?: { taxSystem?: string } }[] };
    const purpose = snapshot.paymentPurpose;
    if (!purpose) throw new Error("NATIVE_PAYMENT_PURPOSE_REQUIRED");
    const keys = paymentKeys(order.public_id);
    const id = randomUUID();
    const request: FrozenNativePaymentRequest = {
      idempotencyKey: keys.idempotencyKey, paymentRef: keys.paymentRef, merchantOrderRef: order.public_id, amountKopecks: order.total_kopecks,
      currency: "RUB", snapshotHash: order.snapshot_hash, purpose, taxSystem: snapshot.paymentObligations?.[0]?.fiscal?.taxSystem, receiptEmail: order.email_normalized, fiscalItems: [item],
      ...(successUrl ? { successUrl } : {}),
    };
    const sealed = sealPayload(ctx.keyring, "native-payment-envelope", id, request);
    db.prepare(`INSERT INTO native_payments(id,order_id,payment_ref,idempotency_key,amount_kopecks,snapshot_hash,state,request_envelope,
      envelope_key_id,created_at,updated_at,dispatch_started,executor_key,fiscalization_mode) VALUES (?,?,?,?,?,?,'CREATING',?,?,?,?,0,?,?)`)
      .run(id, order.order_id, keys.paymentRef, keys.idempotencyKey, order.total_kopecks, order.snapshot_hash, sealed.sealed, sealed.keyId, now, now, executorKey(ctx.provider), ctx.fiscalizationMode);
    return { payment: paymentById(db, id)!, created: true };
  }).immediate();
}

async function dispatchNativePayment(db: Database.Database, ctx: NativeLedgerContext, orderPublicId: string, stagedId?: string) {
  const order = orderContext(db, orderPublicId);
  const payment = order && paymentOfOrder(db, order.order_id);
  if (!order || !payment) throw new Error("NATIVE_PAYMENT_NOT_FOUND");
  if (payment.state === "CREATING" && payment.id === stagedId) await sendCreate(db, ctx, payment.id);
  const current = paymentById(db, payment.id)!;
  return { orderPublicId, state: current.state, paymentUrl: current.payment_url };
}

export async function startNativePayment(db: Database.Database, ctx: NativeLedgerContext, orderPublicId: string) {
  const begun = stageNativePayment(db, ctx, orderPublicId);
  return begun.created
    ? dispatchNativePayment(db, ctx, orderPublicId, begun.payment.id)
    : { orderPublicId, state: begun.payment.state, paymentUrl: begun.payment.payment_url };
}

/**
 * One drive of a payment may replay an unanswered create at most this many times; further retries
 * belong to the sweep. Without a shared budget a provider that keeps losing answers would recurse
 * create → LOST → NOT_FOUND → replay forever inside one request.
 */
type ReplayBudget = { replays: number };
const replayBudget = (): ReplayBudget => ({ replays: 1 });

/** Called under the merchant write lock. A timeout or NOT_FOUND can never establish this fact. */
function expireUnsent(db: Database.Database, order: OrderContext, payment: NativePaymentRow, now: string) {
  if (payment.dispatch_started !== 0 || payment.state !== "CREATING" || payment.provider_payment_id !== null) return false;
  db.prepare(`UPDATE native_payments SET state='EXPIRED',last_reason='PAYMENT_NOT_DISPATCHED',request_envelope=NULL,
    envelope_purged_at=?,updated_at=? WHERE id=?`).run(now, now, payment.id);
  db.prepare("UPDATE orders SET state='EXPIRED',updated_at=? WHERE id=? AND state='PAYMENT_PENDING'").run(now, order.order_id);
  db.prepare(`UPDATE checkout_quotes SET state='EXPIRED',updated_at=? WHERE order_public_id=? AND consumed_at IS NOT NULL AND state<>'PAID'`)
    .run(now, order.public_id);
  auditNative(db, "NATIVE_PAYMENT_NOT_DISPATCHED", "ORDER", order.public_id, { paymentRef: payment.payment_ref }, now);
  return true;
}

async function sendCreate(db: Database.Database, ctx: NativeLedgerContext, paymentId: string, budget: ReplayBudget = replayBudget(), replay = false) {
  const request = db.transaction(() => {
    const row = paymentById(db, paymentId)!;
    if (row.state !== "CREATING" && row.state !== "CREATE_UNKNOWN") return undefined;
    if ((row.dispatch_started === 1) !== replay || (replay && !ctx.provider.replayGuarantees.payment)) return undefined;
    const order = orderOfPayment(db, row);
    if (row.executor_key !== executorKey(ctx.provider) || !ctx.mayInitiate(order.kind, order.public_id)) {
      expireUnsent(db, order, row, clock(ctx));
      return undefined;
    }
    if (!row.request_envelope || !row.envelope_key_id) throw new Error("NATIVE_PAYMENT_ENVELOPE_MISSING");
    const frozen = openPayload<FrozenNativePaymentRequest>(ctx.keyring, "native-payment-envelope", row.envelope_key_id, row.id, row.request_envelope);
    // Commit before the provider call. A crash after this write has an ambiguous outcome.
    if (!replay) db.prepare("UPDATE native_payments SET dispatch_started=1,updated_at=? WHERE id=?").run(clock(ctx), row.id);
    return frozen;
  }).immediate();
  if (!request) return;
  // Hand off while cancellation and storefront changes are serialized by the write lock.
  // Only the handoff is synchronous. The already-committed dispatch marker survives either outcome.
  const handoff = db.transaction(() => {
    const row = paymentById(db, paymentId)!;
    if (row.state !== "CREATING" && row.state !== "CREATE_UNKNOWN") return undefined;
    const order = orderOfPayment(db, row);
    if (row.executor_key !== executorKey(ctx.provider) || !ctx.mayInitiate(order.kind, order.public_id)) return undefined;
    try {
      return { response: ctx.provider.createPayment(request) };
    } catch (error) {
      return { response: Promise.reject(error) };
    }
  }).immediate();
  if (!handoff) return;
  let observation: PaymentObservation;
  let paymentUrl: string | undefined;
  try {
    const answer = await handoff.response;
    observation = answer.outcome === "ACCEPTED"
      ? { source: "CREATE_RESPONSE", outcome: "ACCEPTED", providerPaymentId: answer.providerPaymentId }
      : { source: "CREATE_RESPONSE", outcome: "REFUSED", code: answer.code };
    if (answer.outcome === "ACCEPTED") paymentUrl = answer.paymentUrl;
  } catch {
    observation = { source: "CREATE_RESPONSE", outcome: "LOST" };
  }
  await driveNativePayment(db, ctx, paymentId, applyNativePaymentObservation(db, ctx, paymentId, observation, paymentUrl), budget);
}

async function readBack(provider: NativePaymentProvider | undefined, merchantOrderRef: string, key: PaymentReadKey):
Promise<{ observation: PaymentObservation; paymentUrl?: string }> {
  if (!provider) return { observation: { source: "READ_BACK", outcome: "UNAVAILABLE", code: "NATIVE_ORIGINAL_EXECUTOR_UNAVAILABLE" } };
  try {
    const found = await provider.readPaymentByOrder(merchantOrderRef, key);
    if (found.outcome === "NOT_FOUND") return { observation: { source: "READ_BACK", outcome: "NOT_FOUND" } };
    return { observation: {
      source: "READ_BACK", outcome: "FOUND", providerPaymentId: found.providerPaymentId, status: found.status, merchantOrderRef: found.merchantOrderRef,
      amountKopecks: found.amountKopecks, currency: found.currency, snapshotHash: found.snapshotHash,
    }, paymentUrl: found.status === "PENDING" ? found.paymentUrl : undefined };
  } catch (error) {
    return { observation: error instanceof NativeReadBackError
      ? { source: "READ_BACK", outcome: "REVIEW_REQUIRED", code: error.code }
      : { source: "READ_BACK", outcome: "UNAVAILABLE", ...(error instanceof NativeReadBackUnavailable ? { code: error.code } : {}) } };
  }
}

function safePaymentUrl(value?: string) {
  if (!value || value.length > 2048 || Array.from(value).some(char => char <= " " || char.charCodeAt(0) === 127 || char.charCodeAt(0) === 92)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Performs the external effects of a decision (read-back, replay) until none remain. */
export async function driveNativePayment(db: Database.Database, ctx: NativeLedgerContext, paymentId: string, first: PaymentDecision,
  budget: ReplayBudget = replayBudget(), signal?: AbortSignal) {
  let decision = first;
  for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
    if (decision.effects.includes("REPLAY_CREATE_SAME_KEY")) {
      // Admission is read again at the moment of sending; a stop since the decision keeps it unknown.
      const order = orderOfPayment(db, paymentById(db, paymentId)!);
      if (!ctx.mayInitiate(order.kind, order.public_id)) return decision;
      if (!ctx.provider.replayGuarantees.payment || budget.replays <= 0) return decision;
      budget.replays -= 1;
      await sendCreate(db, ctx, paymentId, budget, true);
      return { ...decision, effects: [] };
    }
    if (!decision.effects.includes("READ_BACK")) return decision;
    const payment = paymentById(db, paymentId)!;
    const order = orderOfPayment(db, payment);
    const read = await readBack(findNativeProvider(ctx, payment.executor_key), order.public_id,
      { snapshotHash: payment.snapshot_hash, providerPaymentId: payment.provider_payment_id, createdAt: payment.created_at, observedAt: clock(ctx), signal });
    decision = applyNativePaymentObservation(db, ctx, paymentId, read.observation, read.paymentUrl, payment);
  }
  return decision;
}

/** One observation, applied with its in-database effects in a single transaction (contract I5). */
export function applyNativePaymentObservation(db: Database.Database, ctx: NativeLedgerContext, paymentId: string,
  observation: PaymentObservation, paymentUrl?: string, beforeRead?: Pick<NativePaymentRow, "state" | "provider_payment_id">) {
  const now = clock(ctx);
  return db.transaction(() => {
    const payment = paymentById(db, paymentId);
    if (!payment) throw new Error("NATIVE_PAYMENT_NOT_FOUND");
    const order = orderOfPayment(db, payment);
    const recovering = observation.source === "READ_BACK" && observation.outcome === "DISPATCH_UNCERTAIN";
    if ((recovering && (payment.dispatch_started !== 0 || payment.state !== "CREATING"))
      || (payment.dispatch_started === 0 && observation.source === "READ_BACK" && !recovering && payment.state !== "CREATE_UNKNOWN")
      || (beforeRead && (payment.state !== beforeRead.state || payment.provider_payment_id !== beforeRead.provider_payment_id))) {
      return { state: payment.state, providerPaymentId: payment.provider_payment_id, effects: [] } satisfies PaymentDecision;
    }
    const fiscalizationMode = payment.fiscalization_mode ?? "MERCHANT";
    let decision = applyPaymentObservation({ state: payment.state, providerPaymentId: payment.provider_payment_id },
      { merchantOrderRef: order.public_id, amountKopecks: payment.amount_kopecks, currency: "RUB", snapshotHash: payment.snapshot_hash },
      observation, { mayInitiate: payment.dispatch_started === 1 && payment.executor_key === executorKey(ctx.provider) && ctx.mayInitiate(order.kind, order.public_id),
        kind: order.kind, fiscalizationMode });
    if (payment.dispatch_started === 0 && decision.state === "CREATE_UNKNOWN" && decision.reason === "PAYMENT_INITIATION_STOPPED") {
      decision = { ...decision, reason: "NATIVE_CREATE_DISPATCH_UNCERTAIN" };
    }
    const terminal = decision.state === "PAID" || decision.state === "DECLINED" || decision.state === "EXPIRED";
    const envelope = terminal && payment.request_envelope && payment.envelope_key_id
      ? openPayload<FrozenNativePaymentRequest>(ctx.keyring, "native-payment-envelope", payment.envelope_key_id, payment.id, payment.request_envelope)
      : undefined;
    const boundUrl = decision.state === "PENDING" && "providerPaymentId" in observation
      && observation.providerPaymentId === decision.providerPaymentId ? safePaymentUrl(paymentUrl) : null;
    // The terminal state and the purge of the sealed request are one statement (0036 trigger).
    db.prepare(`UPDATE native_payments SET state=?,provider_payment_id=COALESCE(provider_payment_id,?),last_reason=?,updated_at=?,
      dispatch_started=CASE WHEN ? THEN 1 ELSE dispatch_started END,
      payment_url=COALESCE(payment_url,?),
      request_envelope=CASE WHEN ? THEN NULL ELSE request_envelope END,
      envelope_purged_at=CASE WHEN ? AND request_envelope IS NOT NULL THEN ? ELSE envelope_purged_at END WHERE id=?`)
      .run(decision.state, decision.providerPaymentId, decision.reason ?? null, now,
        observation.source === "READ_BACK" && observation.outcome === "FOUND" && decision.state !== "REVIEW_REQUIRED" ? 1 : 0,
        boundUrl, terminal ? 1 : 0, terminal ? 1 : 0, now, payment.id);
    const stoppedUnknown = decision.state === "CREATE_UNKNOWN" && ["PAYMENT_INITIATION_STOPPED", "NATIVE_CREATE_DISPATCH_UNCERTAIN"].includes(decision.reason ?? "");
    if (decision.reason === "NATIVE_ORIGINAL_EXECUTOR_UNAVAILABLE" && decision.reason !== payment.last_reason) {
      auditNative(db, "NATIVE_PAYMENT_READ_BACK_UNAVAILABLE", "ORDER", order.public_id, { reason: decision.reason }, now);
    }
    if ((decision.state === "PENDING" || decision.state === "CREATE_UNKNOWN")
      && observation.source === "READ_BACK" && observation.outcome === "UNAVAILABLE") {
      auditStalledNativeReadBack(db, "NATIVE_PAYMENT_READ_BACK_STALLED", "ORDER", order.public_id,
        observation.code ?? "READ_BACK_UNAVAILABLE", payment.created_at, now);
    }
    if (stoppedUnknown && payment.last_reason !== decision.reason) {
      auditNative(db, "NATIVE_PAYMENT_REVIEW_REQUIRED", "ORDER", order.public_id, { reason: decision.reason }, now);
    }
    if (!stoppedUnknown || payment.last_reason !== decision.reason) db.prepare(`INSERT INTO native_payment_observations(id,native_payment_id,source,observation_json,decided_state,reason,observed_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), payment.id, observation.source, JSON.stringify(observation), decision.state, decision.reason ?? null, now);
    const item = order.fiscal_item_json ? fiscalItemOf(order) : undefined;
    for (const effect of decision.effects) {
      if (effect === "GRANT") {
        db.prepare("UPDATE orders SET state='FULFILLED',updated_at=? WHERE id=?").run(now, order.order_id);
        if (order.kind === "LAB") issueLabTicket(db, order.line_id, now);
        if (order.kind === "ONLINE_COURSE") grantEntitlement(db, { customerId: order.customer_id, scope: "COURSE", courseRef: order.course_ref!, sourceOrderLineId: order.line_id }, now);
        if (order.kind === "COURSE_BUNDLE") grantEntitlement(db, { customerId: order.customer_id, scope: "ALL_COURSES", sourceOrderLineId: order.line_id }, now);
        if (fiscalizationMode === "PROVIDER") {
          const automatic = nativeProviderForPayment(ctx, payment.executor_key).readAutomaticReceipt;
          // An automatic receipt still needs its own fiscal read-back.
          insertFiscalEvent(db, ctx.keyring, { kind: "PAYMENT_RECEIPT", orderLineId: order.line_id, paymentMethod: paymentReceiptMethod(order.kind, item!.paymentMethod),
            amountKopecks: payment.amount_kopecks, items: [item], mode: "PROVIDER", state: automatic ? "PENDING" : "NOT_REQUIRED", receiptEmail: null,
            evidence: { providerPaymentId: decision.providerPaymentId }, now });
        }
      } else if (effect === "ISSUE_PAYMENT_RECEIPT") {
        insertFiscalEvent(db, ctx.keyring, { kind: "PAYMENT_RECEIPT", orderLineId: order.line_id, paymentMethod: paymentReceiptMethod(order.kind, item!.paymentMethod),
          amountKopecks: payment.amount_kopecks, items: [item], mode: "MERCHANT", state: "SUBMITTING", receiptEmail: envelope?.receiptEmail ?? order.email_normalized, now });
      } else if (effect === "RESERVE_FINAL_SETTLEMENT") {
        // §6.1: the contact for the closing receipt is copied, sealed, before the payment's envelope goes.
        insertFiscalEvent(db, ctx.keyring, { kind: "FINAL_SETTLEMENT", orderLineId: order.line_id, paymentMethod: "FULL_PAYMENT",
          amountKopecks: payment.amount_kopecks, items: [{ ...item, paymentMethod: "FULL_PAYMENT" }], mode: fiscalizationMode, state: "AWAITING_SERVICE",
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

/** A zero marker in a persisted row is insufficient to send to an executor without replay protection. */
function paymentReadOnlyRecovery(db: Database.Database, ctx: NativeLedgerContext, payment: NativePaymentRow) {
  if (payment.dispatch_started === 0 && payment.state === "CREATING") {
    return applyNativePaymentObservation(db, ctx, payment.id, { source: "READ_BACK", outcome: "DISPATCH_UNCERTAIN" });
  }
  return { state: payment.state, providerPaymentId: payment.provider_payment_id, effects: ["READ_BACK"] } satisfies PaymentDecision;
}

/** Cancellation and recovery can read back money without authorizing any create. */
export async function reconcileNativePaymentWithoutNewCharge(db: Database.Database, ctx: NativeLedgerContext, orderPublicId: string) {
  const order = orderContext(db, orderPublicId);
  const payment = order && paymentOfOrder(db, order.order_id);
  if (!payment) throw new Error("NATIVE_PAYMENT_NOT_FOUND");
  if (payment.state === "PAID") return; // Subsequent refund facts are reconciled separately.
  if (findNativeProvider(ctx, payment.executor_key)?.replayGuarantees.payment
    && db.transaction(() => expireUnsent(db, order, paymentById(db, payment.id)!, clock(ctx))).immediate()) return;
  await driveNativePayment(db, { ...ctx, mayInitiate: () => false }, payment.id, paymentReadOnlyRecovery(db, ctx, payment));
}

/** The sweep: every unsettled payment is read back, whether or not a callback arrived. */
export async function reconcilePendingNativePayments(db: Database.Database, ctx: NativeLedgerContext) {
  const now = clock(ctx);
  const rows = db.prepare(`SELECT id FROM native_payments WHERE state IN ('CREATE_UNKNOWN','PENDING')
      OR (state='CREATING' AND julianday(?) - julianday(updated_at) >= ? / 86400000.0)
    ORDER BY updated_at LIMIT 100`).all(now, NATIVE_CREATING_UNANSWERED_AFTER_MS) as { id: string }[];
  let reconciled = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      const payment = paymentById(db, id)!;
      if (payment.dispatch_started === 0 && payment.state === "CREATING" && findNativeProvider(ctx, payment.executor_key)?.replayGuarantees.payment) {
        await sendCreate(db, ctx, id);
      } else {
        await driveNativePayment(db, ctx, id, paymentReadOnlyRecovery(db, ctx, payment));
      }
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

const BUYER_READ_COOLDOWN_MS = 3_000;
const MAX_BUYER_READ_SLOTS = 256;
const buyerReads = new WeakMap<Database.Database, Map<string, number>>();

/** A buyer can expedite one bounded GET of a known operation. Discovery belongs to the sweep. */
export async function refreshNativeOrderStatus(db: Database.Database, ctx: NativeLedgerContext, orderPublicId: string) {
  const order = orderContext(db, orderPublicId);
  const payment = order && paymentOfOrder(db, order.order_id);
  if (payment?.dispatch_started && payment.provider_payment_id && payment.state === "PENDING") {
    const now = Date.now();
    const recent = buyerReads.get(db) ?? new Map<string, number>();
    buyerReads.set(db, recent);
    for (const [id, until] of recent) if (until <= now) recent.delete(id);
    if (!recent.has(payment.id) && recent.size < MAX_BUYER_READ_SLOTS) {
      recent.set(payment.id, now + BUYER_READ_COOLDOWN_MS);
      try {
        await driveNativePayment(db, { ...ctx, mayInitiate: () => false }, payment.id,
          { state: payment.state, providerPaymentId: payment.provider_payment_id, effects: ["READ_BACK"] },
          replayBudget(), AbortSignal.timeout(2_000));
      } catch {
        // Keep the last durable state. The sweep can repeat the read after a transient failure.
      }
    }
  }
  return nativeOrderStatus(db, orderPublicId);
}

export function nativeOrderStatus(db: Database.Database, orderPublicId: string) {
  const order = orderContext(db, orderPublicId);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  const payment = paymentOfOrder(db, order.order_id);
  if (!payment) throw new Error("NATIVE_PAYMENT_NOT_FOUND");
  const refund = db.prepare(`SELECT refund.state FROM native_refunds refund WHERE refund.native_payment_id=? ORDER BY refund.created_at DESC LIMIT 1`)
    .get(payment.id) as { state: NativeRefundState } | undefined;
  return {
    orderPublicId, kind: order.kind, contour: "NATIVE" as const, payment: buyerPaymentStatus(payment.state, order.kind),
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
  let stagedId: string | undefined;
  return {
    stage: (orderPublicId: string, successUrl?: string) => {
      const staged = stageNativePayment(db, ctx, orderPublicId, successUrl);
      stagedId = staged.created ? staged.payment.id : undefined;
    },
    dispatch: (orderPublicId: string) => {
      const id = stagedId;
      stagedId = undefined;
      return dispatchNativePayment(db, ctx, orderPublicId, id);
    },
    status,
  };
}
