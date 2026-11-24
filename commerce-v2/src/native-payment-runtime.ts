import type Database from "better-sqlite3";
import { reconcilePendingFiscalEvents } from "./fiscal-port";
import { FakeFiscalAdapter, FakeNativeBank } from "./native-payment-fake";
import type { ProductKind } from "./native-payment-contract";
import { reconcilePendingNativePayments, type NativeLedgerContext } from "./native-payment-ledger";
import { reconcilePendingNativeRefunds } from "./native-payment-refunds";
import { NativeQuoteRail } from "./native-payment-rail";
import type { CommerceRuntimeConfig } from "./payment-mode";
import type { RefundEnvelopeKeyring } from "./refund-envelope";
import { assertStorefrontOpen, SalesStoppedError } from "./storefront-switch";

/**
 * FLEX-119 · composition of the direct native contour for server.ts. Present only with
 * PAYMENT_MODE=native; payment-mode.ts admits only NATIVE_PROVIDER=fake, and only in local/test.
 * New money is admitted by the owner's storefront switch at the moment of each send (I7).
 */
export function nativePaymentsFromConfig(db: Database.Database, config: CommerceRuntimeConfig, keyring: RefundEnvelopeKeyring | undefined) {
  if (config.paymentMode !== "native") return undefined;
  if (!config.native) throw new Error("NATIVE_CONFIGURATION_REQUIRED");
  if (!keyring) throw new Error("REFUND_ENVELOPE_KEYS_REQUIRED");
  if (config.deployEnvironment !== "local" && config.deployEnvironment !== "test") throw new Error("NATIVE_FAKE_PROVIDER_FORBIDDEN");
  const issuedQuote = db.prepare("SELECT storefront_open_since FROM checkout_quotes WHERE order_public_id=? AND consumed_at IS NOT NULL");
  // The native-only source branch can run before the LAB cancellation migration is present.
  const hasLabCancellation = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lab_occurrence_cancellations'").get();
  const eligibleLabOffer = db.prepare(`SELECT 1 FROM checkout_quotes quote JOIN offers offer ON offer.id=quote.offer_id
    JOIN products product ON product.id=offer.product_id JOIN lab_occurrences occurrence ON occurrence.occurrence_ref=product.occurrence_ref
    WHERE quote.order_public_id=? AND quote.consumed_at IS NOT NULL AND product.kind='LAB'
      AND product.withdrawn_at IS NULL AND occurrence.lifecycle='SCHEDULED'
      ${hasLabCancellation
        ? "AND NOT EXISTS (SELECT 1 FROM lab_occurrence_cancellations c WHERE c.occurrence_ref=occurrence.occurrence_ref)" : ""}`);
  const mayInitiate = (kind: ProductKind, orderPublicId: string) => {
    const quote = issuedQuote.get(orderPublicId) as { storefront_open_since: number | null } | undefined;
    if (!quote) return false;
    if (kind === "LAB" && !eligibleLabOffer.get(orderPublicId)) return false;
    try {
      assertStorefrontOpen(db, config, kind === "LAB" ? "LAB" : "COURSES", "PAYMENT_RECOVERY",
        { issuedOpenSince: quote.storefront_open_since, now: new Date().toISOString() });
      return true;
    } catch (error) {
      if (error instanceof SalesStoppedError) return false;
      throw error;
    }
  };
  const ledger: NativeLedgerContext = { provider: new FakeNativeBank(), keyring, fiscalizationMode: config.native.fiscalizationMode, mayInitiate };
  return {
    ledger,
    fiscalAdapter: new FakeFiscalAdapter(),
    quoteRail: new NativeQuoteRail({ merchantId: "flexperiment-native", fiscalizationMode: config.native.fiscalizationMode }),
  };
}

export function startNativeSweeps(db: Database.Database, native: NonNullable<ReturnType<typeof nativePaymentsFromConfig>>,
  options: { intervalMs: number; run: (task: () => Promise<void>) => Promise<void> }) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await options.run(async () => {
        await reconcilePendingNativePayments(db, native.ledger);
        await reconcilePendingNativeRefunds(db, native.ledger);
        // D's SERVICE_RENDERED reader is attached at D's integration; until then settlements stay AWAITING_SERVICE.
        await reconcilePendingFiscalEvents(db, { adapter: native.fiscalAdapter, keyring: native.ledger.keyring });
      });
    } catch (error) {
      console.error("native payment sweep failed", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void sweep(); }, options.intervalMs);
  timer.unref();
  void sweep();
  return timer;
}
