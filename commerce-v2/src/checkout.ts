import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { buildCheckoutSnapshot, canonicalCheckoutSnapshotJson, type CheckoutSnapshotConfig, type SharedCheckoutSnapshotV1 } from "./checkout-snapshot";
import { qualifiedFiscalPolicy, type FrozenFiscalPolicy } from "./fiscal-policy";
import { customerCanAccessCourse, grantEntitlement } from "./entitlements";
import { legalManifestHash, type LegalReleaseManifest } from "./legal-control";
import type { Storefront } from "./origins";
import type { RefundEnvelope } from "./refund-envelope";
import { assertMerchantPromotionStillApplicable, resolveCheckoutCode, type MerchantPromotionSnapshot } from "./promotions";
import { assertLiveOfferSaleMode } from "./catalog-control";
import type { CommerceRuntimeConfig } from "./payment-mode";

/** The runtime facts checkout re-evaluates on every preview and confirm. */
export type CheckoutPolicyConfig = Pick<CommerceRuntimeConfig, "deployEnvironment" | "paymentMode" | "merchantPromotionPrefix">;

export type RailState = "PENDING" | "CUSTOMER_ACTION_REQUIRED" | "PAID" | "DECLINED" | "EXPIRED" | "REFUND_PENDING" | "REFUNDED" | "REVIEW_REQUIRED";
export type RailProjection = {
  attemptId: string;
  state: RailState;
  checkoutUrl?: string;
  resolutionId?: string;
  snapshotHash?: string;
  refundExecutionId?: string;
  supportReference?: string;
  failureCode?: string;
  paymentAmountKopecks?: number;
  remainingRefundableAmountKopecks?: number;
  expectedRemainingRefundableAmountKopecks?: number;
};
export type RailQuote = {
  resolutionId: string;
  termsVersionId: string | null;
  baseAmountKopecks: number;
  discountKopecks: number;
  finalAmountKopecks: number;
  checkoutCodeOutcome?: CheckoutCodeOutcome;
  scenario?: string;
};
export type CheckoutCodeOutcome = "NONE" | "APPLIED" | "NOT_APPLICABLE" | "NOT_RECOGNIZED" | "NOT_APPLIED_ATTRIBUTION_LOCKED" | "NOT_APPLIED_CUSTOMER_KEPT_CURRENT";
export type RailResolution =
  | { state: "PRICE_REVIEW_REQUIRED"; quote: RailQuote }
  | { state: "CUSTOMER_ACTION_REQUIRED"; resolutionId: string; checkoutUrl: string };
export type PaymentResolveInput = {
  idempotencyKey: string; orderPublicId: string; amountKopecks: number; scenario?: string;
  customerEmail: string; offerRef: string; productRef: string; lineRef: string;
  unitRef?: string; serviceStartsAt?: string; serviceEndsAt?: string;
  legalReleaseRef: string; legalReleaseHash: string; handoffToken?: string; checkoutCode?: string;
};
export type PaymentCreateInput = PaymentResolveInput & {
  quote: RailQuote; successUrl?: string; snapshot: SharedCheckoutSnapshotV1; snapshotHash: string;
};
export type PaymentRefundInput = {
  idempotencyKey: string;
  orderPublicId: string;
  attemptId: string;
  amountKopecks: number;
  customerEmail: string;
  lineRef: string;
  fiscalItem: SharedCheckoutSnapshotV1["paymentObligations"][number]["fiscal"]["items"][number];
};
/** What Refref answered for a refund execution (createRefund, getRefundExecution). UNKNOWN: the answer was lost. */
export type RefundSubmission = {
  status: "SUBMITTED" | "PROCESSING" | "FAILED" | "UNKNOWN";
  refundExecutionId?: string;
  supportReference?: string;
  failureCode?: string;
  /** The accepted Refund that finished the execution; its presence, never a status, is the success signal. */
  canonicalRefundId?: string | null;
};
/** An accepted canonical Refund, read back (getRefund): the only thing that ends a customer's access. */
export type AcceptedRefund = { id: string; paymentId: string; amountKopecks: number; status: "SUCCEEDED" };
/**
 * What the rail contributes to a snapshot: who the merchant is to Refref and who issues receipts on
 * this rail. The receipt's content — tax system, VAT, payment method and object, item name — is the
 * offer's qualified fiscal policy (fiscal-policy.ts), never the rail's.
 */
export type RailSnapshotConfig = Pick<CheckoutSnapshotConfig, "merchantId" | "fiscalizationMode">;
export interface PaymentRail {
  readonly checkoutSnapshotConfig: RailSnapshotConfig;
  resolve(input: PaymentResolveInput): Promise<RailResolution>;
  create(input: PaymentCreateInput): Promise<RailProjection>;
  recoverCreate(input: PaymentCreateInput, knownAttemptId?: string): Promise<RailProjection>;
  reconcile(input: { idempotencyKey: string; orderPublicId: string; attemptId: string }): Promise<RailProjection>;
  acknowledgeFulfillment(input: { idempotencyKey: string; orderPublicId: string; attemptId: string }): Promise<void>;
  /**
   * Builds the one refund request this execution will ever send (ART-174): full refunds only, the paid
   * receipt's item, the receipt contact exactly when the rail's payments are PROVIDER-fiscalized. Reads,
   * never submits.
   */
  prepareRefund(input: PaymentRefundInput): Promise<RefundEnvelope>;
  /** Sends exactly the frozen envelope under its key; a lost answer is UNKNOWN, never a failure. */
  submitRefund(envelope: RefundEnvelope): Promise<RefundSubmission>;
  readRefundExecution(refundExecutionId: string): Promise<RefundSubmission>;
  /** null when Refref holds no accepted Refund under that id. */
  readRefund(refundId: string): Promise<AcceptedRefund | null>;
}

export class AmbiguousRailCreateError extends Error {
  constructor(readonly evidence?: Pick<RailProjection, "attemptId" | "resolutionId" | "snapshotHash">) {
    super("PAYMENT_CREATE_UNKNOWN");
  }
}

type MockRecord = RailProjection & { scenario: string; reconciliations: number; fulfillmentAcks: number; failedAcks?: number };

export class MockPaymentRail implements PaymentRail {
  private readonly records = new Map<string, MockRecord>();
  readonly checkoutSnapshotConfig: RailSnapshotConfig = {
    merchantId: "00000000-0000-4000-8000-000000000001",
    fiscalizationMode: "PROVIDER",
  };

  async resolve(input: PaymentResolveInput): Promise<RailResolution> {
    if (input.scenario === "resolution_action") {
      return { state: "CUSTOMER_ACTION_REQUIRED", resolutionId: `mock_resolution_${input.orderPublicId}`, checkoutUrl: `https://mock.invalid/referral/${input.orderPublicId}` };
    }
    return { state: "PRICE_REVIEW_REQUIRED", quote: {
      resolutionId: `mock_resolution_${input.orderPublicId}`,
      termsVersionId: null,
      baseAmountKopecks: input.amountKopecks,
      discountKopecks: 0,
      finalAmountKopecks: input.amountKopecks,
      checkoutCodeOutcome: input.checkoutCode
        ? input.scenario === "code_not_recognized" ? "NOT_RECOGNIZED"
          : input.scenario === "code_not_applicable" ? "NOT_APPLICABLE"
            : input.scenario === "code_attribution_locked" ? "NOT_APPLIED_ATTRIBUTION_LOCKED"
              : "APPLIED"
        : "NONE",
      scenario: input.scenario,
    } };
  }

  async create(input: PaymentCreateInput): Promise<RailProjection> {
    const existing = this.records.get(input.idempotencyKey);
    if (existing) return existing;
    const scenario = input.scenario ?? "success";
    const state: RailState = scenario === "decline" ? "DECLINED"
      : scenario === "customer_action" ? "CUSTOMER_ACTION_REQUIRED"
        : scenario === "expiry" ? "EXPIRED"
          : scenario === "late_payment" ? "PENDING"
            : "PAID";
    const record: MockRecord = {
      attemptId: `mock_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 20)}`,
      state,
      snapshotHash: input.snapshotHash,
      checkoutUrl: state === "CUSTOMER_ACTION_REQUIRED" ? `https://mock.invalid/action/${input.orderPublicId}` : undefined,
      // What Refref's read-back carries with an accepted payment; "wrong_amount" models a payment of another amount.
      paymentAmountKopecks: input.quote.finalAmountKopecks - (scenario === "wrong_amount" ? 1 : 0),
      scenario, reconciliations: 0, fulfillmentAcks: 0,
    };
    this.records.set(input.idempotencyKey, record);
    if (scenario === "ambiguous_create") throw new AmbiguousRailCreateError();
    return record;
  }

  async recoverCreate(input: PaymentCreateInput): Promise<RailProjection> {
    const record = this.records.get(input.idempotencyKey);
    if (!record) return this.create(input);
    return record;
  }

  async reconcile(input: { idempotencyKey: string; orderPublicId: string; attemptId: string }): Promise<RailProjection> {
    const record = this.records.get(input.idempotencyKey);
    if (!record) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
    record.reconciliations += 1;
    if (record.scenario === "late_payment" && record.reconciliations >= 1) record.state = "PAID";
    return record;
  }

  async acknowledgeFulfillment(input: { idempotencyKey: string; orderPublicId: string; attemptId: string }) {
    for (const record of this.records.values()) {
      if (record.attemptId !== input.attemptId) continue;
      // "ack_fails_once": the first ACK is lost on the way to Refref.
      if (record.scenario === "ack_fails_once" && !record.failedAcks) { record.failedAcks = 1; throw new TypeError("fetch failed"); }
      record.fulfillmentAcks += 1;
    }
  }

  // Refunds, as Refref answers them: an execution per key, finished by an accepted Refund at once, except
  // for "refund_failure" (a proven refusal). submittedRefunds counts what reached Refref.
  private readonly refundExecutions = new Map<string, { id: string; envelope: RefundEnvelope; refundId: string | null; failed: boolean }>();
  submittedRefunds = 0;

  async prepareRefund(input: PaymentRefundInput): Promise<RefundEnvelope> {
    for (const record of this.records.values()) {
      if (record.attemptId !== input.attemptId) continue;
      return { idempotencyKey: `${input.idempotencyKey}:refund`, paymentId: `mock-payment-${record.attemptId}`, amountKopecks: input.amountKopecks,
        body: { paymentId: `mock-payment-${record.attemptId}`, amountKopecks: input.amountKopecks,
          fiscal: { items: [{ ...input.fiscalItem, amountKopecks: input.amountKopecks }] } } };
    }
    throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  }

  async submitRefund(envelope: RefundEnvelope): Promise<RefundSubmission> {
    this.submittedRefunds += 1;
    let execution = this.refundExecutions.get(envelope.idempotencyKey);
    if (!execution) {
      const record = [...this.records.values()].find((r) => `mock-payment-${r.attemptId}` === envelope.paymentId);
      const failed = record?.scenario === "refund_failure";
      execution = { id: `mock-refund-execution-${this.refundExecutions.size + 1}`, envelope, failed,
        refundId: failed ? null : `mock-refund-${this.refundExecutions.size + 1}` };
      this.refundExecutions.set(envelope.idempotencyKey, execution);
    }
    return this.refundSubmission(execution);
  }

  async readRefundExecution(refundExecutionId: string): Promise<RefundSubmission> {
    const execution = [...this.refundExecutions.values()].find((e) => e.id === refundExecutionId);
    if (!execution) throw new Error("REFUND_EXECUTION_NOT_FOUND");
    return this.refundSubmission(execution);
  }

  async readRefund(refundId: string): Promise<AcceptedRefund | null> {
    const execution = [...this.refundExecutions.values()].find((e) => e.refundId === refundId);
    return execution ? { id: refundId, paymentId: execution.envelope.paymentId, amountKopecks: execution.envelope.amountKopecks, status: "SUCCEEDED" } : null;
  }

  private refundSubmission(execution: { id: string; refundId: string | null; failed: boolean }): RefundSubmission {
    return execution.failed
      ? { status: "FAILED", refundExecutionId: execution.id, supportReference: "mock-support", failureCode: "REFUND_DECLINED", canonicalRefundId: null }
      : { status: "PROCESSING", refundExecutionId: execution.id, supportReference: "mock-support", canonicalRefundId: execution.refundId };
  }

  fulfillmentAcknowledgementCount(idempotencyKey: string) {
    return this.records.get(idempotencyKey)?.fulfillmentAcks ?? 0;
  }
}

type OfferRow = {
  offer_id: string; offer_ref: string; product_id: string; product_ref: string;
  kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB"; access_model: "FREE" | "PAID";
  course_ref: string | null; price_kopecks: number; sale_mode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
  acceptance_allowlist_json: string; withdrawn_at: string | null;
  occurrence_ref: string | null; occurrence_title: string | null; occurrence_starts_at: string | null;
  occurrence_ends_at: string | null; occurrence_timezone: string | null; occurrence_city_id: string | null;
};

const offerByRef = (db: Database.Database, offerRef: string) => db.prepare(`SELECT offer.id AS offer_id,offer.offer_ref,
  product.id AS product_id,product.product_ref,product.kind,product.access_model,product.course_ref,product.withdrawn_at,product.occurrence_ref,
  offer.price_kopecks,offer.sale_mode,offer.acceptance_allowlist_json,occurrence.title AS occurrence_title,
  occurrence.starts_at AS occurrence_starts_at,occurrence.ends_at AS occurrence_ends_at,
  occurrence.timezone AS occurrence_timezone,occurrence.city_id AS occurrence_city_id
  FROM offers offer JOIN products product ON product.id=offer.product_id
  LEFT JOIN lab_occurrences occurrence ON occurrence.occurrence_ref=product.occurrence_ref
  WHERE offer.offer_ref=?`).get(offerRef) as OfferRow | undefined;

const attemptState = (state: RailState) => state;

type LegalRow = { id: string; version: string; manifest_json: string };

const legalRelease = (db: Database.Database, storefront: Storefront) => db.prepare(
  "SELECT id,version,manifest_json FROM legal_releases WHERE storefront=? AND active=1",
).get(storefront) as LegalRow | undefined;

const storefrontForOffer = (offer: OfferRow): Storefront => offer.kind === "LAB" ? "LAB" : "COURSES";

type FrozenLineSnapshot = {
  /** The offer's qualified fiscal policy when the quote was made; a different one makes the quote stale. */
  readonly fiscal: FrozenFiscalPolicy;
  readonly unitRef?: string;
  readonly serviceStartsAt?: string;
  readonly serviceEndsAt?: string;
  readonly occurrence?: {
    readonly occurrenceRef: string;
    readonly title: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timezone: string;
    readonly cityId: string;
  };
};

const refrefInstant = (value: string) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCMilliseconds() !== 0) throw new Error("OCCURRENCE_TIME_INVALID");
  return parsed.toISOString().replace(".000Z", "Z");
};

const freezeLine = (db: Database.Database, offer: OfferRow): FrozenLineSnapshot => {
  const fiscal = qualifiedFiscalPolicy(db, offer.offer_ref, offer.kind);
  if (offer.kind !== "LAB") return { fiscal };
  if (!offer.occurrence_ref || !offer.occurrence_title || !offer.occurrence_starts_at || !offer.occurrence_ends_at
    || !offer.occurrence_timezone || !offer.occurrence_city_id) throw new Error("LAB_OCCURRENCE_NOT_FOUND");
  const startsAt = refrefInstant(offer.occurrence_starts_at);
  const endsAt = refrefInstant(offer.occurrence_ends_at);
  return {
    fiscal,
    unitRef: offer.occurrence_ref,
    serviceStartsAt: startsAt,
    serviceEndsAt: endsAt,
    occurrence: {
      occurrenceRef: offer.occurrence_ref,
      title: offer.occurrence_title,
      startsAt,
      endsAt,
      timezone: offer.occurrence_timezone,
      cityId: offer.occurrence_city_id,
    },
  };
};

/** Live sellability of the offer itself, re-read on every checkout step; a stored quote never stands in for it. */
function assertOfferOpenToCustomer(db: Database.Database, config: CheckoutPolicyConfig, offer: OfferRow | undefined, customerEmail: string) {
  if (!offer || offer.withdrawn_at) throw new Error("OFFER_NOT_AVAILABLE");
  if (offer.access_model === "FREE") throw new Error("FREE_PRODUCT_CHECKOUT_FORBIDDEN");
  if (offer.sale_mode === "CLOSED") throw new Error("OFFER_CLOSED");
  assertLiveOfferSaleMode(db, config, { kind: offer.kind, accessModel: offer.access_model, saleMode: offer.sale_mode });
  if (offer.sale_mode === "ACCEPTANCE_ONLY") {
    const allowlist = JSON.parse(offer.acceptance_allowlist_json) as string[];
    if (!allowlist.map((email) => email.trim().toLowerCase()).includes(customerEmail.trim().toLowerCase())) throw new Error("ACCEPTANCE_ONLY");
  }
  return offer;
}

function assertOfferCanBePurchased(
  db: Database.Database,
  config: CheckoutPolicyConfig,
  candidate: OfferRow | undefined,
  customerId: string,
  customerEmail: string,
) {
  const offer = assertOfferOpenToCustomer(db, config, candidate, customerEmail);
  if (offer.kind === "ONLINE_COURSE" && offer.course_ref && customerCanAccessCourse(db, customerId, offer.course_ref)) throw new Error("ALREADY_OWNED");
  if (offer.kind === "COURSE_BUNDLE" && customerCanAccessCourse(db, customerId, "__any_future_course__")) throw new Error("ALREADY_OWNED");
  return offer;
}

type CheckoutQuotePricing = {
  catalogAmountKopecks: number;
  merchantDiscountKopecks: number;
  merchantPromotion: MerchantPromotionSnapshot | null;
};

const quoteResponse = (quoteId: string, quote: RailQuote, pricing: CheckoutQuotePricing, expiresAt: string) => ({
  quoteId,
  state: "PRICE_REVIEW_REQUIRED" as const,
  baseAmountKopecks: pricing.catalogAmountKopecks,
  merchantDiscountKopecks: pricing.merchantDiscountKopecks,
  referralDiscountKopecks: quote.discountKopecks,
  discountKopecks: pricing.merchantDiscountKopecks + quote.discountKopecks,
  finalAmountKopecks: quote.finalAmountKopecks,
  merchantPromotionCode: pricing.merchantPromotion?.code ?? null,
  checkoutCodeOutcome: quote.checkoutCodeOutcome ?? "NONE",
  expiresAt,
});

type StoredCheckoutQuote = {
  id: string;
  customer_id: string;
  offer_id: string;
  expires_at: string;
  rail_quote_json: string;
  catalog_amount_kopecks: number;
  merchant_discount_kopecks: number;
  merchant_promotion_snapshot_json: string | null;
  checkout_code_input: string | null;
  line_snapshot_json: string | null;
};

const storedPricing = (quote: StoredCheckoutQuote): CheckoutQuotePricing => ({
  catalogAmountKopecks: quote.catalog_amount_kopecks,
  merchantDiscountKopecks: quote.merchant_discount_kopecks,
  merchantPromotion: quote.merchant_promotion_snapshot_json
    ? JSON.parse(quote.merchant_promotion_snapshot_json) as MerchantPromotionSnapshot
    : null,
});

export async function prepareCheckout(
  db: Database.Database,
  rail: PaymentRail,
  config: CheckoutPolicyConfig,
  input: { customerId: string; customerEmail: string; offerRef: string; previewIdempotencyKey: string; scenario?: string; handoffToken?: string; checkoutCode?: string; orderPublicId?: string; storefront?: Storefront },
  now = new Date().toISOString(),
) {
  if (!input.previewIdempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  const checkoutCodeInput = input.checkoutCode?.trim() || null;
  const existing = db.prepare(`SELECT id,customer_id,offer_id,expires_at,rail_quote_json,catalog_amount_kopecks,
    merchant_discount_kopecks,merchant_promotion_snapshot_json,checkout_code_input,line_snapshot_json FROM checkout_quotes WHERE preview_idempotency_key=?`)
    .get(input.previewIdempotencyKey) as StoredCheckoutQuote | undefined;
  if (existing) {
    const requestedOffer = offerByRef(db, input.offerRef);
    if (existing.customer_id !== input.customerId || existing.offer_id !== requestedOffer?.offer_id
      || existing.checkout_code_input !== checkoutCodeInput) throw new Error("IDEMPOTENCY_KEY_REUSED");
    if (existing.expires_at <= now) throw new Error("CHECKOUT_QUOTE_EXPIRED");
    assertOfferOpenToCustomer(db, config, requestedOffer, input.customerEmail);
    return quoteResponse(existing.id, JSON.parse(existing.rail_quote_json) as RailQuote, storedPricing(existing), existing.expires_at);
  }

  const offer = assertOfferCanBePurchased(db, config, offerByRef(db, input.offerRef), input.customerId, input.customerEmail);
  const storefront = storefrontForOffer(offer);
  if (input.storefront && input.storefront !== storefront) throw new Error("CHECKOUT_STOREFRONT_MISMATCH");
  const legal = legalRelease(db, storefront);
  if (!legal) throw new Error("LEGAL_RELEASE_REQUIRED");
  const orderPublicId = input.orderPublicId ?? randomUUID();
  if (input.orderPublicId) {
    const resumed = db.prepare(`SELECT id,customer_id,offer_id,expires_at,rail_quote_json,state,catalog_amount_kopecks,
      merchant_discount_kopecks,merchant_promotion_snapshot_json,checkout_code_input,line_snapshot_json FROM checkout_quotes WHERE order_public_id=?`)
      .get(orderPublicId) as (StoredCheckoutQuote & { state: string }) | undefined;
    if (resumed) {
      if (resumed.customer_id !== input.customerId || resumed.offer_id !== offer.offer_id
        || resumed.checkout_code_input !== checkoutCodeInput) throw new Error("CHECKOUT_HANDOFF_REUSED");
      if (resumed.state !== "REVIEW" || resumed.expires_at <= now) throw new Error("CHECKOUT_QUOTE_UNAVAILABLE");
      return quoteResponse(resumed.id, JSON.parse(resumed.rail_quote_json) as RailQuote, storedPricing(resumed), resumed.expires_at);
    }
  }
  const quoteId = randomUUID();
  const lineRef = randomUUID();
  const lineSnapshot = freezeLine(db, offer);
  const codeResolution = resolveCheckoutCode(db, input.checkoutCode, offer.offer_ref, offer.price_kopecks, config.merchantPromotionPrefix, now);
  const merchantDiscountKopecks = codeResolution.promotion?.merchantDiscountKopecks ?? 0;
  const merchantOfferAmountKopecks = offer.price_kopecks - merchantDiscountKopecks;
  const resolved = await rail.resolve({
    idempotencyKey: input.previewIdempotencyKey,
    orderPublicId,
    amountKopecks: merchantOfferAmountKopecks,
    scenario: input.scenario,
    customerEmail: input.customerEmail,
    offerRef: offer.offer_ref,
    productRef: offer.product_ref,
    lineRef,
    unitRef: lineSnapshot.unitRef,
    serviceStartsAt: lineSnapshot.serviceStartsAt,
    serviceEndsAt: lineSnapshot.serviceEndsAt,
    legalReleaseRef: legal.version,
    legalReleaseHash: legalManifestHash(JSON.parse(legal.manifest_json) as LegalReleaseManifest),
    handoffToken: input.handoffToken,
    checkoutCode: codeResolution.refrefCheckoutCode,
  });
  if (resolved.state === "CUSTOMER_ACTION_REQUIRED") return { ...resolved, orderPublicId };
  if (resolved.quote.baseAmountKopecks !== merchantOfferAmountKopecks
    || resolved.quote.finalAmountKopecks !== merchantOfferAmountKopecks - resolved.quote.discountKopecks
    || resolved.quote.finalAmountKopecks <= 0) throw new Error("PAYMENT_QUOTE_INVALID");
  const expiresAt = new Date(new Date(now).getTime() + 15 * 60_000).toISOString();
  db.prepare(`INSERT INTO checkout_quotes
    (id,customer_id,offer_id,legal_release_id,order_public_id,line_ref,preview_idempotency_key,base_amount_kopecks,discount_kopecks,final_amount_kopecks,
      rail_quote_json,expires_at,created_at,updated_at,catalog_amount_kopecks,merchant_discount_kopecks,merchant_promotion_id,merchant_promotion_snapshot_json,
      refref_checkout_code_outcome,checkout_code_input,line_snapshot_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    quoteId, input.customerId, offer.offer_id, legal.id, orderPublicId, lineRef, input.previewIdempotencyKey,
    resolved.quote.baseAmountKopecks, resolved.quote.discountKopecks, resolved.quote.finalAmountKopecks,
    JSON.stringify(resolved.quote), expiresAt, now, now, offer.price_kopecks, merchantDiscountKopecks,
    codeResolution.promotion?.id ?? null, codeResolution.promotion ? JSON.stringify(codeResolution.promotion) : null,
    resolved.quote.checkoutCodeOutcome ?? "NONE", checkoutCodeInput, JSON.stringify(lineSnapshot),
  );
  return quoteResponse(quoteId, resolved.quote, {
    catalogAmountKopecks: offer.price_kopecks,
    merchantDiscountKopecks,
    merchantPromotion: codeResolution.promotion ?? null,
  }, expiresAt);
}

export async function confirmCheckout(
  db: Database.Database,
  rail: PaymentRail,
  config: CheckoutPolicyConfig,
  input: {
    customerId: string;
    customerEmail: string;
    quoteId: string;
    idempotencyKey: string;
    expectedOrderPublicId?: string;
    storefront?: Storefront;
    successUrl?: string;
  },
  now = new Date().toISOString(),
) {
  if (!input.idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  const existing = db.prepare(`SELECT attempt.idempotency_key,orders.public_id,orders.customer_id FROM checkout_attempts attempt
    JOIN orders ON orders.id=attempt.order_id WHERE attempt.idempotency_key=?`).get(input.idempotencyKey) as { idempotency_key: string; public_id: string; customer_id: string } | undefined;
  if (existing) {
    if (existing.customer_id !== input.customerId) throw new Error("IDEMPOTENCY_KEY_REUSED");
    if (input.expectedOrderPublicId && existing.public_id !== input.expectedOrderPublicId) throw new Error("CHECKOUT_STATE_INVALID");
    return reconcileCheckout(db, rail, existing.public_id, now);
  }

  const pending = db.prepare(`SELECT quote.id,quote.customer_id,quote.offer_id,quote.legal_release_id,quote.order_public_id,quote.line_ref,
    quote.base_amount_kopecks,quote.discount_kopecks,quote.final_amount_kopecks,quote.rail_quote_json,quote.state,quote.expires_at,
    quote.catalog_amount_kopecks,quote.merchant_discount_kopecks,quote.merchant_promotion_snapshot_json,quote.refref_checkout_code_outcome,
    quote.line_snapshot_json,
    offer.offer_ref,product.product_ref,legal.version AS legal_version,legal.manifest_json
    FROM checkout_quotes quote JOIN offers offer ON offer.id=quote.offer_id JOIN products product ON product.id=offer.product_id
    JOIN legal_releases legal ON legal.id=quote.legal_release_id WHERE quote.id=?`).get(input.quoteId) as {
      id: string; customer_id: string; offer_id: string; legal_release_id: string; order_public_id: string; line_ref: string;
      base_amount_kopecks: number; discount_kopecks: number; final_amount_kopecks: number; rail_quote_json: string;
      catalog_amount_kopecks: number; merchant_discount_kopecks: number; merchant_promotion_snapshot_json: string | null;
      refref_checkout_code_outcome: CheckoutCodeOutcome | null;
      line_snapshot_json: string | null;
      state: "REVIEW" | "CONSUMED" | "EXPIRED"; expires_at: string; offer_ref: string; product_ref: string;
      legal_version: string; manifest_json: string;
    } | undefined;
  if (!pending || pending.customer_id !== input.customerId) throw new Error("CHECKOUT_QUOTE_NOT_FOUND");
  if (input.expectedOrderPublicId && pending.order_public_id !== input.expectedOrderPublicId) throw new Error("CHECKOUT_STATE_INVALID");
  if (pending.state !== "REVIEW") throw new Error("CHECKOUT_QUOTE_UNAVAILABLE");
  if (pending.expires_at <= now) {
    db.prepare("UPDATE checkout_quotes SET state='EXPIRED',updated_at=? WHERE id=? AND state='REVIEW'").run(now, pending.id);
    throw new Error("CHECKOUT_QUOTE_EXPIRED");
  }
  if (!pending.line_snapshot_json) throw new Error("CHECKOUT_QUOTE_STALE");
  const offer = assertOfferCanBePurchased(db, config, offerByRef(db, pending.offer_ref), input.customerId, input.customerEmail);
  const storefront = storefrontForOffer(offer);
  if (input.storefront && input.storefront !== storefront) throw new Error("CHECKOUT_STOREFRONT_MISMATCH");
  const activeLegal = legalRelease(db, storefront);
  const frozenLine = JSON.parse(pending.line_snapshot_json) as FrozenLineSnapshot;
  if (offer.offer_id !== pending.offer_id || offer.price_kopecks !== pending.catalog_amount_kopecks
    || activeLegal?.id !== pending.legal_release_id
    || JSON.stringify(freezeLine(db, offer)) !== pending.line_snapshot_json) throw new Error("CHECKOUT_QUOTE_STALE");
  const quote = JSON.parse(pending.rail_quote_json) as RailQuote;
  const merchantPromotion = pending.merchant_promotion_snapshot_json
    ? JSON.parse(pending.merchant_promotion_snapshot_json) as MerchantPromotionSnapshot
    : null;
  assertMerchantPromotionStillApplicable(db, merchantPromotion, offer.offer_ref, offer.price_kopecks, now);

  const orderId = randomUUID();
  const attemptId = randomUUID();
  const publicId = pending.order_public_id;
  const legalReleaseHash = legalManifestHash(JSON.parse(pending.manifest_json) as LegalReleaseManifest);
  const { snapshot, snapshotHash, fiscalItem } = buildCheckoutSnapshot({
    config: {
      ...rail.checkoutSnapshotConfig,
      taxSystem: frozenLine.fiscal.taxSystem, vatCode: frozenLine.fiscal.vatCode,
      paymentMethod: frozenLine.fiscal.paymentMethod, paymentObject: frozenLine.fiscal.paymentObject,
    },
    merchantOrderRef: publicId,
    line: {
      lineRef: pending.line_ref,
      offerRef: offer.offer_ref,
      unitRef: frozenLine.unitRef,
      merchantOfferAmountKopecks: pending.base_amount_kopecks,
      referralDiscountAmountKopecks: pending.discount_kopecks,
      serviceStartsAt: frozenLine.serviceStartsAt,
      serviceEndsAt: frozenLine.serviceEndsAt,
      fiscalName: frozenLine.fiscal.itemName,
    },
    referralResolutionId: quote.resolutionId,
    termsVersionId: quote.termsVersionId,
    legalReleaseRef: pending.legal_version,
    legalReleaseHash,
  });
  const snapshotJson = canonicalCheckoutSnapshotJson(snapshot);
  const snapshotHashHex = snapshotHash.replace(/^refref-jcs-1:/, "");
  const railInput: PaymentCreateInput = {
    idempotencyKey: input.idempotencyKey, orderPublicId: publicId, amountKopecks: pending.base_amount_kopecks,
    scenario: quote.scenario,
    customerEmail: input.customerEmail, offerRef: offer.offer_ref,
    productRef: offer.product_ref, lineRef: pending.line_ref,
    unitRef: frozenLine.unitRef, serviceStartsAt: frozenLine.serviceStartsAt, serviceEndsAt: frozenLine.serviceEndsAt,
    legalReleaseRef: pending.legal_version, legalReleaseHash, quote, snapshot, snapshotHash,
    successUrl: input.successUrl,
  };
  const create = db.transaction(() => {
    db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
      VALUES (?,?,?,'PAYMENT_PENDING',?,?,?,?,?,?)`).run(orderId, publicId, input.customerId, pending.final_amount_kopecks, snapshotJson, snapshotHashHex, pending.legal_release_id, now, now);
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,created_at,
      catalog_amount_kopecks,merchant_discount_kopecks,merchant_amount_kopecks,merchant_promotion_snapshot_json,fiscal_item_json,
      legal_release_ref,legal_release_hash,occurrence_snapshot_json,fiscal_policy_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pending.line_ref, orderId, offer.product_id, offer.offer_ref, offer.product_ref, pending.final_amount_kopecks, pending.legal_version, now,
      pending.catalog_amount_kopecks, pending.merchant_discount_kopecks, pending.base_amount_kopecks,
      pending.merchant_promotion_snapshot_json, JSON.stringify(fiscalItem), pending.legal_version, legalReleaseHash,
      frozenLine.occurrence ? JSON.stringify(frozenLine.occurrence) : null, frozenLine.fiscal.policyId,
    );
    db.prepare(`INSERT INTO checkout_attempts(id,order_id,idempotency_key,request_payload_json,state,created_at,updated_at)
      VALUES (?,?,?,?,'CREATING',?,?)`).run(attemptId, orderId, input.idempotencyKey, JSON.stringify(railInput), now, now);
    const consumed = db.prepare("UPDATE checkout_quotes SET state='CONSUMED',consumed_at=?,updated_at=? WHERE id=? AND state='REVIEW'")
      .run(now, now, pending.id);
    if (consumed.changes !== 1) throw new Error("CHECKOUT_QUOTE_UNAVAILABLE");
  });
  create.immediate();

  try {
    const projection = await rail.create(railInput);
    return applyRailProjection(db, rail, publicId, projection, now);
  } catch (error) {
    if (!(error instanceof AmbiguousRailCreateError)) throw error;
    db.prepare(`UPDATE checkout_attempts SET state='CREATE_UNKNOWN',refref_attempt_id=COALESCE(?,refref_attempt_id),
      refref_resolution_id=COALESCE(?,refref_resolution_id),refref_snapshot_hash=COALESCE(?,refref_snapshot_hash),
      outcome_unknown_at=?,updated_at=? WHERE idempotency_key=?`).run(
      error.evidence?.attemptId ?? null,
      error.evidence?.resolutionId ?? null,
      error.evidence?.snapshotHash ?? null,
      now,
      now,
      input.idempotencyKey,
    );
    return { orderPublicId: publicId, state: "CREATE_UNKNOWN" as const };
  }
}

export async function checkout(
  db: Database.Database,
  rail: PaymentRail,
  config: CheckoutPolicyConfig,
  input: { customerId: string; customerEmail: string; offerRef: string; idempotencyKey: string; scenario?: string; handoffToken?: string; checkoutCode?: string; orderPublicId?: string },
  now = new Date().toISOString(),
) {
  const prepared = await prepareCheckout(db, rail, config, {
    customerId: input.customerId,
    customerEmail: input.customerEmail,
    offerRef: input.offerRef,
    previewIdempotencyKey: `${input.idempotencyKey}:preview`,
    scenario: input.scenario,
    handoffToken: input.handoffToken,
    checkoutCode: input.checkoutCode,
    orderPublicId: input.orderPublicId,
  }, now);
  if (prepared.state === "CUSTOMER_ACTION_REQUIRED") return prepared;
  return confirmCheckout(db, rail, config, {
    customerId: input.customerId,
    customerEmail: input.customerEmail,
    quoteId: prepared.quoteId,
    idempotencyKey: input.idempotencyKey,
  }, now);
}

async function applyRailProjection(db: Database.Database, rail: PaymentRail, orderPublicId: string, observed: RailProjection, now: string) {
  let projection = observed;
  const context = db.prepare(`SELECT orders.id AS order_id,orders.customer_id,line.id AS line_id,product.kind,product.course_ref,
    orders.snapshot_hash,orders.total_kopecks,json_extract(orders.checkout_snapshot_json,'$.schema') AS snapshot_schema,
    attempt.id AS attempt_id,attempt.idempotency_key,attempt.fulfillment_acknowledged_at FROM orders JOIN order_lines line ON line.order_id=orders.id JOIN products product ON product.id=line.product_id
    JOIN checkout_attempts attempt ON attempt.order_id=orders.id WHERE orders.public_id=?`).get(orderPublicId) as {
      order_id: string; customer_id: string; line_id: string; kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
      course_ref: string | null; snapshot_hash: string; total_kopecks: number; snapshot_schema: string | null;
      attempt_id: string; idempotency_key: string; fulfillment_acknowledged_at: string | null;
    } | undefined;
  if (!context) throw new Error("ORDER_NOT_FOUND");
  if (context.snapshot_schema === "refref.shared-checkout-snapshot/1"
    && projection.snapshotHash !== `refref-jcs-1:${context.snapshot_hash}`) throw new Error("PAYMENT_SNAPSHOT_HASH_MISMATCH");
  // A grant follows an accepted payment of exactly the order's frozen total. Refref's read-back carries the
  // payment's amount with it; one that differs, or is missing, is a person's to look at, never access.
  if (projection.state === "PAID" && projection.paymentAmountKopecks !== context.total_kopecks) {
    projection = { ...projection, state: "REVIEW_REQUIRED" };
  }
  const apply = db.transaction(() => {
    db.prepare(`UPDATE checkout_attempts SET state=?,refref_attempt_id=?,refref_resolution_id=COALESCE(?,refref_resolution_id),
      refref_snapshot_hash=COALESCE(?,refref_snapshot_hash),checkout_url=?,observed_payment_projection_json=?,last_reconciled_at=?,updated_at=? WHERE id=?`)
      .run(attemptState(projection.state), projection.attemptId, projection.resolutionId ?? null, projection.snapshotHash ?? null,
        projection.checkoutUrl ?? null, JSON.stringify(projection), now, now, context.attempt_id);
    if (projection.state === "PAID") {
      db.prepare("UPDATE orders SET state='FULFILLED',updated_at=? WHERE id=?").run(now, context.order_id);
      if (context.kind === "ONLINE_COURSE") grantEntitlement(db, { customerId: context.customer_id, scope: "COURSE", courseRef: context.course_ref!, sourceOrderLineId: context.line_id }, now);
      if (context.kind === "COURSE_BUNDLE") grantEntitlement(db, { customerId: context.customer_id, scope: "ALL_COURSES", sourceOrderLineId: context.line_id }, now);
    } else if (projection.state === "EXPIRED") db.prepare("UPDATE orders SET state='EXPIRED',updated_at=? WHERE id=?").run(now, context.order_id);
    else if (projection.state === "DECLINED") db.prepare("UPDATE orders SET state='CANCELLED',updated_at=? WHERE id=?").run(now, context.order_id);
    else if (projection.state === "REFUND_PENDING") {
      db.prepare("UPDATE orders SET state='REFUND_PENDING',updated_at=? WHERE id=?").run(now, context.order_id);
    } else if (projection.state === "REFUNDED") {
      // Access ends only on a refund Flexperiment executed and Refref accepted (refunds.ts, ART-174): a
      // payment Refref reports refunded without one is a person's to look at, and access stays meanwhile.
      const ours = db.prepare(`SELECT 1 FROM refund_requests request JOIN refund_executions execution ON execution.refund_request_id=request.id
        WHERE request.order_line_id=? AND execution.state='SUCCEEDED' AND execution.canonical_refund_id IS NOT NULL`).get(context.line_id);
      db.prepare("UPDATE orders SET state=?,updated_at=? WHERE id=?").run(ours ? "REFUNDED" : "REVIEW_REQUIRED", now, context.order_id);
    }
    else if (projection.state === "REVIEW_REQUIRED") db.prepare("UPDATE orders SET state='REVIEW_REQUIRED',updated_at=? WHERE id=?").run(now, context.order_id);
  });
  apply.immediate();
  // The operational ACK goes after the grant is committed, under the attempt's own key, so a replay is the
  // same ACK at Refref. A lost one does not fail the customer's request: the grant stands, and the
  // background sweep sends it again (reconcilePendingCheckouts) until Refref has it.
  if (projection.state === "PAID" && !context.fulfillment_acknowledged_at) {
    try {
      await rail.acknowledgeFulfillment({ attemptId: projection.attemptId, orderPublicId, idempotencyKey: context.idempotency_key });
      db.prepare("UPDATE checkout_attempts SET fulfillment_acknowledged_at=?,updated_at=? WHERE id=? AND fulfillment_acknowledged_at IS NULL")
        .run(now, now, context.attempt_id);
    } catch {
      // Left unacknowledged; retried.
    }
  }
  return { orderPublicId, state: projection.state, checkoutUrl: projection.checkoutUrl };
}

export async function reconcileCheckout(db: Database.Database, rail: PaymentRail, orderPublicId: string, now = new Date().toISOString()) {
  const attempt = db.prepare(`SELECT attempt.idempotency_key,attempt.refref_attempt_id,attempt.state,attempt.request_payload_json FROM checkout_attempts attempt JOIN orders ON orders.id=attempt.order_id
    WHERE orders.public_id=?`).get(orderPublicId) as { idempotency_key: string; refref_attempt_id: string | null; state: string; request_payload_json: string } | undefined;
  if (!attempt) throw new Error("ORDER_NOT_FOUND");
  const projection = attempt.state === "CREATE_UNKNOWN"
    ? await rail.recoverCreate(JSON.parse(attempt.request_payload_json) as PaymentCreateInput, attempt.refref_attempt_id ?? undefined)
    : await rail.reconcile({ idempotencyKey: attempt.idempotency_key, orderPublicId, attemptId: attempt.refref_attempt_id ?? "" });
  return applyRailProjection(db, rail, orderPublicId, projection, now);
}

export async function reconcilePendingCheckouts(db: Database.Database, rail: PaymentRail, now = new Date().toISOString()) {
  const rows = db.prepare(`SELECT orders.public_id FROM orders JOIN checkout_attempts attempt ON attempt.order_id=orders.id
    WHERE (attempt.state IN ('CREATE_UNKNOWN','PENDING','CUSTOMER_ACTION_REQUIRED')
           -- Paid and granted, but Refref has not had the ACK: sent again until it has.
           OR (attempt.state = 'PAID' AND attempt.fulfillment_acknowledged_at IS NULL))
      AND (attempt.refref_attempt_id IS NULL OR attempt.refref_attempt_id NOT LIKE 'resolution:%')
    ORDER BY attempt.updated_at LIMIT 100`).all() as Array<{ public_id: string }>;
  let reconciled = 0;
  let failed = 0;
  for (const row of rows) {
    try { await reconcileCheckout(db, rail, row.public_id, now); reconciled += 1; }
    catch { failed += 1; }
  }
  return { selected: rows.length, reconciled, failed };
}
