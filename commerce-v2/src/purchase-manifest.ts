import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./refref-contract/purchase-manifest-v2.schema.json";
import { digest } from "./refref-contract/shared-checkout-snapshot";
import { assertClaimPolicyAdmissible, purchaseInputHash, purchasePayableHash, qualifyPurchase,
  type PurchaseInputV1, type PurchaseLine, type PurchaseQuoteEnvelopeV2, type PurchaseAcceptance,
  type BankFullPayment, type PurchaseQualification, type RefundBreakdown } from "./refref-contract/purchase-manifest-v1";

// Use the published closed schema without coercion, defaults or removal of unknown fields.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validate = (name: string, value: unknown) => {
  if (!ajv.validate({ $ref: `${schema.$id}#/$defs/${name}` }, value)) throw new Error(`PURCHASE_SCHEMA_INVALID:${name}`);
};

export type FrozenPurchaseInput = { input: PurchaseInputV1; inputHash: string };
export function merchantPurchase(businessId: string, purchaseRef: string, lines: PurchaseLine[]): FrozenPurchaseInput {
  const input: PurchaseInputV1 = { schema: "refref.purchase-input/1", businessId, purchaseRef, currency: "RUB",
    lines: structuredClone(lines).sort((a, b) => a.lineRef < b.lineRef ? -1 : a.lineRef > b.lineRef ? 1 : 0) };
  validate("input", input);
  return { input, inputHash: purchaseInputHash(input) };
}

/** The authenticated rail supplies the Business; never take it from a buyer request. */
export function consumePurchaseQuote(frozen: FrozenPurchaseInput, response: unknown): PurchaseQuoteEnvelopeV2 {
  validate("input", frozen.input);
  validate("quoteEnvelope", response);
  const envelope = response as PurchaseQuoteEnvelopeV2;
  const payable = envelope.payable;
  assertClaimPolicyAdmissible(payable.claimPolicy);
  if (frozen.inputHash !== purchaseInputHash(frozen.input) || payable.inputHash !== frozen.inputHash
    || payable.businessId !== frozen.input.businessId || payable.purchaseRef !== frozen.input.purchaseRef) {
    throw new Error("PURCHASE_INPUT_BINDING_MISMATCH");
  }
  const reconstructed = merchantPurchase(payable.businessId, payable.purchaseRef, payable.lines.map(
    ({ lineRef, offerRef, quantity, merchantAmountKopecks, service }) => ({ lineRef, offerRef, quantity, merchantAmountKopecks, service })));
  if (reconstructed.inputHash !== frozen.inputHash) throw new Error("PURCHASE_INPUT_BINDING_MISMATCH");
  if (purchasePayableHash(payable) !== envelope.payableHash) throw new Error("PAYABLE_HASH_MISMATCH");
  return structuredClone(envelope);
}

export function acceptPurchase(frozen: FrozenPurchaseInput, response: unknown, acceptedAt: string): PurchaseAcceptance {
  const { payable, payableHash } = consumePurchaseQuote(frozen, response);
  if (acceptedAt < payable.quote.issuedAt || acceptedAt >= payable.quote.expiresAt) throw new Error("ACCEPTANCE_OUTSIDE_QUOTE_WINDOW");
  const acceptance: PurchaseAcceptance = { schema: "refref.purchase-acceptance/1", businessId: payable.businessId,
    purchaseRef: payable.purchaseRef, payableHash, inputHash: frozen.inputHash, quoteRef: payable.quote.quoteRef, acceptedAt };
  validate("acceptance", acceptance);
  return acceptance;
}

/** Called only with independently confirmed Refref bank evidence, never a merchant PAID flag/receipt. */
export function consumePurchaseQualification(frozen: FrozenPurchaseInput, envelope: PurchaseQuoteEnvelopeV2,
  acceptance: PurchaseAcceptance, payment: BankFullPayment, purchaseQualifiedAt: string): PurchaseQualification {
  consumePurchaseQuote(frozen, envelope);
  validate("acceptance", acceptance);
  validate("bankFullPayment", payment);
  const qualified = qualifyPurchase(envelope.payable, acceptance, payment, purchaseQualifiedAt);
  validate("qualification", qualified);
  return qualified;
}

/** Customer refunds preserve the original payable/reward and carry immutable line amounts. */
export function purchaseRefundAllocation(envelope: PurchaseQuoteEnvelopeV2, refund: RefundBreakdown) {
  validate("quoteEnvelope", envelope);
  validate("refund", refund);
  const { payable } = envelope;
  if (purchasePayableHash(payable) !== envelope.payableHash || refund.payableHash !== envelope.payableHash
    || refund.businessId !== payable.businessId || refund.purchaseRef !== payable.purchaseRef
    || refund.currency !== payable.currency) throw new Error("PURCHASE_REFUND_BINDING_MISMATCH");
  const seen = new Set<string>();
  let total = BigInt(0);
  for (const allocation of refund.lineAllocations) {
    const line = payable.lines.find(l => l.lineRef === allocation.lineRef);
    if (!line || seen.has(line.lineRef) || !Number.isSafeInteger(allocation.amountKopecks)
      || allocation.amountKopecks < 0 || allocation.amountKopecks > line.payableAmountKopecks) throw new Error("PURCHASE_REFUND_ALLOCATION_INVALID");
    seen.add(line.lineRef);
    total += BigInt(allocation.amountKopecks);
  }
  if (!Number.isSafeInteger(refund.amountKopecks) || refund.amountKopecks <= 0
    || total !== BigInt(refund.amountKopecks)) throw new Error("PURCHASE_REFUND_ALLOCATION_INVALID");
  return { breakdown: structuredClone(refund), breakdownHash: digest(refund), rewardKopecks: payable.rewardKopecks };
}
