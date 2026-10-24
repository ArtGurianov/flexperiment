import {describe,expect,it,vi} from "vitest";
import {RefrefV9PaymentRail} from "../src/refref-v9-payment-rail";
import {AmbiguousRailCreateError,type PaymentCreateInput,type PaymentRefundInput} from "../src/checkout";
import producers from "./fixtures/purchase-manifest/producers.json";
import {resolvePurchaseV2,purchasePayableHash,CLAIM_POLICY_D1_2,type PurchaseInputV1,type FrozenTerms,type BankFullPayment} from "../src/refref-contract/purchase-manifest-v1";
import {merchantPurchase,acceptPurchase,consumePurchaseQualification} from "../src/purchase-manifest";
import {checkoutSnapshotHash,type SharedCheckoutSnapshot} from "../src/checkout-snapshot";

function paymentFixture(){
 const f=producers.fixtures.find(f=>f.name==="immediate-lms")!;
 const frozen=merchantPurchase(f.input.businessId,f.input.purchaseRef,(f.input as PurchaseInputV1).lines);
 const payable=resolvePurchaseV2(frozen.input,f.terms as FrozenTerms,f.quote,CLAIM_POLICY_D1_2);
 const purchase={schema:"refref.purchase-quote/2" as const,payable,payableHash:purchasePayableHash(payable)};
 const acceptance=acceptPurchase(frozen,purchase,f.acceptance.acceptedAt);
 const qualification=consumePurchaseQualification(frozen,purchase,acceptance,{...f.payment,payableHash:purchase.payableHash} as BankFullPayment,f.qualification.purchaseQualifiedAt);
 const snapshot:SharedCheckoutSnapshot={schema:"refref.shared-checkout-snapshot/2",paymentPurpose:"Synthetic course",merchantId:payable.businessId,merchantOrderRef:payable.purchaseRef,currency:"RUB",
  referralResolutionId:payable.quote.quoteRef,termsVersionId:payable.terms.termsVersionId,lines:payable.lines.map(l=>({lineRef:l.lineRef,offerRef:l.offerRef,quantity:1 as const,merchantOfferAmountKopecks:l.merchantAmountKopecks,referralDiscountAmountKopecks:l.referralDiscountKopecks,finalAmountKopecks:l.payableAmountKopecks})),
  totalContractAmountKopecks:payable.totalKopecks,paymentObligations:[{obligationRef:"full",kind:"FULL",executionMode:"ORCHESTRATED",amountKopecks:payable.totalKopecks,
   allocations:payable.lines.map(l=>({lineRef:l.lineRef,amountKopecks:l.payableAmountKopecks})),fiscalizationMode:"PROVIDER",fiscal:{taxSystem:"USN_INCOME",items:payable.lines.map(l=>({lineRef:l.lineRef,name:"Course",quantity:1 as const,amountKopecks:l.payableAmountKopecks,vatCode:"NONE",paymentMethod:"FULL_PREPAYMENT",paymentObject:"SERVICE"}))}}],legalReleaseRef:"synthetic-legal",legalReleaseHash:"synthetic-hash"};
 const hash=checkoutSnapshotHash(snapshot),line=payable.lines[0];
 const input:PaymentCreateInput={idempotencyKey:"original-command",orderPublicId:payable.purchaseRef,amountKopecks:payable.totalKopecks,customerEmail:"synthetic@example.test",offerRef:line.offerRef,productRef:line.offerRef,lineRef:line.lineRef,
  legalReleaseRef:"synthetic-legal",legalReleaseHash:"synthetic-hash",quote:{resolutionId:payable.quote.quoteRef,termsVersionId:payable.terms.termsVersionId,baseAmountKopecks:payable.lines.reduce((n,l)=>n+l.merchantAmountKopecks,0),discountKopecks:payable.lines.reduce((n,l)=>n+l.referralDiscountKopecks,0),finalAmountKopecks:payable.totalKopecks,expiresAt:payable.quote.expiresAt,purchase},
  purchaseAcceptance:acceptance,snapshot,snapshotHash:hash,successUrl:"https://platform.test/purchases"};
 const view={schema:"refref.purchase-payment/1",businessId:payable.businessId,purchaseRef:payable.purchaseRef,payableHash:purchase.payableHash,attemptId:"11111111-1111-4111-8111-111111111111",snapshotHash:hash,state:"PENDING"};
 const client=(request:typeof fetch)=>new RefrefV9PaymentRail({apiBaseUrl:"https://api.refref.test/v1-v9",apiKey:"synthetic",businessId:payable.businessId,environment:"test",fetch:request});
 return {input,view,qualification,client,url:"https://api.refref.test/v1-v9/integrations/purchases/"+encodeURIComponent(payable.purchaseRef)+"/payment"};
}

describe("v9 explicit local transport admission",()=>{
 it.each(["production","staging"])("refuses %s before an HTTP operation",environment=>{
  const request=vi.fn<typeof fetch>();
  expect(()=>new RefrefV9PaymentRail({apiBaseUrl:"https://api.refref.test/v1-v9",apiKey:"synthetic",businessId:"business",
   environment:environment as "test",fetch:request})).toThrow("V9_LOCAL_QUALIFICATION_ONLY");
  expect(request).not.toHaveBeenCalled();
 });
 it.each(["https://api.refref.test/v1-rc","https://user:secret@api.refref.test/v1-v9","https://api.refref.test/v1-v9?mode=live"])("refuses an unqualified base %s",apiBaseUrl=>{
  expect(()=>new RefrefV9PaymentRail({apiBaseUrl,apiKey:"synthetic",businessId:"business",environment:"test"})).toThrow("V9_API_BASE_INVALID");
 });
 it("cannot silently route a v9 refund through the RC.2 rail",async()=>{
  const request=vi.fn<typeof fetch>();const rail=new RefrefV9PaymentRail({apiBaseUrl:"http://127.0.0.1:1/v1-v9",apiKey:"synthetic",businessId:"business",environment:"test",fetch:request});
  await expect(rail.readRefund("unknown")).rejects.toThrow("V9_REFUND_TRANSPORT_NOT_QUALIFIED");
  await expect(rail.readRefundExecution("unknown")).rejects.toThrow("V9_REFUND_TRANSPORT_NOT_QUALIFIED");
  await expect(rail.prepareRefund({} as PaymentRefundInput)).rejects.toThrow("V9_REFUND_TRANSPORT_NOT_QUALIFIED");
  await expect(rail.submitRefund({idempotencyKey:"unqualified",paymentId:"payment",amountKopecks:1,body:{}})).rejects.toThrow("V9_REFUND_TRANSPORT_NOT_QUALIFIED");
  expect(request).not.toHaveBeenCalled();
 });
});

describe("payment-create 4xx never masquerades as an authoritative absence receipt",()=>{
 it.each([400,409].flatMap(status=>["PENDING","PAID"].map(state=>({status,state}))))("$status recovers the original $state attempt",async({status,state})=>{
  const f=paymentFixture(),before=structuredClone(f.input);
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({error:{code:status===400?"VALIDATION_FAILED":"CONFLICT"}},{status}))
   .mockResolvedValueOnce(Response.json({...f.view,state,...(state==="PAID"?{qualification:f.qualification}:{})}));
  const result=await f.client(request).create(f.input,{mayInitiate:()=>true});
  expect(result.state).toBe(state);expect(result.attemptId).toBe(f.view.attemptId);expect(f.input).toEqual(before);
  expect(request.mock.calls.map(([url,init])=>[String(url),init?.method])).toEqual([[f.url,"POST"],[f.url,"GET"]]);
 });
 it.each([400,409].flatMap(status=>["404","401","503","network","malformed","wrong-binding"].map(readback=>({status,readback}))))("$status with $readback readback stays ambiguous",async({status,readback})=>{
  const f=paymentFixture();
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({error:{code:"INVALID_REQUEST"}},{status}));
  if(readback==="network")request.mockRejectedValueOnce(new TypeError("connection lost"));
  else if(readback==="malformed")request.mockResolvedValueOnce(Response.json({...f.view,unexpected:true}));
  else if(readback==="wrong-binding")request.mockResolvedValueOnce(Response.json({...f.view,payableHash:"refref-jcs-1:"+"0".repeat(64)}));
  else request.mockResolvedValueOnce(Response.json({error:{code:"UNAVAILABLE"}},{status:Number(readback)}));
  await expect(f.client(request).create(f.input,{mayInitiate:()=>true})).rejects.toBeInstanceOf(AmbiguousRailCreateError);
  expect(request.mock.calls.map(([url,init])=>[String(url),init?.method])).toEqual([[f.url,"POST"],[f.url,"GET"]]);
 });
 it.each([400,409,404,503])("known-attempt recovery after %s does not POST even with admission open",async status=>{
  const f=paymentFixture(),request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({error:{code:"UNKNOWN"}},{status}));
  await expect(f.client(request).recoverCreate(f.input,f.view.attemptId,{mayInitiate:()=>true})).rejects.toMatchObject({evidence:{attemptId:f.view.attemptId}});
  expect(request.mock.calls.map(([url,init])=>[String(url),init?.method])).toEqual([[f.url,"GET"]]);
 });
});
