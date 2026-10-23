/** ART-394 / ADR-140 r7: opt-in v9 contract oracle; no runtime admission or ledger effects.
 * ART-417 (ADR-140 rev. 9, D231): `purchase-payable/2` adds the Refref-owned `claimPolicy`; every
 * other DTO and the canonicalization stay version 1. v1 payables remain historical vectors only. */
import { digest } from './shared-checkout-snapshot.js';

export const PURCHASE_INPUT_V1 = 'refref.purchase-input/1' as const;
export const PURCHASE_PAYABLE_V1 = 'refref.purchase-payable/1' as const;
export const PURCHASE_CLAIM_V1 = 'refref.purchase-cancellation-claim/1' as const;
export const PURCHASE_PAYABLE_V2 = 'refref.purchase-payable/2' as const;
/** D1.2 rev. 9: eligible-allocated successful refunds R must reach min(original Commission, frozen eligible paid amount). */
export const CLAIM_POLICY_D1_2 = 'D1_2_MIN_COMMISSION_ELIGIBLE/1' as const;
/** Rules this oracle can evaluate. A rule stays here while any accepted purchase may name it. */
export const KNOWN_CLAIM_POLICIES: readonly string[] = [CLAIM_POLICY_D1_2];
/** Closed registry of policies offered to NEW purchases. Withdrawing one never affects an accepted
 * manifest: verification and decisions use KNOWN_CLAIM_POLICIES and the frozen claimPolicy. */
export const SUPPORTED_CLAIM_POLICIES: readonly string[] = [CLAIM_POLICY_D1_2];
export function assertClaimPolicyAdmissible(claimPolicy: string): void {
  need(SUPPORTED_CLAIM_POLICIES.includes(claimPolicy), 'UNSUPPORTED_CLAIM_POLICY');
}
export type Evidence = { sourceRef: string; contentHash: string; occurredAt: string };
export type Rate = { type: 'PERCENT'; basisPoints: number } | { type: 'FIXED_RUB'; amountKopecks: number };
export type Service =
  | { kind: 'TOUR' | 'LAB'; serviceEndsAt: string; timeZone: string; provenance: Evidence }
  | { kind: 'LMS'; accessProfile: 'IMMEDIATE'; readinessEvidence: Evidence }
  | { kind: 'LMS'; accessProfile: 'DELAYED'; readinessEvidence: Evidence }
  | { kind: 'NON_SERVICE'; category: 'DELIVERY' | 'TIP' | 'OTHER' };
export interface PurchaseLine {
  lineRef: string;
  offerRef: string;
  quantity: number;
  /** Entire line after merchant promotions, BEFORE referral discount; never multiply by quantity. */
  merchantAmountKopecks: number;
  service: Service;
}
export interface PurchaseInputV1 {
  schema: typeof PURCHASE_INPUT_V1;
  businessId: string;
  purchaseRef: string;
  currency: 'RUB';
  lines: PurchaseLine[];
}
export interface FrozenTerms {
  campaignId: string;
  termsVersionId: string;
  termsHash: string;
  partnerId: string;
  participationId: string;
  profile: 'VNEXT_ONE_FULL_PAYMENT';
  eligibleLineRefs: string[];
  discount: Rate;
  reward: Rate;
}
export interface PayableLine extends PurchaseLine {
  eligible: boolean;
  referralDiscountKopecks: number;
  payableAmountKopecks: number;
}
export interface PurchasePayableV1 {
  schema: typeof PURCHASE_PAYABLE_V1;
  businessId: string;
  purchaseRef: string;
  currency: 'RUB';
  inputHash: string;
  quote: { quoteRef: string; issuedAt: string; expiresAt: string };
  terms: FrozenTerms;
  lines: PayableLine[];
  totalKopecks: number;
  eligibleAfterDiscountKopecks: number;
  rewardKopecks: number;
}
export interface PurchasePayableV2 extends Omit<PurchasePayableV1, 'schema'> {
  schema: typeof PURCHASE_PAYABLE_V2;
  /** Refref platform policy, never merchant input; part of payableHash, not of the campaign termsHash. */
  claimPolicy: string;
}
export type PurchasePayable = PurchasePayableV1 | PurchasePayableV2;
export interface PurchaseQuoteEnvelope {
  schema: 'refref.purchase-quote/1';
  payable: PurchasePayableV1;
  payableHash: string;
}
export interface PurchaseQuoteEnvelopeV2 {
  schema: 'refref.purchase-quote/2';
  payable: PurchasePayableV2;
  payableHash: string;
}
export class PurchaseContractError extends Error {
  constructor(readonly code: string) { super(code); }
}
function need(value: unknown, code: string): asserts value {
  if (!value) throw new PurchaseContractError(code);
}
function money(n: number): bigint {
  need(Number.isSafeInteger(n) && n >= 0, 'INVALID_INTEGER_AMOUNT');
  return BigInt(n);
}
function safe(n: bigint): number {
  need(n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= 0n, 'INTEGER_OVERFLOW');
  return Number(n);
}
const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function refs(values: string[]): string[] {
  need(values.every(v => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)), 'INVALID_REFERENCE');
  need(new Set(values).size === values.length, 'DUPLICATE_REFERENCE');
  return [...values].sort(cmp);
}
function instant(value: string): number {
  need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), 'INVALID_TIMESTAMP');
  const ms = Date.parse(value);
  need(Number.isFinite(ms) && new Date(ms).toISOString() === value, 'INVALID_TIMESTAMP');
  return ms;
}
function validateInput(input: PurchaseInputV1): void {
  need(input.schema === PURCHASE_INPUT_V1 && input.currency === 'RUB', 'UNSUPPORTED_SCHEMA_OR_CURRENCY');
  refs([input.businessId]); refs([input.purchaseRef]);
  need(input.lines.length > 0 && input.lines.length <= 1000, 'INVALID_LINE_COUNT');
  refs(input.lines.map(l => l.lineRef));
  for (const l of input.lines) {
    refs([l.offerRef]); money(l.merchantAmountKopecks);
    need(Number.isSafeInteger(l.quantity) && l.quantity > 0, 'INVALID_QUANTITY');
    if (l.service.kind === 'TOUR' || l.service.kind === 'LAB') {
      instant(l.service.serviceEndsAt);
      need(l.service.provenance?.sourceRef && l.service.provenance.contentHash, 'MISSING_END_PROVENANCE');
      const zone = l.service.timeZone;
      need(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-/]+)?$/.test(zone), 'INVALID_IANA_TIMEZONE');
      try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); }
      catch { throw new PurchaseContractError('INVALID_IANA_TIMEZONE'); }
    } else if (l.service.kind === 'LMS') {
      need(l.service.readinessEvidence?.sourceRef && l.service.readinessEvidence.contentHash, 'MISSING_READINESS_EVIDENCE');
    }
  }
  safe(input.lines.reduce((s, l) => s + money(l.merchantAmountKopecks), 0n));
}
/** Validate with the JSON Schema first. Sorting does not trim, coerce, case-fold or default. */
export function purchaseInputHash(input: PurchaseInputV1): string {
  validateInput(input);
  return digest({ ...input, lines: [...input.lines].sort((a, b) => cmp(a.lineRef, b.lineRef)) });
}
function rateAmount(base: bigint, rate: Rate, rounding: 'FLOOR' | 'HALF_AWAY'): bigint {
  if (rate.type === 'FIXED_RUB') return money(rate.amountKopecks);
  need(rate.type === 'PERCENT' && Number.isInteger(rate.basisPoints) && rate.basisPoints >= 0 && rate.basisPoints <= 10000, 'INVALID_BASIS_POINTS');
  return (base * BigInt(rate.basisPoints) + (rounding === 'HALF_AWAY' ? 5000n : 0n)) / 10000n;
}
/** 000034: percent discount floors ONCE; allocate by largest remainder with ASCII/C lineRef ties. */
export function resolvePurchase(input: PurchaseInputV1, terms: FrozenTerms, quote: PurchasePayableV1['quote']): PurchasePayableV1 {
  const inputHash = purchaseInputHash(input);
  need(terms.profile === 'VNEXT_ONE_FULL_PAYMENT', 'V9_PROFILE_NOT_QUALIFIED');
  need(instant(quote.issuedAt) < instant(quote.expiresAt), 'INVALID_QUOTE_WINDOW');
  const eligible = new Set(refs(terms.eligibleLineRefs));
  need([...eligible].every(ref => input.lines.some(l => l.lineRef === ref)), 'UNKNOWN_ELIGIBLE_LINE');
  for (const l of input.lines) {
    need(!(eligible.has(l.lineRef) && l.service.kind === 'NON_SERVICE'), 'NON_SERVICE_CANNOT_BE_ELIGIBLE');
    need(!(l.service.kind === 'LMS' && l.service.accessProfile === 'DELAYED'), 'DELAYED_LMS_PROFILE_NOT_QUALIFIED');
  }
  const gross = input.lines.filter(l => eligible.has(l.lineRef)).reduce((s, l) => s + money(l.merchantAmountKopecks), 0n);
  // Validate both rate structures even with a zero base.
  const requested = rateAmount(gross, terms.discount, 'FLOOR');
  rateAmount(0n, terms.reward, 'HALF_AWAY');
  const discount = requested < gross ? requested : gross;
  const shares = input.lines.map(l => {
    const numerator = eligible.has(l.lineRef) ? discount * money(l.merchantAmountKopecks) : 0n;
    return { line: l, share: gross ? numerator / gross : 0n, remainder: gross ? numerator % gross : 0n };
  });
  const ranked = shares.filter(s => eligible.has(s.line.lineRef)).sort((a, b) =>
    a.remainder === b.remainder ? cmp(a.line.lineRef, b.line.lineRef) : a.remainder > b.remainder ? -1 : 1);
  let left = discount - shares.reduce((s, l) => s + l.share, 0n);
  for (const s of ranked) { if (left > 0n) { s.share++; left--; } }
  const lines = shares.map(({ line, share }) => ({ ...line, eligible: eligible.has(line.lineRef),
    referralDiscountKopecks: safe(share), payableAmountKopecks: safe(money(line.merchantAmountKopecks) - share),
  })).sort((a, b) => cmp(a.lineRef, b.lineRef));
  const base = gross - discount;
  // Snapshot the terms and lines: subsequent mutable catalogue/campaign objects cannot alter them.
  return structuredClone({ schema: PURCHASE_PAYABLE_V1, businessId: input.businessId, purchaseRef: input.purchaseRef,
    currency: input.currency, inputHash, quote, terms: { ...terms, eligibleLineRefs: [...eligible].sort(cmp) }, lines,
    totalKopecks: safe(lines.reduce((s, l) => s + money(l.payableAmountKopecks), 0n)),
    eligibleAfterDiscountKopecks: safe(base), rewardKopecks: base === 0n ? 0 : safe(rateAmount(base, terms.reward, 'HALF_AWAY')) });
}
function payableV2(input: PurchaseInputV1, terms: FrozenTerms, quote: PurchasePayableV1['quote'],
  claimPolicy: string): PurchasePayableV2 {
  need(KNOWN_CLAIM_POLICIES.includes(claimPolicy), 'UNKNOWN_CLAIM_POLICY');
  return { ...resolvePurchase(input, terms, quote), schema: PURCHASE_PAYABLE_V2, claimPolicy };
}
/** A NEW payable: the same economics as v1, frozen with a claim policy Refref currently offers. */
export function resolvePurchaseV2(input: PurchaseInputV1, terms: FrozenTerms, quote: PurchasePayableV1['quote'],
  claimPolicy: string): PurchasePayableV2 {
  assertClaimPolicyAdmissible(claimPolicy);
  return payableV2(input, terms, quote, claimPolicy);
}
export function purchasePayableHash(payable: PurchasePayable): string {
  const input: PurchaseInputV1 = { schema: PURCHASE_INPUT_V1, businessId: payable.businessId,
    purchaseRef: payable.purchaseRef, currency: payable.currency,
    lines: payable.lines.map(({ lineRef, offerRef, quantity, merchantAmountKopecks, service }) =>
      ({ lineRef, offerRef, quantity, merchantAmountKopecks, service })) };
  const expected: PurchasePayable = payable.schema === PURCHASE_PAYABLE_V2
    ? payableV2(input, payable.terms, payable.quote, payable.claimPolicy)
    : resolvePurchase(input, payable.terms, payable.quote);
  const normalized = { ...payable, lines: [...payable.lines].sort((a, b) => cmp(a.lineRef, b.lineRef)),
    terms: { ...payable.terms, eligibleLineRefs: refs(payable.terms.eligibleLineRefs) } };
  need(digest(expected) === digest(normalized), 'PAYABLE_MANIFEST_MISMATCH');
  return digest(normalized);
}
export type PurchaseBinding = { businessId: string; purchaseRef: string; payableHash: string };
export function assertPurchaseBinding(payable: PurchasePayable, binding: PurchaseBinding): void {
  need(payable.businessId === binding.businessId && payable.purchaseRef === binding.purchaseRef, 'PURCHASE_BINDING_MISMATCH');
  need(purchasePayableHash(payable) === binding.payableHash, 'PAYABLE_HASH_MISMATCH');
}
/** Structured tuples, never ambiguous concatenation; independent of campaign, terms and partner. */
export function purchaseIdentity(input: Pick<PurchaseInputV1, 'businessId' | 'purchaseRef'>): string {
  return digest(['refref.purchase-identity/1', input.businessId, input.purchaseRef]);
}
export type ProviderBinding = { provider: string; connectionId: string; paymentRef: string };
export function providerPaymentIdentity(payment: ProviderBinding): string {
  return digest(['refref.provider-payment-identity/1', payment.provider, payment.connectionId, payment.paymentRef]);
}
export function assertCompatibleCampaigns(terms: FrozenTerms[]): void {
  need(terms.length > 0 && terms.every(t => digest(t) === digest(terms[0])), 'MULTI_CAMPAIGN_CART_REQUIRES_SPLIT');
}
export interface BankFullPayment extends PurchaseBinding {
  kind: 'BANK_FULL_PAYMENT';
  payment: ProviderBinding;
  currency: 'RUB';
  amountKopecks: number;
  status: 'SUCCEEDED';
  /** Bank completion and durable independent Refref confirmation, never merchant timestamps. */
  succeededAt: string;
  verifiedAt: string;
  independentEvidence: Evidence;
}
export interface PurchaseAcceptance extends PurchaseBinding {
  schema: 'refref.purchase-acceptance/1';
  inputHash: string;
  quoteRef: string;
  acceptedAt: string;
}
export interface ClaimAdmissionReceipt extends PurchaseBinding {
  schema: 'refref.claim-admission-receipt/1';
  claimHash: string;
  admissionKey: string;
  effectKey: string;
  receivedAt: string;
  decisionDueAt: string;
  calendarVersion: string;
  ticketRef: string;
}
export interface PurchaseQualification extends PurchaseBinding {
  schema: 'refref.purchase-qualification/1';
  inputHash: string;
  rewardScopeId: string;
  purchaseQualifiedAt: string;
  payment: BankFullPayment;
  acceptance: PurchaseAcceptance;
  serviceAnchors: { lineRef: string; anchorAt: string }[];
  purchaseAnchorAt: string | null;
  deadlinePolicy: 'P7-14-P3-30-Europe-Moscow/1';
  initialClaimDeadlineAt: string | null;
  claimDeadlineAt: string | null;
  hardClaimDeadlineAt: string | null;
}
/** Add Moscow calendar dates while preserving the local time of day (P7/P3). */
function calendarDays(at: string, days: number): string {
  const ms = instant(at);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const local = (t: number): number => {
    const p = Object.fromEntries(formatter.formatToParts(t).map(p => [p.type, p.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second), new Date(t).getUTCMilliseconds());
  };
  const target = local(ms) + days * 86400000;
  let result = target;
  for (let i = 0; i < 4; i++) result += target - local(result);
  need(local(result) === target, 'CALENDAR_TIME_NOT_REPRESENTABLE');
  return new Date(result).toISOString();
}
export function qualifyPurchase(payable: PurchasePayable, acceptance: PurchaseAcceptance, payment: BankFullPayment, purchaseQualifiedAt: string): PurchaseQualification {
  const payableHash = purchasePayableHash(payable);
  assertPurchaseBinding(payable, payment);
  need(payment.kind === 'BANK_FULL_PAYMENT' && payment.status === 'SUCCEEDED' && payment.currency === payable.currency &&
    payment.amountKopecks === payable.totalKopecks && payment.amountKopecks > 0 && payment.independentEvidence?.sourceRef && payment.independentEvidence.contentHash,
  'ONE_BANK_FULL_PAYMENT_REQUIRED');
  need(instant(payment.succeededAt) <= instant(payment.verifiedAt) && instant(payment.verifiedAt) <= instant(purchaseQualifiedAt),
    'BANK_PAYMENT_NOT_CONFIRMED_AT_QUALIFICATION');
  assertPurchaseBinding(payable, acceptance);
  need(acceptance.inputHash === payable.inputHash && acceptance.quoteRef === payable.quote.quoteRef, 'ACCEPTANCE_QUOTE_MISMATCH');
  need(instant(acceptance.acceptedAt) >= instant(payable.quote.issuedAt) && instant(acceptance.acceptedAt) < instant(payable.quote.expiresAt) &&
    instant(purchaseQualifiedAt) >= instant(acceptance.acceptedAt), 'ACCEPTANCE_OUTSIDE_QUOTE_WINDOW');
  for (const l of payable.lines) {
    if (l.service.kind === 'LMS') need(instant(l.service.readinessEvidence.occurredAt) <= instant(purchaseQualifiedAt), 'LMS_NOT_READY_AT_QUALIFICATION');
  }
  const serviceAnchors = payable.lines.filter(l => l.eligible && l.service.kind !== 'NON_SERVICE').map(l => ({
    lineRef: l.lineRef, anchorAt: l.service.kind === 'TOUR' || l.service.kind === 'LAB' ? l.service.serviceEndsAt : purchaseQualifiedAt,
  }));
  const purchaseAnchorAt = serviceAnchors.length ? serviceAnchors.map(a => a.anchorAt).sort().at(-1)! : null;
  const initialClaimDeadlineAt = purchaseAnchorAt ? calendarDays(purchaseAnchorAt, 14) : null;
  return structuredClone({ schema: 'refref.purchase-qualification/1', businessId: payable.businessId, purchaseRef: payable.purchaseRef,
    payableHash, inputHash: payable.inputHash, rewardScopeId: purchaseIdentity(payable), purchaseQualifiedAt, payment, acceptance, serviceAnchors,
    purchaseAnchorAt, deadlinePolicy: 'P7-14-P3-30-Europe-Moscow/1', initialClaimDeadlineAt,
    claimDeadlineAt: initialClaimDeadlineAt, hardClaimDeadlineAt: initialClaimDeadlineAt ? calendarDays(initialClaimDeadlineAt, 30) : null });
}
export interface CancellationCoverage {
  lineRef: string;
  /** Whole line or merchant-local opaque segments; NOT money units or traveller identifiers. */
  segments: { coverageRef: string; quantity: number; evidence: Evidence[] }[];
  coveredQuantity: number;
}
export interface RefundBreakdown extends PurchaseBinding {
  operation: ProviderBinding & { refundRef: string };
  amountKopecks: number;
  currency: 'RUB';
  allocationSource: 'REFREF_COMMAND' | 'MERCHANT_BANK_EXECUTED';
  allocationEvidence: Evidence;
  lineAllocations: { lineRef: string; amountKopecks: number }[];
}
/** Independent authoritative operation snapshot; never part of the admitted claim/hash. */
export type BankRefundState = PurchaseBinding & {
  operation: ProviderBinding & { refundRef: string };
  amountKopecks: number;
  currency: 'RUB';
  verifiedAt: string;
  independentEvidence: Evidence;
} & ({ status: 'PENDING' } | { status: 'SUCCEEDED'; succeededAt: string });
export interface ClaimDecisionSnapshot {
  schema: 'refref.claim-decision-snapshot/1';
  /** Original durable receipt, loaded by the server, not reconstructed from the request. */
  admission: ClaimAdmissionReceipt;
  outcome: 'UPHELD' | 'REJECTED' | 'EXPIRED';
  decidedAt: string;
  verifiedCoverage: { lineRef: string; coveredQuantity: number; nonOverlapping: boolean; rightsTerminated: boolean; evidence: Evidence }[];
  refundStates: BankRefundState[];
}
export interface CancellationClaimV1 extends PurchaseBinding {
  schema: typeof PURCHASE_CLAIM_V1;
  scope: 'WHOLE_PURCHASE';
  idempotencyKey: string;
  reason: 'ALL_ELIGIBLE_SERVICES_CANCELLED';
  coverage: CancellationCoverage[];
  refunds: RefundBreakdown[];
}
/** ART-417 slice 3: a later bound refund added to an OPEN claim. The admitted claim, its hash, receipt
 * and decisionDueAt never change; each supplement is a separate immutable fact with its own receipt. */
export const CLAIM_SUPPLEMENT_V1 = 'refref.claim-refund-supplement/1' as const;
export interface ClaimRefundSupplement extends PurchaseBinding {
  schema: typeof CLAIM_SUPPLEMENT_V1;
  /** The admitted claim this refund supplements. */
  claimHash: string;
  idempotencyKey: string;
  refund: RefundBreakdown;
  evidence: Evidence;
}
export interface ClaimSupplementReceipt extends PurchaseBinding {
  schema: 'refref.claim-supplement-receipt/1';
  claimHash: string;
  refundIdentity: string;
  requestKey: string;
  supplementHash: string;
  receivedAt: string;
  /** The original admission deadline, unchanged by any supplement. */
  decisionDueAt: string;
}
export function refundOperationIdentity(refund: Pick<RefundBreakdown, 'operation'>): string {
  return digest(['refref.refund-operation/1', providerPaymentIdentity(refund.operation), refund.operation.refundRef]);
}
export function claimAdmissionKey(claim: PurchaseBinding): string {
  return digest(['refref.claim-admission/1', purchaseIdentity(claim), 'ALL_ELIGIBLE_SERVICES_CANCELLED']);
}
export function claimEffectKey(claim: PurchaseBinding): string {
  return digest(['refref.claim-zero-reward/1', purchaseIdentity(claim)]);
}
/**
 * Contract oracle only. `priorRefunds` MUST be the complete durable bank-operation history,
 * Admission checks asserted coverage; sufficient cancellation proof remains a reviewer decision.
 * Admission accepts bank PENDING; it does not grant an upheld decision or move money.
 */
export function assertClaimAdmission(payable: PurchasePayable, qualified: PurchaseQualification,
  claim: CancellationClaimV1, receivedAt: string, priorRefunds: RefundBreakdown[],
  currentClaimDeadlineAt: string | null = qualified.claimDeadlineAt): void {
  assertPurchaseBinding(payable, qualified); assertPurchaseBinding(payable, claim);
  need(digest(qualifyPurchase(payable, qualified.acceptance, qualified.payment, qualified.purchaseQualifiedAt)) === digest(qualified),
    'QUALIFICATION_SNAPSHOT_MISMATCH');
  need(claim.scope === 'WHOLE_PURCHASE' && claim.reason === 'ALL_ELIGIBLE_SERVICES_CANCELLED', 'PARTIAL_PURCHASE_CLAIM_REFUSED');
  need(payable.rewardKopecks > 0 && qualified.claimDeadlineAt && instant(receivedAt) >= instant(qualified.purchaseQualifiedAt) &&
    currentClaimDeadlineAt && instant(receivedAt) < instant(currentClaimDeadlineAt), 'CLAIM_OUTSIDE_WINDOW');
  need(!currentClaimDeadlineAt || (qualified.hardClaimDeadlineAt &&
    instant(currentClaimDeadlineAt) <= instant(qualified.hardClaimDeadlineAt)), 'CLAIM_DEADLINE_EXCEEDS_HARD_CAP');
  const eligible = payable.lines.filter(l => l.eligible && l.service.kind !== 'NON_SERVICE');
  refs(claim.coverage.map(c => c.lineRef));
  need(claim.coverage.length === eligible.length, 'INCOMPLETE_CANCELLATION_COVERAGE');
  for (const l of eligible) {
    const c = claim.coverage.find(c => c.lineRef === l.lineRef);
    need(c && c.coveredQuantity === l.quantity, 'INCOMPLETE_CANCELLATION_COVERAGE');
    refs(c.segments.map(s => s.coverageRef));
    need(c.segments.length > 0 && c.segments.every(s => Number.isSafeInteger(s.quantity) && s.quantity > 0 && s.evidence.length > 0) &&
      c.segments.reduce((s, v) => s + BigInt(v.quantity), 0n) === BigInt(l.quantity), 'OVERLAPPING_OR_INCOMPLETE_QUANTITY');
  }
  need(claim.refunds.length > 0, 'REFUND_OPERATION_REQUIRED');
  const allocationHash = (r: RefundBreakdown): string => digest({ operation: r.operation, amountKopecks: r.amountKopecks,
    lineAllocations: [...r.lineAllocations].sort((a,b) => cmp(a.lineRef,b.lineRef)),
    allocationSource: r.allocationSource, allocationEvidence: r.allocationEvidence });
  const history = new Map<string, string>();
  const totals = new Map<string, bigint>();
  function checkRefund(r: RefundBreakdown): void {
    assertPurchaseBinding(payable, r);
    need(providerPaymentIdentity(r.operation) === providerPaymentIdentity(qualified.payment.payment), 'REFUND_PAYMENT_MISMATCH');
    need(r.currency === payable.currency && money(r.amountKopecks) > 0n, 'INVALID_REFUND_AMOUNT');
    refs(r.lineAllocations.map(a => a.lineRef));
    need(r.allocationEvidence?.sourceRef && r.allocationEvidence.contentHash,
      'UNPROVEN_REFUND_ALLOCATION');
    const sum = r.lineAllocations.reduce((s, a) => s + money(a.amountKopecks), 0n);
    need(sum === BigInt(r.amountKopecks), 'REFUND_BREAKDOWN_SUM_MISMATCH');
  }
  function accumulate(r: RefundBreakdown): void {
    checkRefund(r);
    for (const a of r.lineAllocations) {
      const l = payable.lines.find(l => l.lineRef === a.lineRef);
      need(l, 'UNKNOWN_REFUND_LINE');
      const amount = (totals.get(a.lineRef) ?? 0n) + money(a.amountKopecks);
      need(amount <= BigInt(l.payableAmountKopecks), 'REFUND_EXCEEDS_LINE_REMAINDER');
      totals.set(a.lineRef, amount);
    }
    // The breakdown is immutable; bank progression lives in a separate authoritative snapshot.
    history.set(refundOperationIdentity(r), allocationHash(r));
  }
  for (const r of priorRefunds) {
    need(!history.has(refundOperationIdentity(r)), 'DUPLICATE_REFUND_OPERATION'); accumulate(r);
  }
  const cited = new Set<string>();
  for (const r of claim.refunds) {
    const key = refundOperationIdentity(r);
    need(!cited.has(key), 'DUPLICATE_REFUND_OPERATION'); cited.add(key);
    checkRefund(r);
    const old = history.get(key);
    if (old) {
      need(allocationHash(r) === old, 'REFUND_BREAKDOWN_REPLAY_CONFLICT');
    } else accumulate(r);
  }
  need(claim.refunds.some(r => r.lineAllocations.some(a => a.amountKopecks > 0 && payable.lines.some(l => l.lineRef === a.lineRef && l.eligible))),
    'REFUND_HAS_NO_POSITIVE_ELIGIBLE_AMOUNT');
}
const eligibleRefund = (payable: PurchasePayable, r: RefundBreakdown): boolean =>
  r.lineAllocations.some(a => a.amountKopecks > 0 && payable.lines.some(l => l.lineRef === a.lineRef && l.eligible));
/** Contract oracle for one supplement. `accepted` are the server-owned supplements already recorded for
 * this claim; `priorRefunds` the durable bound breakdowns. Bank status is never part of a supplement. */
export function assertClaimSupplement(payable: PurchasePayable, claim: CancellationClaimV1, admission: ClaimAdmissionReceipt,
  supplement: ClaimRefundSupplement, receivedAt: string, priorRefunds: RefundBreakdown[], accepted: ClaimRefundSupplement[]): void {
  assertPurchaseBinding(payable, admission); assertPurchaseBinding(payable, supplement); assertPurchaseBinding(payable, supplement.refund);
  need(supplement.schema === CLAIM_SUPPLEMENT_V1 && admission.claimHash === digest(claim) &&
    supplement.claimHash === admission.claimHash, 'SUPPLEMENT_CLAIM_MISMATCH');
  // Strictly before the ORIGINAL decision deadline; a supplement never extends it.
  need(instant(receivedAt) >= instant(admission.receivedAt) && instant(receivedAt) < instant(admission.decisionDueAt),
    'SUPPLEMENT_OUTSIDE_WINDOW');
  need(supplement.evidence?.sourceRef && supplement.evidence.contentHash, 'SUPPLEMENT_EVIDENCE_REQUIRED');
  const key = refundOperationIdentity(supplement.refund);
  need(![...claim.refunds, ...accepted.map(s => s.refund)].some(r => refundOperationIdentity(r) === key), 'REFUND_ALREADY_CITED');
  need(priorRefunds.some(r => refundOperationIdentity(r) === key && digest(r) === digest(supplement.refund)), 'REFUND_NOT_BOUND');
  need(eligibleRefund(payable, supplement.refund), 'REFUND_HAS_NO_POSITIVE_ELIGIBLE_AMOUNT');
}
/** After admission + authorised review; receipt, bank snapshots and accepted supplements are server-owned. */
export function claimRewardEffect(payable: PurchasePayable, qualified: PurchaseQualification, claim: CancellationClaimV1,
  decision: ClaimDecisionSnapshot, priorRefunds: RefundBreakdown[],
  admittedDeadlineAt: string | null = qualified.claimDeadlineAt, supplements: ClaimRefundSupplement[] = [],
): number {
  const { admission } = decision;
  assertPurchaseBinding(payable, admission);
  need(admission.claimHash === digest(claim) && admission.admissionKey === claimAdmissionKey(claim) &&
    admission.effectKey === claimEffectKey(claim), 'ADMITTED_CLAIM_MISMATCH');
  assertClaimAdmission(payable, qualified, claim, admission.receivedAt, priorRefunds, admittedDeadlineAt);
  const due = instant(admission.decisionDueAt);
  const decided = instant(decision.decidedAt);
  need(instant(admission.receivedAt) < due && decided >= instant(admission.receivedAt), 'INVALID_DECISION_TIME');
  if (decision.outcome !== 'UPHELD' || decided >= due) return 0;
  for (const l of payable.lines.filter(l => l.eligible)) {
    const c = decision.verifiedCoverage.find(c => c.lineRef === l.lineRef);
    need(c && c.coveredQuantity === l.quantity && c.nonOverlapping && c.rightsTerminated && c.evidence?.sourceRef && c.evidence.contentHash,
      'CANCELLATION_NOT_VERIFIED');
  }
  for (const s of supplements) {
    assertPurchaseBinding(payable, s); assertPurchaseBinding(payable, s.refund);
    need(s.schema === CLAIM_SUPPLEMENT_V1 && s.claimHash === admission.claimHash, 'SUPPLEMENT_CLAIM_MISMATCH');
    need(priorRefunds.some(r => refundOperationIdentity(r) === refundOperationIdentity(s.refund) && digest(r) === digest(s.refund)),
      'REFUND_NOT_BOUND');
  }
  // The admitted refunds plus accepted supplements; one canonical bank operation is counted once.
  const cited = [...claim.refunds, ...supplements.map(s => s.refund)];
  need(new Set(cited.map(refundOperationIdentity)).size === cited.length, 'DUPLICATE_REFUND_OPERATION');
  const states = new Map<string, BankRefundState>();
  for (const state of decision.refundStates) {
    assertPurchaseBinding(payable, state);
    const key = refundOperationIdentity(state);
    need(!states.has(key), 'DUPLICATE_BANK_REFUND_STATE');
    const refund = cited.find(r => refundOperationIdentity(r) === key);
    need(refund && refund.amountKopecks === state.amountKopecks && refund.currency === state.currency,
      'BANK_REFUND_STATE_MISMATCH');
    need(state.independentEvidence?.sourceRef && state.independentEvidence.contentHash, 'INDEPENDENT_BANK_EVIDENCE_REQUIRED');
    instant(state.verifiedAt);
    if (state.status === 'SUCCEEDED') need(instant(state.succeededAt) <= instant(state.verifiedAt), 'INVALID_BANK_CONFIRMATION_TIME');
    states.set(key, state);
  }
  const eligibleAmount = (r: RefundBreakdown): bigint => r.lineAllocations.reduce((s, a) =>
    payable.lines.some(l => l.lineRef === a.lineRef && l.eligible) ? s + money(a.amountKopecks) : s, 0n);
  // Cited operations are already unique by identity, so each successful refund counts once.
  const succeeded = cited.filter(r => {
    const state = states.get(refundOperationIdentity(r));
    return state?.status === 'SUCCEEDED' && instant(state.verifiedAt) <= decided &&
      instant(state.verifiedAt) < due && instant(state.succeededAt) < due;
  });
  need(succeeded.some(r => eligibleAmount(r) > 0n), 'SUCCESSFUL_REFUND_REQUIRED');
  if (payable.schema === PURCHASE_PAYABLE_V2) {
    // D1.2 rev. 9: the bound is on the required refund; the Commission is never prorated.
    need(payable.claimPolicy === CLAIM_POLICY_D1_2, 'UNKNOWN_CLAIM_POLICY');
    const c = BigInt(payable.rewardKopecks), e = BigInt(payable.eligibleAfterDiscountKopecks);
    need(succeeded.reduce((s, r) => s + eligibleAmount(r), 0n) >= (c < e ? c : e), 'REFUND_BELOW_CLAIM_POLICY_THRESHOLD');
  }
  return -payable.rewardKopecks;
}

/** Reference conflict classification; consumers must enforce both identities atomically in PostgreSQL. */
export function qualificationReplay(existing: PurchaseQualification, candidate: PurchaseQualification): 'REPLAY' {
  const samePurchase = purchaseIdentity(existing) === purchaseIdentity(candidate);
  const samePayment = providerPaymentIdentity(existing.payment.payment) === providerPaymentIdentity(candidate.payment.payment);
  need(samePurchase || !samePayment, 'PAYMENT_ALREADY_BOUND_TO_ANOTHER_PURCHASE');
  need(samePurchase, 'DIFFERENT_PURCHASE');
  need(samePayment && existing.payableHash === candidate.payableHash && existing.inputHash === candidate.inputHash,
    'PURCHASE_ALREADY_QUALIFIED_DIFFERENT_MANIFEST');
  return 'REPLAY';
}
