import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./refref-contract/purchase-manifest-v2.schema.json";
import { digest } from "./refref-contract/shared-checkout-snapshot";
import { assertClaimPolicyAdmissible, purchaseInputHash, purchasePayableHash, qualifyPurchase,
  type PurchaseInputV1, type PurchaseLine, type PurchaseQuoteEnvelopeV2, type PurchaseAcceptance,
  providerPaymentIdentity, refundOperationIdentity, type BankRefundState, type BankFullPayment, type PurchaseQualification, type RefundBreakdown } from "./refref-contract/purchase-manifest-v1";

// Use the published closed schema without coercion, defaults or removal of unknown fields.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validate = (name: string, value: unknown) => {
  if (!ajv.validate(`${schema.$id}#/$defs/${name}`, value)) throw new Error(`PURCHASE_SCHEMA_INVALID:${name}`);
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
  const accepted = Date.parse(acceptedAt), issued = Date.parse(payable.quote.issuedAt), expires = Date.parse(payable.quote.expiresAt);
  if (![accepted, issued, expires].every(Number.isFinite) || accepted < issued || accepted >= expires) throw new Error("ACCEPTANCE_OUTSIDE_QUOTE_WINDOW");
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

/** Read-only completion of the existing full-line refund flow. Allocations are
 * merchant materials; only separately ingested bank SUCCEEDED facts count. */
export function consumePurchaseRefunds(quote:PurchaseQuoteEnvelopeV2,qualification:PurchaseQualification,lineRef:string,raw:unknown) {
  const o=raw as {schema:string;businessId:string;purchaseRef:string;payableHash:string;refunds:{breakdown:RefundBreakdown;fact:BankRefundState|null}[]};
  const p=quote.payable,line=p.lines.find(l=>l.lineRef===lineRef);
  if(!o||Object.keys(o).sort().join()!==["schema","businessId","purchaseRef","payableHash","refunds"].sort().join()
    ||o.schema!=="refref.purchase-refunds/1"||o.businessId!==p.businessId||o.purchaseRef!==p.purchaseRef||o.payableHash!==quote.payableHash
    ||!Array.isArray(o.refunds)||!line)throw new Error("PURCHASE_REFUND_BINDING_MISMATCH");
  const payment=qualification.payment.payment,seen=new Set<string>();let amount=0;
  for(const item of o.refunds){
    if(!item||Object.keys(item).sort().join()!=="breakdown,fact")throw new Error("PURCHASE_REFUND_INVALID");
    const r=item.breakdown;validate("refund",r);
    const binding=(x:RefundBreakdown|BankRefundState)=>x.businessId===p.businessId&&x.purchaseRef===p.purchaseRef&&x.payableHash===quote.payableHash
      &&x.operation.provider===payment.provider&&x.operation.connectionId===payment.connectionId&&x.operation.paymentRef===payment.paymentRef&&x.currency==="RUB";
    const id=refundOperationIdentity(r);if(!binding(r)||seen.has(id))throw new Error("PURCHASE_REFUND_BINDING_MISMATCH");seen.add(id);
    const allocated=r.lineAllocations.reduce((n,a)=>n+a.amountKopecks,0);
    if(allocated!==r.amountKopecks||r.lineAllocations.some(a=>!p.lines.some(l=>l.lineRef===a.lineRef)))throw new Error("PURCHASE_REFUND_ALLOCATION_MISMATCH");
    const f=item.fact;if(!f)continue;validate("bankRefundState",f);
    if(!binding(f)||refundOperationIdentity(f)!==id||f.amountKopecks!==r.amountKopecks)throw new Error("PURCHASE_REFUND_FACT_MISMATCH");
    if(f.status!=="SUCCEEDED")continue;
    if(!f.succeededAt||Date.parse(f.succeededAt)>Date.parse(f.verifiedAt)||Date.parse(f.verifiedAt)>Date.now())throw new Error("PURCHASE_REFUND_CHRONOLOGY_MISMATCH");
    amount+=r.lineAllocations.filter(a=>a.lineRef===lineRef).reduce((n,a)=>n+a.amountKopecks,0);
  }
  if(!Number.isSafeInteger(amount)||amount>line.payableAmountKopecks)throw new Error("PURCHASE_REFUND_ALLOCATION_MISMATCH");
  return amount===line.payableAmountKopecks&&amount>0?{paymentId:providerPaymentIdentity(payment),amountKopecks:amount,status:"SUCCEEDED" as const}:null;
}
