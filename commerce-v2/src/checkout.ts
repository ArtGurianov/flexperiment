import { acceptLabPurchase, issueLabTicket, type LabAcceptance } from "./lab-tickets";
import { CheckoutConflictError } from "./checkout-conflict";
export { CheckoutConflictError } from "./checkout-conflict";
import { readyImmediateCourseAccess } from "./immediate-course-access";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { buildCheckoutSnapshot, canonicalCheckoutSnapshotJson, type CheckoutSnapshotConfig, type SharedCheckoutSnapshot } from "./checkout-snapshot";
import { validPaymentPurpose } from "./payment-purpose";
import { qualifiedFiscalPolicy, type FrozenFiscalPolicy } from "./fiscal-policy";
import { customerCanAccessCourse, grantEntitlement } from "./entitlements";
import { legalManifestHash, type LegalReleaseManifest } from "./legal-control";
import type { Storefront } from "./origins";
import type { RefundEnvelope } from "./refund-envelope";
import { assertMerchantPromotionStillApplicable, resolveCheckoutCode, type MerchantPromotionSnapshot } from "./promotions";
import { assertLiveOfferSaleMode } from "./catalog-control";
import { assertLabOccurrenceAdmissible, occurrenceInstant, type BuyerVenueDisclosure } from "./lab-occurrences";
import type { CommerceRuntimeConfig } from "./payment-mode";
import { assertClosedPaidTestAccountConsents, assertClosedPaidTestFiscal, assertClosedPaidTestOffer, assertClosedPaidTestPrice, buyerEmailSha256 } from "./closed-paid-test";

// These shared guards also serve Control Room callers, which retain their ordinary domain errors.
// Classify only their declared business refusals at the checkout boundary; unknown DB faults escape.
const admissionRefusals = new Set(["FISCAL_POLICY_NOT_QUALIFIED", "SALES_ACTIVATION_REQUIRED", "CHECKOUT_QUOTE_STALE"]);
function checkoutAdmission<T>(guard: () => T): T {
  try { return guard(); }
  catch (error) {
    if (error instanceof Error && !(error instanceof CheckoutConflictError) && admissionRefusals.has(error.message)) {
      throw new CheckoutConflictError(error.message);
    }
    throw error;
  }
}

/** The runtime facts checkout re-evaluates on every preview and confirm. */
export type CheckoutPolicyConfig = Pick<CommerceRuntimeConfig, "deployEnvironment" | "paymentMode" | "merchantPromotionPrefix" | "closedPaidTest">;
export type PaidCheckoutAcceptance = { accepted: boolean; releaseVersion: string; manifestSha256: string; receiptEmail: string };

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
  /** Refref's own payment-admissibility deadline for the resolution, when it states one; replay never extends it. */
  expiresAt?: string;
};
export type CheckoutCodeOutcome = "NONE" | "APPLIED" | "NOT_APPLICABLE" | "NOT_RECOGNIZED" | "NOT_APPLIED_ATTRIBUTION_LOCKED" | "NOT_APPLIED_CUSTOMER_KEPT_CURRENT";
export type RailResolution =
  | { state: "PRICE_REVIEW_REQUIRED"; quote: RailQuote }
  | { state: "CUSTOMER_ACTION_REQUIRED"; resolutionId: string; checkoutUrl: string };
export type DeliveryDegraded = { degraded: false } | { degraded: true; reason: "TIMEOUT" | "FAILED" | "EXPIRED" };
/**
 * The resolution body as Refref vNext takes it (`BrowserContextResolutionRequest`, refref
 * docs/openapi-vnext.yaml): written into the intent before the first call and sent unchanged on every
 * repeat. It carries no buyer identity. `storefrontOrigin` and `browserContextId` become required with
 * the arrival endpoints (ART-378); until then they are frozen when the caller has them.
 */
export type ResolutionRequest = {
  merchantOrderRef: string;
  storefrontOrigin?: string;
  browserContextId?: string;
  currency: "RUB";
  lines: [{
    lineRef: string; offerRef: string; unitRef?: string; quantity: 1; merchantOfferAmountKopecks: number;
    serviceStartsAt?: string; serviceEndsAt?: string;
  }];
  checkoutCode?: string;
  deliveryDegraded: DeliveryDegraded;
};
/** One resolution call: the frozen request and what only the RC.2 rail still needs beside it. */
export type PaymentResolveInput = {
  idempotencyKey: string;
  request: ResolutionRequest;
  /** RC.2 handoff token (docs/28 §4); the vNext body has no token. */
  handoffToken?: string;
  scenario?: string;
};
type PaymentOrderInput = {
  idempotencyKey: string; orderPublicId: string; amountKopecks: number; scenario?: string;
  customerEmail: string; offerRef: string; productRef: string; lineRef: string;
  unitRef?: string; serviceStartsAt?: string; serviceEndsAt?: string;
  legalReleaseRef: string; legalReleaseHash: string; handoffToken?: string; checkoutCode?: string;
};
export type PaymentCreateInput = PaymentOrderInput & {
  quote: RailQuote; successUrl?: string; snapshot: SharedCheckoutSnapshot; snapshotHash: string;
};
export type PaymentRefundInput = {
  idempotencyKey: string;
  orderPublicId: string;
  attemptId: string;
  amountKopecks: number;
  customerEmail: string;
  lineRef: string;
  fiscalItem: SharedCheckoutSnapshot["paymentObligations"][number]["fiscal"]["items"][number];
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

  // Resolutions as Refref vNext keeps them: one per merchantOrderRef, an identical request replays the
  // original, a different one is refused. "ambiguous_resolve" loses the first answer after committing it.
  private readonly resolutions = new Map<string, { request: string; resolution: RailResolution }>();

  async resolve(input: PaymentResolveInput): Promise<RailResolution> {
    const orderPublicId = input.request.merchantOrderRef;
    const request = JSON.stringify([input.request, input.scenario ?? null]);
    const existing = this.resolutions.get(orderPublicId);
    if (existing) {
      if (existing.request !== request) throw new Error("REFREF_RESOLUTION_REQUEST_MISMATCH");
      return existing.resolution;
    }
    const amountKopecks = input.request.lines[0].merchantOfferAmountKopecks;
    const resolution: RailResolution = input.scenario === "resolution_action"
      ? { state: "CUSTOMER_ACTION_REQUIRED", resolutionId: `mock_resolution_${orderPublicId}`, checkoutUrl: `https://mock.invalid/referral/${orderPublicId}` }
      : { state: "PRICE_REVIEW_REQUIRED", quote: {
        resolutionId: `mock_resolution_${orderPublicId}`,
        termsVersionId: null,
        baseAmountKopecks: amountKopecks,
        discountKopecks: 0,
        finalAmountKopecks: amountKopecks,
        checkoutCodeOutcome: input.request.checkoutCode
          ? input.scenario === "code_not_recognized" ? "NOT_RECOGNIZED"
            : input.scenario === "code_not_applicable" ? "NOT_APPLICABLE"
              : input.scenario === "code_attribution_locked" ? "NOT_APPLIED_ATTRIBUTION_LOCKED"
                : "APPLIED"
          : "NONE",
        scenario: input.scenario,
      } };
    this.resolutions.set(orderPublicId, { request, resolution });
    if (input.scenario === "ambiguous_resolve") throw new AmbiguousRailCreateError();
    return resolution;
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
  payment_purpose: string | null;
  occurrence_ref: string | null; occurrence_title: string | null; occurrence_starts_at: string | null;
  occurrence_ends_at: string | null; occurrence_timezone: string | null; occurrence_city_id: string | null;
};

const offerWhere = (db: Database.Database, column: "offer.offer_ref" | "offer.id", value: string) => db.prepare(`SELECT offer.id AS offer_id,offer.offer_ref,
  product.id AS product_id,product.product_ref,product.kind,product.access_model,product.course_ref,product.withdrawn_at,product.occurrence_ref,
  offer.price_kopecks,offer.sale_mode,offer.payment_purpose,offer.acceptance_allowlist_json,occurrence.title AS occurrence_title,
  occurrence.starts_at AS occurrence_starts_at,occurrence.ends_at AS occurrence_ends_at,
  occurrence.timezone AS occurrence_timezone,occurrence.city_id AS occurrence_city_id
  FROM offers offer JOIN products product ON product.id=offer.product_id
  LEFT JOIN lab_occurrences occurrence ON occurrence.occurrence_ref=product.occurrence_ref
  WHERE ${column}=?`).get(value) as OfferRow | undefined;
const offerByRef = (db: Database.Database, offerRef: string) => offerWhere(db, "offer.offer_ref", offerRef);
const offerById = (db: Database.Database, offerId: string) => offerWhere(db, "offer.id", offerId);

const attemptState = (state: RailState) => state;

type LegalRow = { id: string; version: string; manifest_json: string };

const legalRelease = (db: Database.Database, storefront: Storefront) => db.prepare(
  "SELECT id,version,manifest_json FROM legal_releases WHERE storefront=? AND active=1",
).get(storefront) as LegalRow | undefined;

const storefrontForOffer = (offer: OfferRow): Storefront => offer.kind === "LAB" ? "LAB" : "COURSES";

type FrozenLineSnapshot = {
  readonly paymentPurpose: string;
  /** The offer's qualified fiscal policy when the quote was made; a different one makes the quote stale. */
  readonly fiscal: FrozenFiscalPolicy;
  readonly requiresImmediateAccess?: true;
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
    readonly venue: BuyerVenueDisclosure;
  };
};

const refrefInstant = (value: string) => occurrenceInstant(value, "OCCURRENCE_TIME_INVALID");

const freezeLine = (db: Database.Database, offer: OfferRow, venue?: BuyerVenueDisclosure): FrozenLineSnapshot => {
  if (!validPaymentPurpose(offer.payment_purpose)) throw new Error("PAYMENT_PURPOSE_REQUIRED");
  const fiscal = checkoutAdmission(() => qualifiedFiscalPolicy(db, offer.offer_ref, offer.kind));
  if (offer.kind !== "LAB") {
    if (offer.kind === "ONLINE_COURSE" && fiscal.paymentMethod === "FULL_PAYMENT") {
      readyImmediateCourseAccess(db, offer.course_ref!);
      return { fiscal, paymentPurpose: offer.payment_purpose, requiresImmediateAccess: true };
    }
    return { fiscal, paymentPurpose: offer.payment_purpose };
  }
  if (!offer.occurrence_ref || !offer.occurrence_title || !offer.occurrence_starts_at || !offer.occurrence_ends_at
    || !offer.occurrence_timezone || !offer.occurrence_city_id || !venue) throw new Error("LAB_OCCURRENCE_NOT_FOUND");
  const startsAt = refrefInstant(offer.occurrence_starts_at);
  const endsAt = refrefInstant(offer.occurrence_ends_at);
  return {
    fiscal,
    paymentPurpose: offer.payment_purpose,
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
      venue,
    },
  };
};

/** Live sellability of the offer itself, re-read on every checkout step; a stored quote never stands in for it. */
function assertOfferOpenToCustomer(db: Database.Database, config: CheckoutPolicyConfig, offer: OfferRow | undefined, customerEmail: string, now: string) {
  if (!offer || offer.withdrawn_at) throw new CheckoutConflictError("OFFER_NOT_AVAILABLE");
  if (offer.access_model === "FREE") throw new CheckoutConflictError("FREE_PRODUCT_CHECKOUT_FORBIDDEN");
  if (offer.sale_mode === "CLOSED") throw new CheckoutConflictError("OFFER_CLOSED");
  checkoutAdmission(() => assertLiveOfferSaleMode(db, config, { kind: offer.kind, accessModel: offer.access_model, saleMode: offer.sale_mode }));
  assertClosedPaidTestOffer(config, { kind: offer.kind, accessModel: offer.access_model, saleMode: offer.sale_mode,
    offerRef: offer.offer_ref, courseRef: offer.course_ref, priceKopecks: offer.price_kopecks,
    acceptanceAllowlist: JSON.parse(offer.acceptance_allowlist_json) }, customerEmail);
  if (offer.sale_mode === "ACCEPTANCE_ONLY") {
    const allowlist = JSON.parse(offer.acceptance_allowlist_json) as string[];
    if (!allowlist.map((email) => email.trim().toLowerCase()).includes(customerEmail.trim().toLowerCase())) throw new CheckoutConflictError("ACCEPTANCE_ONLY");
  }
  // A PUBLIC offer does not make its occurrence sellable: a direct offerRef bypasses the catalogue filter.
  const venue = offer.kind === "LAB" ? assertLabOccurrenceAdmissible(db, offer.occurrence_ref, now).venue : undefined;
  return { ...offer, venue };
}

function assertOfferCanBePurchased(
  db: Database.Database,
  config: CheckoutPolicyConfig,
  candidate: OfferRow | undefined,
  customerId: string,
  customerEmail: string,
  now: string,
) {
  const offer = assertOfferOpenToCustomer(db, config, candidate, customerEmail, now);
  if (offer.kind === "ONLINE_COURSE" && offer.course_ref && customerCanAccessCourse(db, customerId, offer.course_ref)) throw new CheckoutConflictError("ALREADY_OWNED");
  if (offer.kind === "COURSE_BUNDLE" && customerCanAccessCourse(db, customerId, "__any_future_course__")) throw new CheckoutConflictError("ALREADY_OWNED");
  return offer;
}

type CheckoutQuotePricing = {
  catalogAmountKopecks: number;
  merchantDiscountKopecks: number;
  merchantPromotion: MerchantPromotionSnapshot | null;
};

const quoteResponse = (quoteId: string, quote: RailQuote, pricing: CheckoutQuotePricing, expiresAt: string, lineSnapshotJson: string | null) => ({
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
  occurrence: lineSnapshotJson ? (JSON.parse(lineSnapshotJson) as FrozenLineSnapshot).occurrence ?? null : null,
});

function paidTestReview(db: Database.Database, config: CheckoutPolicyConfig, email: string) {
  if (!config.closedPaidTest) return undefined;
  const legal = legalRelease(db, "COURSES");
  if (!legal) throw new Error("LEGAL_RELEASE_REQUIRED");
  const manifest = JSON.parse(legal.manifest_json) as LegalReleaseManifest;
  const manifestSha256 = legalManifestHash(manifest);
  const required = ["privacy", "personal_data", "account_terms", "marketing_consent", "course_offer", "receipt_contact", "fiscal_items", "refund_terms"];
  if (manifest.stage !== "B" || required.some(kind => !manifest.documents.some(doc => doc.kind === kind))
    || legal.version !== config.closedPaidTest.legalVersion || manifestSha256 !== config.closedPaidTest.legalManifestSha256) {
    throw new Error("CLOSED_PAID_TEST_LEGAL_RELEASE_REFUSED");
  }
  return { releaseVersion: legal.version, manifestSha256, receiptEmail: email, documents: manifest.documents };
}

function assertNoOtherPaidTestOrder(db: Database.Database, config: CheckoutPolicyConfig, offerRef: string) {
  if (config.closedPaidTest && db.prepare("SELECT 1 FROM order_lines WHERE offer_ref_snapshot=? LIMIT 1").get(offerRef)) {
    throw new Error("CLOSED_PAID_TEST_ALREADY_ATTEMPTED");
  }
}

/**
 * A purchase intent (ART-373, migration 0030; the table keeps the name checkout_quotes). It is written,
 * with its order and line ids and the exact resolution request, before Refref is first called:
 *   DRAFT → RESOLVING → (CUSTOMER_ACTION_REQUIRED →) REVIEW → PAYMENT_CREATING → PENDING | UNCERTAIN
 *     → PAID | DECLINED | EXPIRED | REVIEW_REQUIRED;  REFUSED or EXPIRED before any payment.
 * Only an explicit confirmation (consumed_at) moves an intent to payment; loading or retrying never does.
 */
export type IntentState = "DRAFT" | "RESOLVING" | "CUSTOMER_ACTION_REQUIRED" | "REVIEW" | "REFUSED"
  | "PAYMENT_CREATING" | "PENDING" | "UNCERTAIN" | "PAID" | "DECLINED" | "EXPIRED" | "REVIEW_REQUIRED";

/** Refref definitively refused this resolution request (for example a different request for the same order). */
export class RailRefusalError extends CheckoutConflictError {}

/** Only attempt-create rejection plus authoritative absence of any external attempt. Never session failure. */
export class RailAttemptRefusalError extends CheckoutConflictError {}

const QUOTE_TTL_MS = 15 * 60_000;
/** A create left CREATING this long is read back by order (recoverCreate) like an unanswered one. */
const CREATING_UNANSWERED_AFTER_MS = 60_000;

type IntentRow = {
  id: string; customer_id: string; offer_id: string; legal_release_id: string; storefront: Storefront;
  order_public_id: string; line_ref: string; preview_idempotency_key: string;
  request_fingerprint: string | null; resolution_request_json: string | null;
  sale_mode_at_quote: "ACCEPTANCE_ONLY" | "PUBLIC";
  catalog_amount_kopecks: number; merchant_discount_kopecks: number; merchant_promotion_snapshot_json: string | null;
  checkout_code_input: string | null; line_snapshot_json: string | null;
  state: IntentState; failure_code: string | null; customer_action_url: string | null; refref_resolution_id: string | null;
  base_amount_kopecks: number | null; discount_kopecks: number | null; final_amount_kopecks: number | null;
  rail_quote_json: string | null; expires_at: string | null; consumed_at: string | null; created_at: string;
};

const intentBy = (db: Database.Database, column: "id" | "preview_idempotency_key" | "order_public_id", value: string) =>
  db.prepare(`SELECT id,customer_id,offer_id,legal_release_id,storefront,order_public_id,line_ref,preview_idempotency_key,
    request_fingerprint,resolution_request_json,sale_mode_at_quote,catalog_amount_kopecks,merchant_discount_kopecks,
    merchant_promotion_snapshot_json,checkout_code_input,line_snapshot_json,state,failure_code,customer_action_url,
    refref_resolution_id,base_amount_kopecks,discount_kopecks,final_amount_kopecks,rail_quote_json,expires_at,consumed_at,created_at
    FROM checkout_quotes WHERE ${column}=?`).get(value) as IntentRow | undefined;

const storedPricing = (intent: IntentRow): CheckoutQuotePricing => ({
  catalogAmountKopecks: intent.catalog_amount_kopecks,
  merchantDiscountKopecks: intent.merchant_discount_kopecks,
  merchantPromotion: intent.merchant_promotion_snapshot_json
    ? JSON.parse(intent.merchant_promotion_snapshot_json) as MerchantPromotionSnapshot
    : null,
});

/** Everything a repeat must match to be the same intent; the RC.2 handoff token is its resolution idempotency identity, stored only as a digest. */
const intentFingerprint = (facts: {
  customerId: string; offerRef: string; checkoutCode: string | null; storefrontOrigin: string | null;
  browserContextId: string | null; deliveryDegraded: DeliveryDegraded; scenario: string | null; handoffToken: string | null;
}) => createHash("sha256").update(JSON.stringify([facts.customerId, facts.offerRef, facts.checkoutCode, facts.storefrontOrigin,
  facts.browserContextId, facts.deliveryDegraded, facts.scenario, facts.handoffToken ? createHash("sha256").update(facts.handoffToken).digest("hex") : null])).digest("hex");

function assertDeliveryDegraded(value: DeliveryDegraded) {
  const keys = Object.keys(value).sort().join(",");
  if (value.degraded === false ? keys !== "degraded"
    : value.degraded !== true || keys !== "degraded,reason" || !["TIMEOUT", "FAILED", "EXPIRED"].includes(value.reason)) {
    throw new Error("DELIVERY_DEGRADED_INVALID");
  }
}

/** What the caller may have of the browser context, frozen into the intent. */
export type ResolutionContext = { storefrontOrigin?: string; browserContextId?: string; deliveryDegraded?: DeliveryDegraded };

/** Payments started for this customer and offer whose outcome is not yet known (or needs a person). */
const openPayments = (db: Database.Database, customerId: string, offerId: string) => db.prepare(`SELECT order_public_id FROM checkout_quotes
  WHERE customer_id=? AND offer_id=? AND state IN ('PAYMENT_CREATING','PENDING','UNCERTAIN','REVIEW_REQUIRED') ORDER BY consumed_at`)
  .all(customerId, offerId) as Array<{ order_public_id: string }>;

/** Reads every open payment of this customer and offer back from Refref before anything new may start. */
async function readBackOpenPayments(db: Database.Database, rail: PaymentRail, customerId: string, offerId: string, now: string) {
  for (const { order_public_id } of openPayments(db, customerId, offerId)) {
    try { await reconcileCheckout(db, rail, order_public_id, now); } catch { /* still open: refused below */ }
  }
}

function assertNoOpenPayment(db: Database.Database, customerId: string, offerId: string) {
  const open = openPayments(db, customerId, offerId)[0];
  if (open) throw new CheckoutConflictError("CHECKOUT_PAYMENT_IN_PROGRESS", open.order_public_id);
}

/** The frozen line's fiscal policy must still be the qualified one: payment never runs under a revoked policy. */
function assertFrozenFiscalPolicyQualified(db: Database.Database, offer: OfferRow, frozen: FrozenFiscalPolicy) {
  const current = checkoutAdmission(() => qualifiedFiscalPolicy(db, offer.offer_ref, offer.kind));
  if (current.policyId !== frozen.policyId) throw new CheckoutConflictError("FISCAL_POLICY_NOT_QUALIFIED");
}

/**
 * Admission of an already issued intent (design 2026-10-18 §1–§2). Price, terms and line come from the
 * intent and are never rebuilt from the catalogue, and an ordinary offer close does not end it. Only
 * its deadlines, a legal release change, withdrawal, a storefront close (sales activation revoked or
 * payments off) and — LAB, ART-203 — occurrence cancellation end it; a frozen fiscal policy that is no
 * longer qualified refuses payment.
 */
function assertIssuedIntentAdmissible(db: Database.Database, config: CheckoutPolicyConfig, intent: IntentRow, customerEmail: string, now: string) {
  const offer = offerById(db, intent.offer_id);
  if (!offer || offer.withdrawn_at) throw new CheckoutConflictError("OFFER_NOT_AVAILABLE");
  if (offer.access_model === "FREE") throw new CheckoutConflictError("FREE_PRODUCT_CHECKOUT_FORBIDDEN");
  checkoutAdmission(() => assertLiveOfferSaleMode(db, config, { kind: offer.kind, accessModel: offer.access_model, saleMode: intent.sale_mode_at_quote }));
  assertClosedPaidTestOffer(config, { kind: offer.kind, accessModel: offer.access_model, saleMode: offer.sale_mode,
    offerRef: offer.offer_ref, courseRef: offer.course_ref, priceKopecks: offer.price_kopecks,
    acceptanceAllowlist: JSON.parse(offer.acceptance_allowlist_json) }, customerEmail);
  if (legalRelease(db, intent.storefront)?.id !== intent.legal_release_id || !intent.line_snapshot_json) throw new CheckoutConflictError("CHECKOUT_QUOTE_STALE");
  const frozenLine = JSON.parse(intent.line_snapshot_json) as FrozenLineSnapshot;
  if (offer.kind === "LAB") {
    const { venue } = assertLabOccurrenceAdmissible(db, offer.occurrence_ref, now);
    const current = freezeLine(db, offer, venue).occurrence;
    const frozen = frozenLine.occurrence;
    if (!current || !frozen || current.startsAt !== frozen.startsAt || current.endsAt !== frozen.endsAt
      || current.timezone !== frozen.timezone || JSON.stringify(current.venue) !== JSON.stringify(frozen.venue)) {
      throw new CheckoutConflictError("CHECKOUT_QUOTE_STALE");
    }
  }
  assertFrozenFiscalPolicyQualified(db, offer, frozenLine.fiscal);
  checkoutAdmission(() => assertMerchantPromotionStillApplicable(db, storedPricing(intent).merchantPromotion, now));
  return { offer, frozenLine };
}

/** The first deadline the intent cannot outlive: 15 minutes from its creation, and the LAB start. */
function intentDeadline(intent: IntentRow) {
  const deadlines = [new Date(new Date(intent.created_at).getTime() + QUOTE_TTL_MS).toISOString()];
  const frozenLine = intent.line_snapshot_json ? JSON.parse(intent.line_snapshot_json) as FrozenLineSnapshot : undefined;
  if (frozenLine?.serviceStartsAt) deadlines.push(new Date(frozenLine.serviceStartsAt).toISOString());
  if (intent.expires_at) deadlines.push(intent.expires_at);
  return deadlines.sort()[0];
}

const expiredIntentError = (intent: IntentRow) => new CheckoutConflictError(intent.failure_code ?? "CHECKOUT_QUOTE_EXPIRED");

function expireIntent(db: Database.Database, intentId: string, now: string) {
  db.prepare(`UPDATE checkout_quotes SET state='EXPIRED',updated_at=? WHERE id=?
    AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED','REVIEW')`).run(now, intentId);
}

function refuseIntent(db: Database.Database, intentId: string, code: string, now: string) {
  db.prepare(`UPDATE checkout_quotes SET state='REFUSED',failure_code=?,updated_at=? WHERE id=?
    AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED')`).run(code, now, intentId);
}

type IntentContext = {
  config: CheckoutPolicyConfig;
  customerEmail: string;
  handoffToken?: string;
  review?: ReturnType<typeof paidTestReview>;
};

/**
 * Moves an intent as far as it may go without the buyer: resolve (or repeat the identical resolution
 * request after a lost answer) and show the quote. A started payment is only ever read back.
 */
async function advanceIntent(db: Database.Database, rail: PaymentRail, intent: IntentRow, context: IntentContext, now: string) {
  const { config } = context;
  const respond = (current: IntentRow) => ({
    ...quoteResponse(current.id, JSON.parse(current.rail_quote_json!) as RailQuote, storedPricing(current), current.expires_at!, current.line_snapshot_json),
    ...(context.review ? { legalAcceptance: context.review } : {}),
  });
  if (intent.consumed_at) return reconcileCheckout(db, rail, intent.order_public_id, now);
  if (intent.state === "REFUSED") throw new RailRefusalError(intent.failure_code ?? "CHECKOUT_RESOLUTION_REFUSED");
  if (intent.state === "EXPIRED" || intentDeadline(intent) <= now) {
    expireIntent(db, intent.id, now);
    throw expiredIntentError(intent);
  }
  assertIssuedIntentAdmissible(db, config, intent, context.customerEmail, now);
  if (intent.state === "REVIEW") {
    if (config.closedPaidTest) readyImmediateCourseAccess(db, offerById(db, intent.offer_id)?.course_ref ?? "");
    assertClosedPaidTestPrice(config, JSON.parse(intent.rail_quote_json!) as RailQuote, intent.merchant_discount_kopecks);
    return respond(intent);
  }

  // DRAFT, RESOLVING (an answer was lost) or CUSTOMER_ACTION_REQUIRED (the buyer came back): the frozen
  // request goes out again unchanged; Refref replays the resolution it committed for this order.
  db.prepare(`UPDATE checkout_quotes SET state='RESOLVING',resolution_sends=resolution_sends+1,
    resolution_requested_at=COALESCE(resolution_requested_at,?),updated_at=? WHERE id=?
    AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED')`).run(now, now, intent.id);
  const frozen = JSON.parse(intent.resolution_request_json!) as Omit<PaymentResolveInput, "handoffToken">;
  let resolved: RailResolution;
  try {
    resolved = await rail.resolve({ ...frozen, ...(context.handoffToken ? { handoffToken: context.handoffToken } : {}) });
  } catch (error) {
    if (error instanceof AmbiguousRailCreateError) return { state: "RESOLUTION_PENDING" as const, orderPublicId: intent.order_public_id };
    if (error instanceof RailRefusalError) refuseIntent(db, intent.id, error.message, now);
    throw error;
  }
  const line = frozen.request.lines[0];
  const settle = db.transaction(() => {
    const current = intentBy(db, "id", intent.id)!;
    // Another request for the same intent got there first: its outcome stands.
    if (current.state !== "RESOLVING") return current;
    if (resolved.state === "CUSTOMER_ACTION_REQUIRED") {
      db.prepare(`UPDATE checkout_quotes SET state='CUSTOMER_ACTION_REQUIRED',refref_resolution_id=?,customer_action_url=?,updated_at=?
        WHERE id=?`).run(resolved.resolutionId, resolved.checkoutUrl, now, intent.id);
      return intentBy(db, "id", intent.id)!;
    }
    const { quote } = resolved;
    if (quote.baseAmountKopecks !== line.merchantOfferAmountKopecks
      || quote.finalAmountKopecks !== line.merchantOfferAmountKopecks - quote.discountKopecks
      || quote.finalAmountKopecks <= 0) {
      refuseIntent(db, intent.id, "PAYMENT_QUOTE_INVALID", now);
      return intentBy(db, "id", intent.id)!;
    }
    try {
      assertClosedPaidTestPrice(config, quote, intent.merchant_discount_kopecks);
    } catch (error) {
      refuseIntent(db, intent.id, (error as Error).message, now);
      return intentBy(db, "id", intent.id)!;
    }
    const promotionId = storedPricing(intent).merchantPromotion?.id;
    const promotionEnd = promotionId
      ? (db.prepare("SELECT ends_at FROM merchant_promotion WHERE id=?").get(promotionId) as { ends_at: string | null } | undefined)?.ends_at
      : null;
    const expiresAt = [intentDeadline(intent), quote.expiresAt, promotionEnd]
      .filter((value): value is string => Boolean(value)).map((value) => new Date(value).toISOString()).sort()[0];
    if (expiresAt <= now) {
      expireIntent(db, intent.id, now);
      return intentBy(db, "id", intent.id)!;
    }
    db.prepare(`UPDATE checkout_quotes SET state='REVIEW',refref_resolution_id=?,customer_action_url=NULL,base_amount_kopecks=?,
      discount_kopecks=?,final_amount_kopecks=?,rail_quote_json=?,refref_checkout_code_outcome=?,expires_at=?,updated_at=? WHERE id=?`)
      .run(quote.resolutionId, quote.baseAmountKopecks, quote.discountKopecks, quote.finalAmountKopecks, JSON.stringify(quote),
        quote.checkoutCodeOutcome ?? "NONE", expiresAt, now, intent.id);
    return intentBy(db, "id", intent.id)!;
  });
  const settled = settle.immediate();
  if (settled.state === "CUSTOMER_ACTION_REQUIRED") {
    return { state: "CUSTOMER_ACTION_REQUIRED" as const, resolutionId: settled.refref_resolution_id!,
      checkoutUrl: settled.customer_action_url!, orderPublicId: settled.order_public_id };
  }
  if (settled.state !== "REVIEW") {
    if (settled.consumed_at) return reconcileCheckout(db, rail, settled.order_public_id, now);
    if (settled.state === "EXPIRED") throw expiredIntentError(settled);
    throw new RailRefusalError(settled.failure_code ?? "CHECKOUT_RESOLUTION_REFUSED");
  }
  assertClosedPaidTestAccountConsents(db, config, settled.customer_id);
  const frozenLine = JSON.parse(settled.line_snapshot_json!) as FrozenLineSnapshot;
  if (frozenLine.requiresImmediateAccess) readyImmediateCourseAccess(db, offerById(db, settled.offer_id)?.course_ref ?? "");
  assertClosedPaidTestPrice(config, JSON.parse(settled.rail_quote_json!) as RailQuote, settled.merchant_discount_kopecks);
  return respond(settled);
}

export async function prepareCheckout(
  db: Database.Database,
  rail: PaymentRail,
  config: CheckoutPolicyConfig,
  input: {
    customerId: string; customerEmail: string; offerRef: string; previewIdempotencyKey: string; scenario?: string;
    handoffToken?: string; checkoutCode?: string; orderPublicId?: string; storefront?: Storefront;
  } & ResolutionContext,
  now = new Date().toISOString(),
) {
  if (!input.previewIdempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  if (config.closedPaidTest && input.checkoutCode?.trim()) throw new Error("CLOSED_PAID_TEST_PRICE_REFUSED");
  // This is review data, not an acceptance event. A later explicit confirm writes the event.
  const review = paidTestReview(db, config, input.customerEmail);
  assertClosedPaidTestAccountConsents(db, config, input.customerId);
  const context: IntentContext = { config, customerEmail: input.customerEmail, handoffToken: input.handoffToken, review };
  const checkoutCodeInput = input.checkoutCode?.trim() || null;
  const deliveryDegraded = input.deliveryDegraded ?? { degraded: false };
  assertDeliveryDegraded(deliveryDegraded);
  if (input.browserContextId !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(input.browserContextId)) throw new Error("BROWSER_CONTEXT_ID_INVALID");
  const fingerprint = intentFingerprint({ customerId: input.customerId, offerRef: input.offerRef, checkoutCode: checkoutCodeInput,
    storefrontOrigin: input.storefrontOrigin ?? null, browserContextId: input.browserContextId ?? null, deliveryDegraded,
    scenario: input.scenario ?? null, handoffToken: input.handoffToken ?? null });

  // A repeat of this request, or the buyer back on the order the handoff signed: the same intent.
  const replay = intentBy(db, "preview_idempotency_key", input.previewIdempotencyKey);
  if (replay) {
    if (replay.customer_id !== input.customerId || replay.request_fingerprint !== fingerprint
      || (input.orderPublicId !== undefined && input.orderPublicId !== replay.order_public_id)) throw new CheckoutConflictError("IDEMPOTENCY_KEY_REUSED");
    return advanceIntent(db, rail, replay, context, now);
  }
  const resumed = input.orderPublicId ? intentBy(db, "order_public_id", input.orderPublicId) : undefined;
  if (resumed) {
    if (resumed.customer_id !== input.customerId || resumed.request_fingerprint !== fingerprint) throw new CheckoutConflictError("CHECKOUT_HANDOFF_REUSED");
    return advanceIntent(db, rail, resumed, context, now);
  }

  const candidate = offerByRef(db, input.offerRef);
  if (candidate) await readBackOpenPayments(db, rail, input.customerId, candidate.offer_id, now);
  const intentId = randomUUID();
  const orderPublicId = input.orderPublicId ?? randomUUID();
  const lineRef = randomUUID();
  // New-quote admission and the intent's frozen facts, in one write transaction (design §2).
  const draft = db.transaction(() => {
    const offer = assertOfferCanBePurchased(db, config, offerByRef(db, input.offerRef), input.customerId, input.customerEmail, now);
    assertNoOtherPaidTestOrder(db, config, offer.offer_ref);
    if (config.closedPaidTest) readyImmediateCourseAccess(db, offer.course_ref!);
    const storefront = storefrontForOffer(offer);
    if (input.storefront && input.storefront !== storefront) throw new Error("CHECKOUT_STOREFRONT_MISMATCH");
    const legal = legalRelease(db, storefront);
    if (!legal) throw new Error("LEGAL_RELEASE_REQUIRED");
    assertNoOpenPayment(db, input.customerId, offer.offer_id);
    const lineSnapshot = freezeLine(db, offer, offer.venue);
    assertClosedPaidTestFiscal(config, lineSnapshot.fiscal);
    const codeResolution = resolveCheckoutCode(db, input.checkoutCode, offer.offer_ref, offer.price_kopecks, config.merchantPromotionPrefix, now);
    const merchantDiscountKopecks = codeResolution.promotion?.merchantDiscountKopecks ?? 0;
    const request: ResolutionRequest = {
      merchantOrderRef: orderPublicId,
      ...(input.storefrontOrigin === undefined ? {} : { storefrontOrigin: input.storefrontOrigin }),
      ...(input.browserContextId === undefined ? {} : { browserContextId: input.browserContextId }),
      currency: "RUB",
      lines: [{
        lineRef,
        offerRef: offer.offer_ref,
        ...(lineSnapshot.unitRef === undefined ? {} : { unitRef: lineSnapshot.unitRef }),
        quantity: 1,
        merchantOfferAmountKopecks: offer.price_kopecks - merchantDiscountKopecks,
        ...(lineSnapshot.serviceStartsAt === undefined ? {} : { serviceStartsAt: lineSnapshot.serviceStartsAt }),
        ...(lineSnapshot.serviceEndsAt === undefined ? {} : { serviceEndsAt: lineSnapshot.serviceEndsAt }),
      }],
      ...(codeResolution.refrefCheckoutCode ? { checkoutCode: codeResolution.refrefCheckoutCode } : {}),
      deliveryDegraded,
    };
    const frozen: Omit<PaymentResolveInput, "handoffToken"> = {
      idempotencyKey: input.previewIdempotencyKey, request, ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
    };
    db.prepare(`INSERT INTO checkout_quotes
      (id,customer_id,offer_id,legal_release_id,storefront,order_public_id,line_ref,preview_idempotency_key,request_fingerprint,
        resolution_request_json,sale_mode_at_quote,catalog_amount_kopecks,merchant_discount_kopecks,merchant_promotion_id,
        merchant_promotion_snapshot_json,checkout_code_input,line_snapshot_json,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`).run(
      intentId, input.customerId, offer.offer_id, legal.id, storefront, orderPublicId, lineRef, input.previewIdempotencyKey, fingerprint,
      JSON.stringify(frozen), offer.sale_mode, offer.price_kopecks, merchantDiscountKopecks,
      codeResolution.promotion?.id ?? null, codeResolution.promotion ? JSON.stringify(codeResolution.promotion) : null,
      checkoutCodeInput, JSON.stringify(lineSnapshot), now, now,
    );
  });
  draft.immediate();
  return advanceIntent(db, rail, intentBy(db, "id", intentId)!, context, now);
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
    legalAcceptance?: PaidCheckoutAcceptance;
    labAcceptance?: LabAcceptance;
  },
  now = new Date().toISOString(),
) {
  if (!input.idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  assertClosedPaidTestAccountConsents(db, config, input.customerId);
  const existing = db.prepare(`SELECT attempt.idempotency_key,orders.public_id,orders.customer_id FROM checkout_attempts attempt
    JOIN orders ON orders.id=attempt.order_id WHERE attempt.idempotency_key=?`).get(input.idempotencyKey) as { idempotency_key: string; public_id: string; customer_id: string } | undefined;
  if (existing) {
    if (existing.customer_id !== input.customerId) throw new CheckoutConflictError("IDEMPOTENCY_KEY_REUSED");
    if (input.expectedOrderPublicId && existing.public_id !== input.expectedOrderPublicId) throw new Error("CHECKOUT_STATE_INVALID");
    return reconcileCheckout(db, rail, existing.public_id, now);
  }

  const pending = intentBy(db, "id", input.quoteId);
  if (!pending || pending.customer_id !== input.customerId) throw new Error("CHECKOUT_QUOTE_NOT_FOUND");
  if (input.expectedOrderPublicId && pending.order_public_id !== input.expectedOrderPublicId) throw new Error("CHECKOUT_STATE_INVALID");
  if (input.storefront && input.storefront !== pending.storefront) throw new Error("CHECKOUT_STOREFRONT_MISMATCH");
  // Confirmed already (another tab, or a reload with a new key): the order it started, read back.
  if (pending.consumed_at) return reconcileCheckout(db, rail, pending.order_public_id, now);
  if (pending.state === "EXPIRED") throw expiredIntentError(pending);
  if (pending.state !== "REVIEW") throw new Error("CHECKOUT_QUOTE_UNAVAILABLE");
  if (pending.expires_at! <= now) {
    expireIntent(db, pending.id, now);
    throw expiredIntentError(pending);
  }
  const review = paidTestReview(db, config, input.customerEmail);
  if (review && (input.legalAcceptance?.accepted !== true || input.legalAcceptance.releaseVersion !== review.releaseVersion
    || input.legalAcceptance.manifestSha256 !== review.manifestSha256 || input.legalAcceptance.receiptEmail !== review.receiptEmail)) {
    throw new Error("PAID_CHECKOUT_TERMS_ACCEPTANCE_REQUIRED");
  }
  // Payment by-order read-back before any new provider initiation: another tab's payment for the same
  // offer is settled or still open, and an open one refuses this confirmation.
  await readBackOpenPayments(db, rail, input.customerId, pending.offer_id, now);

  const { offer, frozenLine } = assertIssuedIntentAdmissible(db, config, pending, input.customerEmail, now);
  const quote = JSON.parse(pending.rail_quote_json!) as RailQuote;
  const orderId = randomUUID();
  const attemptId = randomUUID();
  const publicId = pending.order_public_id;
  const legal = db.prepare("SELECT version,manifest_json FROM legal_releases WHERE id=?").get(pending.legal_release_id) as Pick<LegalRow, "version" | "manifest_json">;
  const legalReleaseHash = legalManifestHash(JSON.parse(legal.manifest_json) as LegalReleaseManifest);
  const { snapshot, snapshotHash, fiscalItem } = buildCheckoutSnapshot({
    config: {
      ...rail.checkoutSnapshotConfig,
      taxSystem: frozenLine.fiscal.taxSystem, vatCode: frozenLine.fiscal.vatCode,
      paymentMethod: frozenLine.fiscal.paymentMethod, paymentObject: frozenLine.fiscal.paymentObject,
    },
    merchantOrderRef: publicId,
    paymentPurpose: frozenLine.paymentPurpose,
    line: {
      lineRef: pending.line_ref,
      offerRef: offer.offer_ref,
      unitRef: frozenLine.unitRef,
      merchantOfferAmountKopecks: pending.base_amount_kopecks!,
      referralDiscountAmountKopecks: pending.discount_kopecks!,
      serviceStartsAt: frozenLine.serviceStartsAt,
      serviceEndsAt: frozenLine.serviceEndsAt,
      fiscalName: frozenLine.fiscal.itemName,
    },
    referralResolutionId: quote.resolutionId,
    termsVersionId: quote.termsVersionId,
    legalReleaseRef: legal.version,
    legalReleaseHash,
  });
  const snapshotJson = canonicalCheckoutSnapshotJson(snapshot);
  const snapshotHashHex = snapshotHash.replace(/^refref-jcs-1:/, "");
  const railInput: PaymentCreateInput = {
    idempotencyKey: input.idempotencyKey, orderPublicId: publicId, amountKopecks: pending.base_amount_kopecks!,
    scenario: quote.scenario,
    customerEmail: input.customerEmail, offerRef: offer.offer_ref,
    productRef: offer.product_ref, lineRef: pending.line_ref,
    unitRef: frozenLine.unitRef, serviceStartsAt: frozenLine.serviceStartsAt, serviceEndsAt: frozenLine.serviceEndsAt,
    legalReleaseRef: legal.version, legalReleaseHash, quote, snapshot, snapshotHash,
    successUrl: input.successUrl,
  };
  const create = db.transaction(() => {
    // Final admission of the issued intent and the payment-safety checks, under the same write lock
    // as the order: a second process (CLI) cannot slip a change in between.
    const current = intentBy(db, "id", pending.id)!;
    if (current.state === "EXPIRED") throw expiredIntentError(current);
    if (current.state !== "REVIEW") throw new Error("CHECKOUT_QUOTE_UNAVAILABLE");
    if (current.expires_at! <= now) throw new CheckoutConflictError("CHECKOUT_QUOTE_EXPIRED");
    assertIssuedIntentAdmissible(db, config, current, input.customerEmail, now);
    if (offer.kind === "ONLINE_COURSE" && offer.course_ref && customerCanAccessCourse(db, input.customerId, offer.course_ref)) throw new CheckoutConflictError("ALREADY_OWNED");
    if (offer.kind === "COURSE_BUNDLE" && customerCanAccessCourse(db, input.customerId, "__any_future_course__")) throw new CheckoutConflictError("ALREADY_OWNED");
    assertNoOpenPayment(db, input.customerId, pending.offer_id);
    // Two tabs: a payment for the same offer confirmed while this quote was open already went through.
    const parallel = db.prepare(`SELECT order_public_id FROM checkout_quotes WHERE customer_id=? AND offer_id=? AND id<>?
      AND state='PAID' AND consumed_at>=?`).get(input.customerId, pending.offer_id, pending.id, pending.created_at) as { order_public_id: string } | undefined;
    if (parallel) throw new CheckoutConflictError("CHECKOUT_ALREADY_PAID", parallel.order_public_id);
    assertClosedPaidTestAccountConsents(db, config, input.customerId);
    assertClosedPaidTestFiscal(config, frozenLine.fiscal);
    assertClosedPaidTestPrice(config, quote, pending.merchant_discount_kopecks);
    assertClosedPaidTestPrice(config, { baseAmountKopecks: pending.base_amount_kopecks!, finalAmountKopecks: pending.final_amount_kopecks!,
      discountKopecks: pending.discount_kopecks! }, pending.merchant_discount_kopecks);
    // This is historical delivery evidence, not an entitlement limited to this content version.
    const initialAccessEvidence = frozenLine.requiresImmediateAccess ? readyImmediateCourseAccess(db, offer.course_ref!) : undefined;
    assertNoOtherPaidTestOrder(db, config, offer.offer_ref);
    // The seat count is re-read under the write lock that creates the order taking it.
    if (offer.kind === "LAB") assertLabOccurrenceAdmissible(db, offer.occurrence_ref, now);
    if (review) {
      // Re-read under the same write transaction as order creation; no backfilled UI event.
      const current = paidTestReview(db, config, input.customerEmail)!;
      const customer = db.prepare("SELECT email_normalized FROM customers WHERE id=?").get(input.customerId) as { email_normalized: string } | undefined;
      if (customer?.email_normalized !== current.receiptEmail) throw new Error("PAID_CHECKOUT_CONTACT_CHANGED");
      db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
        VALUES (?,?, 'PAID_CHECKOUT_TERMS_ACCEPTED','ORDER',?,?,?)`).run(randomUUID(), `customer:${input.customerId}`, publicId,
        JSON.stringify({ quoteId: pending.id, legalReleaseVersion: current.releaseVersion, legalManifestSha256: current.manifestSha256,
          receiptEmailSha256: buyerEmailSha256(current.receiptEmail), source: "AUTHENTICATED_CHECKOUT_CONFIRM" }), now);
    }
    if (offer.kind === "LAB" && db.prepare("SELECT 1 FROM lab_guest_access WHERE order_public_id=?").get(publicId)) {
      acceptLabPurchase(db, publicId, input.customerId, input.labAcceptance, now);
    }
    db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
      VALUES (?,?,?,'PAYMENT_PENDING',?,?,?,?,?,?)`).run(orderId, publicId, input.customerId, pending.final_amount_kopecks, snapshotJson, snapshotHashHex, pending.legal_release_id, now, now);
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,created_at,
      catalog_amount_kopecks,merchant_discount_kopecks,merchant_amount_kopecks,merchant_promotion_snapshot_json,fiscal_item_json,
      legal_release_ref,legal_release_hash,occurrence_snapshot_json,fiscal_policy_id,immediate_access_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pending.line_ref, orderId, offer.product_id, offer.offer_ref, offer.product_ref, pending.final_amount_kopecks, legal.version, now,
      pending.catalog_amount_kopecks, pending.merchant_discount_kopecks, pending.base_amount_kopecks,
      pending.merchant_promotion_snapshot_json, JSON.stringify(fiscalItem), legal.version, legalReleaseHash,
      frozenLine.occurrence ? JSON.stringify(frozenLine.occurrence) : null, frozenLine.fiscal.policyId,
      initialAccessEvidence ? JSON.stringify(initialAccessEvidence) : null,
    );
    db.prepare(`INSERT INTO checkout_attempts(id,order_id,idempotency_key,request_payload_json,state,created_at,updated_at)
      VALUES (?,?,?,?,'CREATING',?,?)`).run(attemptId, orderId, input.idempotencyKey, JSON.stringify(railInput), now, now);
    const consumed = db.prepare("UPDATE checkout_quotes SET state='PAYMENT_CREATING',consumed_at=?,updated_at=? WHERE id=? AND state='REVIEW'")
      .run(now, now, pending.id);
    if (consumed.changes !== 1) throw new Error("CHECKOUT_QUOTE_UNAVAILABLE");
  });
  create.immediate();

  try {
    const projection = await rail.create(railInput);
    return applyRailProjection(db, rail, publicId, projection, now);
  } catch (error) {
    if (error instanceof RailAttemptRefusalError) {
      recordAttemptRefusal(db, publicId, error.message, now);
      throw error;
    }
    if (!(error instanceof AmbiguousRailCreateError)) throw error;
    const unknown = db.transaction(() => {
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
      db.prepare("UPDATE checkout_quotes SET state='UNCERTAIN',updated_at=? WHERE id=? AND state='PAYMENT_CREATING'").run(now, pending.id);
    });
    unknown.immediate();
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
  if (prepared.state !== "PRICE_REVIEW_REQUIRED") return prepared;
  return confirmCheckout(db, rail, config, {
    customerId: input.customerId,
    customerEmail: input.customerEmail,
    quoteId: prepared.quoteId,
    idempotencyKey: input.idempotencyKey,
  }, now);
}

/** The intent state an attempt's read-back means; a paid intent stays paid (refunds belong to the order). */
const intentStateFor = (state: RailState | "CREATE_UNKNOWN"): IntentState => state === "PAID" ? "PAID"
  : state === "PENDING" || state === "CUSTOMER_ACTION_REQUIRED" ? "PENDING"
    : state === "CREATE_UNKNOWN" ? "UNCERTAIN"
      : state === "DECLINED" ? "DECLINED"
        : state === "EXPIRED" ? "EXPIRED"
          : "REVIEW_REQUIRED";

async function applyRailProjection(db: Database.Database, rail: PaymentRail, orderPublicId: string, observed: RailProjection, now: string) {
  let projection = observed;
  const context = db.prepare(`SELECT orders.id AS order_id,orders.customer_id,line.id AS line_id,product.kind,product.course_ref,
    orders.snapshot_hash,orders.total_kopecks,json_extract(orders.checkout_snapshot_json,'$.schema') AS snapshot_schema,
    attempt.id AS attempt_id,attempt.idempotency_key,attempt.fulfillment_acknowledged_at,line.immediate_access_json FROM orders JOIN order_lines line ON line.order_id=orders.id JOIN products product ON product.id=line.product_id
    JOIN checkout_attempts attempt ON attempt.order_id=orders.id WHERE orders.public_id=?`).get(orderPublicId) as {
      order_id: string; customer_id: string; line_id: string; kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
      course_ref: string | null; snapshot_hash: string; total_kopecks: number; snapshot_schema: string | null;
      attempt_id: string; idempotency_key: string; fulfillment_acknowledged_at: string | null; immediate_access_json: string | null;
    } | undefined;
  if (!context) throw new Error("ORDER_NOT_FOUND");
  if ((context.snapshot_schema === "refref.shared-checkout-snapshot/1" || context.snapshot_schema === "refref.shared-checkout-snapshot/2")
    && projection.snapshotHash !== `refref-jcs-1:${context.snapshot_hash}`) throw new Error("PAYMENT_SNAPSHOT_HASH_MISMATCH");
  // A grant follows an accepted payment of exactly the order's frozen total. Refref's read-back carries the
  // payment's amount with it; one that differs, or is missing, is a person's to look at, never access.
  if (projection.state === "PAID" && projection.paymentAmountKopecks !== context.total_kopecks) {
    projection = { ...projection, state: "REVIEW_REQUIRED" };
  }
  const apply = db.transaction(() => {
    const terminalRefund = db.prepare("SELECT 1 FROM orders WHERE id=? AND state='REFUNDED'").get(context.order_id);
    if (terminalRefund) return;
    db.prepare(`UPDATE checkout_attempts SET state=?,refref_attempt_id=?,refref_resolution_id=COALESCE(?,refref_resolution_id),
      refref_snapshot_hash=COALESCE(?,refref_snapshot_hash),checkout_url=?,observed_payment_projection_json=?,last_reconciled_at=?,updated_at=? WHERE id=?`)
      .run(attemptState(projection.state), projection.attemptId, projection.resolutionId ?? null, projection.snapshotHash ?? null,
        projection.checkoutUrl ?? null, JSON.stringify(projection), now, now, context.attempt_id);
    db.prepare("UPDATE checkout_quotes SET state=?,updated_at=? WHERE order_public_id=? AND consumed_at IS NOT NULL AND state<>'PAID'")
      .run(intentStateFor(projection.state), now, orderPublicId);
    if (projection.state === "PAID") {
      const alreadyActivated = db.prepare("SELECT 1 FROM course_entitlements WHERE source_order_line_id=?").get(context.line_id);
      const activationAt = context.immediate_access_json ? new Date().toISOString() : now;
      db.prepare("UPDATE orders SET state='FULFILLED',updated_at=? WHERE id=?").run(now, context.order_id);
      if (context.kind === "LAB") issueLabTicket(db, context.line_id, now);
      if (context.kind === "ONLINE_COURSE") grantEntitlement(db, { customerId: context.customer_id, scope: "COURSE", courseRef: context.course_ref!, sourceOrderLineId: context.line_id }, activationAt);
      if (context.kind === "COURSE_BUNDLE") grantEntitlement(db, { customerId: context.customer_id, scope: "ALL_COURSES", sourceOrderLineId: context.line_id }, activationAt);
      if (context.immediate_access_json && !alreadyActivated) db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
        VALUES (?, 'PAYMENT_RECONCILIATION','IMMEDIATE_ACCESS_ACTIVATED','ORDER',?,?,?)`).run(randomUUID(), orderPublicId,
          JSON.stringify({ paymentState: projection.state, paymentAmountKopecks: projection.paymentAmountKopecks,
            paymentObservedAt: activationAt, accessActivatedAt: activationAt, materialSet: JSON.parse(context.immediate_access_json) }), activationAt);
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

function recordAttemptRefusal(db: Database.Database, orderPublicId: string, code: string, now: string) {
  db.transaction(() => {
    const attempt = db.prepare(`SELECT attempt.id,attempt.order_id,attempt.state,attempt.refref_attempt_id FROM checkout_attempts attempt
      JOIN orders ON orders.id=attempt.order_id WHERE orders.public_id=?`).get(orderPublicId) as
      { id: string; order_id: string; state: string; refref_attempt_id: string | null } | undefined;
    if (!attempt || attempt.refref_attempt_id || !["CREATING", "CREATE_UNKNOWN"].includes(attempt.state)) return;
    db.prepare("UPDATE checkout_attempts SET state='DECLINED',observed_payment_projection_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify({ stage: "ATTEMPT_CREATE_REFUSED", code, externalAttemptAbsent: true }), now, attempt.id);
    db.prepare("UPDATE orders SET state='CANCELLED',updated_at=? WHERE id=?").run(now, attempt.order_id);
    db.prepare("UPDATE checkout_quotes SET state='DECLINED',failure_code=?,updated_at=? WHERE order_public_id=?")
      .run(code, now, orderPublicId);
  }).immediate();
}

export async function reconcileCheckout(db: Database.Database, rail: PaymentRail, orderPublicId: string, now = new Date().toISOString()) {
  const attempt = db.prepare(`SELECT attempt.idempotency_key,attempt.refref_attempt_id,attempt.state,attempt.request_payload_json,attempt.created_at
    FROM checkout_attempts attempt JOIN orders ON orders.id=attempt.order_id
    WHERE orders.public_id=?`).get(orderPublicId) as { idempotency_key: string; refref_attempt_id: string | null; state: string; request_payload_json: string; created_at: string } | undefined;
  if (!attempt) throw new Error("ORDER_NOT_FOUND");
  // A create still CREATING may be in flight in another request; once it has had time to answer it is
  // treated as unanswered: read back by order, then the identical request under the same key.
  const unanswered = attempt.state === "CREATE_UNKNOWN"
    || (attempt.state === "CREATING" && new Date(now).getTime() - new Date(attempt.created_at).getTime() >= CREATING_UNANSWERED_AFTER_MS);
  if (attempt.state === "CREATING" && !unanswered) return { orderPublicId, state: "CREATE_UNKNOWN" as const, checkoutUrl: undefined };
  if (attempt.state === "DECLINED" && !attempt.refref_attempt_id) return { orderPublicId, state: "DECLINED" as const, checkoutUrl: undefined };
  let projection: RailProjection;
  try { projection = unanswered
    ? await rail.recoverCreate(JSON.parse(attempt.request_payload_json) as PaymentCreateInput, attempt.refref_attempt_id ?? undefined)
    : await rail.reconcile({ idempotencyKey: attempt.idempotency_key, orderPublicId, attemptId: attempt.refref_attempt_id ?? "" });
  } catch (error) {
    if (error instanceof RailAttemptRefusalError) recordAttemptRefusal(db, orderPublicId, error.message, now);
    throw error;
  }
  return applyRailProjection(db, rail, orderPublicId, projection, now);
}

export async function reconcilePendingCheckouts(db: Database.Database, rail: PaymentRail, now = new Date().toISOString()) {
  const rows = db.prepare(`SELECT orders.public_id FROM orders JOIN checkout_attempts attempt ON attempt.order_id=orders.id
    WHERE (attempt.state IN ('CREATE_UNKNOWN','PENDING','CUSTOMER_ACTION_REQUIRED')
           -- A create whose request never answered (the process stopped after the order was committed).
           OR (attempt.state = 'CREATING' AND julianday(?) - julianday(attempt.created_at) >= ? / 86400000.0)
           -- Paid and granted, but Refref has not had the ACK: sent again until it has.
           OR (attempt.state = 'PAID' AND attempt.fulfillment_acknowledged_at IS NULL))
      AND (attempt.refref_attempt_id IS NULL OR attempt.refref_attempt_id NOT LIKE 'resolution:%')
    ORDER BY attempt.updated_at LIMIT 100`).all(now, CREATING_UNANSWERED_AFTER_MS) as Array<{ public_id: string }>;
  let reconciled = 0;
  let failed = 0;
  for (const row of rows) {
    try { await reconcileCheckout(db, rail, row.public_id, now); reconciled += 1; }
    catch { failed += 1; }
  }
  return { selected: rows.length, reconciled, failed };
}
