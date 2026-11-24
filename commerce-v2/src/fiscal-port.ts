import type Database from "better-sqlite3";
import {
  admitFinalSettlement, applyFiscalObservation, cancelReservedSettlement, type FiscalAdapterCapabilities, type FiscalEventState,
  type FiscalObservation, type FiscalPaymentMethod, type NativePaymentState, type ProductKind, type ServiceRenderedFact,
} from "./native-payment-contract";
import { auditNative, nativeProviderForPayment, type NativeLedgerContext } from "./native-payment-ledger";
import { openPayload, type RefundEnvelopeKeyring } from "./refund-envelope";

/**
 * FLEX-119 · provider-neutral fiscal port (contract §6, §7). Fiscal events are reconciled separately
 * from money: nothing here grants, revokes, pays or refunds. A real adapter is added only after the
 * provider is confirmed; tests use a fake.
 */
export type FrozenFiscalEvent = {
  readonly eventRef: string;
  readonly kind: "PAYMENT_RECEIPT" | "REFUND_RECEIPT" | "FINAL_SETTLEMENT";
  readonly orderPublicId: string;
  readonly orderLineId: string;
  readonly snapshotHash: string;
  readonly lines: readonly unknown[];
  readonly totalKopecks: number;
  readonly paymentMethod: FiscalPaymentMethod;
  readonly prepayment?: { readonly executor: "NATIVE"; readonly paymentRef: string; readonly receiptRef: string };
  readonly serviceRenderedAt?: string;
  readonly receiptContact: { readonly kind: "EMAIL"; readonly value: string };
};

export type FiscalSubmitAnswer = { readonly outcome: "ACCEPTED"; readonly providerReceiptId: string } | { readonly outcome: "REJECTED"; readonly code: string };
export type FiscalReadBack =
  | { readonly outcome: "NOT_FOUND" }
  | { readonly outcome: "FOUND"; readonly providerReceiptId: string; readonly status: "PROCESSING" | "REGISTERED" | "REJECTED";
    readonly eventRef: string; readonly amountKopecks: number; readonly paymentMethod: FiscalPaymentMethod;
    readonly fiscalSign?: string; readonly issuedAt?: string };

export interface FiscalAdapter {
  readonly capabilities: FiscalAdapterCapabilities;
  /** Idempotent on event.eventRef. Throwing means the answer was lost. */
  submit(event: FrozenFiscalEvent): Promise<FiscalSubmitAnswer>;
  /** Throwing means unavailable. */
  read(eventRef: string): Promise<FiscalReadBack>;
}

/** D's read side for LAB completion (lab_service_renditions, D's migration); C never writes it. */
export type ServiceRenditionReader = {
  readonly fact: (db: Database.Database, orderLineId: string) => ServiceRenderedFact | null;
  readonly occurrenceCancelled: (db: Database.Database, orderLineId: string) => boolean;
};

/** Retention ceiling of a reserved settlement's sealed contact (contract §6.1, proposal). */
export const SETTLEMENT_CONTACT_CEILING_MS = 30 * 24 * 3600 * 1000;

type EventRow = {
  id: string; event_ref: string; kind: FrozenFiscalEvent["kind"]; order_line_id: string; payment_method: FiscalPaymentMethod; amount_kopecks: number;
  items_json: string; mode: "PROVIDER" | "MERCHANT"; state: FiscalEventState; provider_receipt_id: string | null; evidence_json: string | null;
  sealed_contact: string | null; contact_key_id: string | null; order_public_id: string; snapshot_hash: string; kind_of_product: ProductKind;
  occurrence_ref: string | null; ends_at: string | null; order_id: string;
};
const eventRow = (db: Database.Database, id: string) => db.prepare(`SELECT event.*,orders.public_id AS order_public_id,orders.snapshot_hash,
    orders.id AS order_id,product.kind AS kind_of_product,product.occurrence_ref,occurrence.ends_at
  FROM fiscal_events event JOIN order_lines line ON line.id=event.order_line_id JOIN orders ON orders.id=line.order_id
  JOIN products product ON product.id=line.product_id LEFT JOIN lab_occurrences occurrence ON occurrence.occurrence_ref=product.occurrence_ref
  WHERE event.id=?`).get(id) as EventRow | undefined;

const TERMINAL: readonly FiscalEventState[] = ["REGISTERED", "REJECTED", "NOT_REQUIRED", "CANCELLED"];

function setState(db: Database.Database, row: EventRow, state: FiscalEventState, providerReceiptId: string | null, reason: string | undefined,
  evidence: unknown, now: string) {
  const purge = TERMINAL.includes(state);
  // A terminal state and the purge of the sealed contact are one statement (0036 trigger).
  db.prepare(`UPDATE fiscal_events SET state=?,provider_receipt_id=COALESCE(provider_receipt_id,?),last_reason=?,updated_at=?,
    evidence_json=COALESCE(?,evidence_json),sealed_contact=CASE WHEN ? THEN NULL ELSE sealed_contact END,
    contact_purged_at=CASE WHEN ? AND sealed_contact IS NOT NULL THEN ? ELSE contact_purged_at END WHERE id=?`)
    .run(state, providerReceiptId, reason ?? null, now, evidence === undefined ? null : JSON.stringify(evidence), purge ? 1 : 0, purge ? 1 : 0, now, row.id);
  if (state === "REVIEW_REQUIRED" || state === "REJECTED") auditNative(db, "FISCAL_EVENT_REVIEW_REQUIRED", "FISCAL_EVENT", row.event_ref, { state, reason }, now);
}

function frozenEvent(db: Database.Database, keyring: RefundEnvelopeKeyring, row: EventRow): FrozenFiscalEvent {
  if (!row.sealed_contact || !row.contact_key_id) throw new Error("FISCAL_CONTACT_MISSING");
  const contact = openPayload<{ kind: "EMAIL"; value: string }>(keyring, "fiscal-contact", row.contact_key_id, row.id, row.sealed_contact);
  const evidence = row.evidence_json ? JSON.parse(row.evidence_json) as { serviceRenderedAt?: string } : {};
  const prepayment = row.kind === "FINAL_SETTLEMENT" ? db.prepare(`SELECT payment.payment_ref,receipt.provider_receipt_id FROM native_payments payment
      JOIN fiscal_events receipt ON receipt.order_line_id=? AND receipt.kind='PAYMENT_RECEIPT' WHERE payment.order_id=?`)
    .get(row.order_line_id, row.order_id) as { payment_ref: string; provider_receipt_id: string } | undefined : undefined;
  return {
    eventRef: row.event_ref, kind: row.kind, orderPublicId: row.order_public_id, orderLineId: row.order_line_id, snapshotHash: row.snapshot_hash,
    lines: JSON.parse(row.items_json) as unknown[], totalKopecks: row.amount_kopecks, paymentMethod: row.payment_method, receiptContact: contact,
    ...(prepayment ? { prepayment: { executor: "NATIVE" as const, paymentRef: prepayment.payment_ref, receiptRef: prepayment.provider_receipt_id } } : {}),
    ...(evidence.serviceRenderedAt ? { serviceRenderedAt: evidence.serviceRenderedAt } : {}),
  };
}

/** Provider-issued receipts are observed independently; this path has no submission capability. */
export async function reconcileAutomaticNativeReceipts(db: Database.Database, ledger: NativeLedgerContext) {
  const rows = db.prepare(`SELECT f.id,f.kind,p.executor_key,p.provider_payment_id,r.provider_refund_id
    FROM fiscal_events f JOIN order_lines l ON l.id=f.order_line_id
    JOIN native_payments p ON p.order_id=l.order_id
    LEFT JOIN native_refunds r ON r.refund_request_id=f.refund_request_id
    WHERE f.mode='PROVIDER' AND f.state='PENDING' AND f.kind IN ('PAYMENT_RECEIPT','REFUND_RECEIPT')
    ORDER BY f.updated_at LIMIT 100`).all() as {
    id: string; kind: "PAYMENT_RECEIPT" | "REFUND_RECEIPT"; executor_key: string;
    provider_payment_id: string; provider_refund_id: string | null;
  }[];
  const now = ledger.now?.() ?? new Date().toISOString();
  let failed = 0;
  for (const binding of rows) {
    try {
      const provider = nativeProviderForPayment(ledger, binding.executor_key);
      if (!provider.readAutomaticReceipt || (binding.kind === "REFUND_RECEIPT" && !binding.provider_refund_id)) {
        throw new Error("NATIVE_RECEIPT_READ_BACK_UNAVAILABLE");
      }
      const result = await provider.readAutomaticReceipt(binding.kind, binding.provider_payment_id, binding.provider_refund_id);
      db.transaction(() => {
        const current = eventRow(db, binding.id)!;
        if (current.state !== "PENDING") return;
        if (result.outcome === "NOT_FOUND") {
          // Processing, or temporarily absent, is still an outstanding receipt.
          db.prepare("UPDATE fiscal_events SET updated_at=?,last_reason=? WHERE id=?").run(now, "RECEIPT_NOT_YET_VISIBLE", binding.id);
          return;
        }
        const { fiscalSign, issuedAt, ...receipt } = result;
        const decision = applyFiscalObservation({ state: current.state, providerReceiptId: current.provider_receipt_id },
          { eventRef: current.event_ref, amountKopecks: current.amount_kopecks, paymentMethod: current.payment_method },
          { ...receipt, source: "READ_BACK" });
        const evidence = decision.state === "REGISTERED" ? { fiscalSign, issuedAt,
          providerPaymentId: binding.provider_payment_id, providerRefundId: binding.provider_refund_id } : undefined;
        setState(db, current, decision.state, decision.providerReceiptId, decision.reason, evidence, now);
      }).immediate();
    } catch {
      failed += 1;
      db.prepare("UPDATE fiscal_events SET updated_at=?,last_reason=? WHERE id=? AND state='PENDING'")
        .run(now, "READ_BACK_UNAVAILABLE", binding.id);
    }
  }
  return { selected: rows.length, failed };
}

async function observe(adapter: FiscalAdapter, eventRef: string): Promise<FiscalObservation> {
  try {
    const found = await adapter.read(eventRef);
    return found.outcome === "NOT_FOUND" ? { source: "READ_BACK", outcome: "NOT_FOUND" } : {
      source: "READ_BACK", outcome: "FOUND", providerReceiptId: found.providerReceiptId, status: found.status, eventRef: found.eventRef,
      amountKopecks: found.amountKopecks, paymentMethod: found.paymentMethod,
    };
  } catch {
    return { source: "READ_BACK", outcome: "UNAVAILABLE" };
  }
}

function applyObservation(db: Database.Database, id: string, observation: FiscalObservation, now: string) {
  return db.transaction(() => {
    const row = eventRow(db, id)!;
    const decision = applyFiscalObservation({ state: row.state, providerReceiptId: row.provider_receipt_id },
      { eventRef: row.event_ref, amountKopecks: row.amount_kopecks, paymentMethod: row.payment_method }, observation);
    if (decision.state !== row.state || decision.providerReceiptId !== row.provider_receipt_id || decision.reason) {
      setState(db, row, decision.state, decision.providerReceiptId, decision.reason, undefined, now);
    }
    return decision;
  }).immediate();
}

/** Admission of a reserved LAB settlement against D's SERVICE_RENDERED fact (contract §7). */
function admitReserved(db: Database.Database, row: EventRow, adapter: FiscalAdapter, renditions: ServiceRenditionReader | undefined, now: string) {
  return db.transaction(() => {
    const current = eventRow(db, row.id)!;
    if (current.state !== "AWAITING_SERVICE") return false;
    if (renditions?.occurrenceCancelled(db, current.order_line_id)) {
      const cancelled = cancelReservedSettlement(current.state, "OCCURRENCE_CANCELLED");
      setState(db, current, cancelled.state, null, cancelled.reason, undefined, now);
      return false;
    }
    const fact = renditions?.fact(db, current.order_line_id) ?? null;
    const payment = db.prepare("SELECT state FROM native_payments WHERE order_id=?").get(current.order_id) as { state: NativePaymentState } | undefined;
    const receipt = db.prepare("SELECT state FROM fiscal_events WHERE order_line_id=? AND kind='PAYMENT_RECEIPT'").get(current.order_line_id) as
      { state: FiscalEventState } | undefined;
    const refund = db.prepare("SELECT 1 FROM refund_requests WHERE order_line_id=? AND state<>'REJECTED'").get(current.order_line_id);
    const admission = admitFinalSettlement({
      kind: current.kind_of_product, paymentState: payment?.state ?? "REVIEW_REQUIRED", paymentReceiptState: receipt?.state ?? null,
      refundOpenOrSucceeded: Boolean(refund), occurrenceCancelled: false, fact, orderLineId: current.order_line_id,
      occurrenceRef: current.occurrence_ref ?? "", capabilities: adapter.capabilities, finalSettlementState: current.state,
    });
    if (admission.admitted) {
      setState(db, current, "SUBMITTING", null, undefined, { serviceRenderedAt: fact!.renderedAt, serviceEvidenceRef: fact!.evidenceRef, basis: fact!.basis }, now);
      return true;
    }
    const overdue = !fact && current.ends_at && Date.parse(now) - Date.parse(current.ends_at) > SETTLEMENT_CONTACT_CEILING_MS;
    if (overdue) setState(db, current, "REVIEW_REQUIRED", null, "SERVICE_RENDERED_OVERDUE", undefined, now);
    else db.prepare("UPDATE fiscal_events SET last_reason=?,updated_at=? WHERE id=?").run(admission.code, now, current.id);
    return false;
  }).immediate();
}

/**
 * The fiscal sweep: reserved settlements are admitted against D's fact; every event in flight is read
 * back first, and only a NOT_FOUND replays the same frozen event under its eventRef.
 */
export async function reconcilePendingFiscalEvents(db: Database.Database, deps: {
  readonly adapter: FiscalAdapter; readonly keyring: RefundEnvelopeKeyring; readonly renditions?: ServiceRenditionReader; readonly now?: () => string;
}) {
  const now = deps.now ? deps.now() : new Date().toISOString();
  const rows = db.prepare(`SELECT id FROM fiscal_events WHERE (mode='MERCHANT' OR kind='FINAL_SETTLEMENT')
    AND state IN ('AWAITING_SERVICE','SUBMITTING','SUBMIT_UNKNOWN','PENDING') ORDER BY updated_at LIMIT 100`).all() as { id: string }[];
  let submitted = 0;
  let failed = 0;
  for (const { id } of rows) {
    const row = eventRow(db, id)!;
    if (!["AWAITING_SERVICE", "SUBMITTING", "SUBMIT_UNKNOWN", "PENDING"].includes(row.state)) continue;
    try {
      if (row.state === "AWAITING_SERVICE" && !admitReserved(db, row, deps.adapter, deps.renditions, now)) continue;
      let decision = applyObservation(db, id, await observe(deps.adapter, row.event_ref), now);
      for (let step = 0; step < 4; step += 1) {
        if (decision.effects.includes("REPLAY_FISCAL_SAME_KEY")) {
          const event = frozenEvent(db, deps.keyring, eventRow(db, id)!);
          let answer: FiscalObservation;
          try {
            const result = await deps.adapter.submit(event);
            answer = result.outcome === "ACCEPTED" ? { source: "SUBMIT_RESPONSE", outcome: "ACCEPTED", providerReceiptId: result.providerReceiptId }
              : { source: "SUBMIT_RESPONSE", outcome: "REJECTED", code: result.code };
          } catch {
            answer = { source: "SUBMIT_RESPONSE", outcome: "LOST" };
          }
          submitted += 1;
          decision = applyObservation(db, id, answer, now);
        } else if (decision.effects.includes("FISCAL_READ_BACK")) {
          decision = applyObservation(db, id, await observe(deps.adapter, row.event_ref), now);
        } else break;
      }
    } catch {
      failed += 1;
    }
  }
  return { selected: rows.length, submitted, failed };
}
