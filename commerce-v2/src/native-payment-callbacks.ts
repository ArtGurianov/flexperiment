import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { applyNativePaymentObservation, driveNativePayment, executorKey, type NativeLedgerContext } from "./native-payment-ledger";
import type { NativeCallbackHint } from "./native-payment-provider";
import { applyNativeRefundObservation, driveNativeRefund } from "./native-payment-refunds";

/**
 * FLEX-119 · callback intake (contract §4). An authenticated callback is stored durably first (deduplicated by provider
 * event id) and then only schedules a read-back; it never changes a payment or refund itself. The HTTP
 * route answers 2xx only after `receiveNativeCallback` returned (route registration: coordinator).
 */
export async function receiveNativeCallback(db: Database.Database, ctx: NativeLedgerContext,
  headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array) {
  for (const provider of [ctx.provider, ...(ctx.historicalProviders ?? [])]) {
    const hint = await provider.verifyCallback(headers, rawBody);
    if (hint) return recordCallback(db, ctx, executorKey(provider), hint, rawBody);
  }
  return { accepted: false as const, duplicate: undefined };
}

async function recordCallback(db: Database.Database, ctx: NativeLedgerContext, executor: string,
  hint: NativeCallbackHint, rawBody: Uint8Array) {
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
  const inserted = db.prepare(`INSERT INTO native_callback_inbox(id,provider,provider_event_id,body_sha256,signature_valid,subject_kind,subject_ref,received_at)
    VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(provider,provider_event_id) DO NOTHING`)
    .run(randomUUID(), executor, hint.providerEventId, bodySha256, hint.subjectKind, hint.providerSubjectId, now).changes;
  if (!inserted) return { accepted: true as const, duplicate: true };
  try {
    if (hint.subjectKind === "PAYMENT") {
      const payment = db.prepare("SELECT id FROM native_payments WHERE provider_payment_id=? AND executor_key=?").get(hint.providerSubjectId, executor) as { id: string } | undefined;
      if (payment) {
        const decision = applyNativePaymentObservation(db, ctx, payment.id,
          { source: "CALLBACK", signatureValid: true, providerPaymentId: hint.providerSubjectId, claimedStatus: "UNTRUSTED" });
        await driveNativePayment(db, { ...ctx, mayInitiate: () => false }, payment.id, decision);
      }
    } else {
      const refund = db.prepare("SELECT r.id FROM native_refunds r JOIN native_payments p ON p.id=r.native_payment_id WHERE r.provider_refund_id=? AND p.executor_key=?").get(hint.providerSubjectId, executor) as { id: string } | undefined;
      if (refund) {
        const decision = applyNativeRefundObservation(db, ctx, refund.id, { source: "CALLBACK", signatureValid: true, providerRefundId: hint.providerSubjectId });
        await driveNativeRefund(db, ctx, refund.id, decision);
      }
    }
  } finally {
    // Processed or not, the sweep reads every unsettled record back; the inbox row is the receipt.
    db.prepare("UPDATE native_callback_inbox SET processed_at=? WHERE provider=? AND provider_event_id=?").run(now, executor, hint.providerEventId);
  }
  return { accepted: true as const, duplicate: false };
}
