/** Local/test opt-in v9 HTTP rail. Never silently substitutes for RC.2 or opens a sales switch. */
import {z} from "zod";
import {AmbiguousRailCreateError,PaymentInitiationStoppedError,RailRefusalError,
 type PaymentRail,type PaymentResolveInput,type PaymentCreateInput,type PaymentRecoveryOptions,type RailProjection,
 type RailResolution,type PaymentRefundInput,type RefundSubmission,type AcceptedRefund} from "./checkout";
import type {RefundEnvelope} from "./refund-envelope";
import {digest} from "./refref-contract/shared-checkout-snapshot";
import {merchantPurchase,consumePurchaseQuote,consumePurchaseQualification,consumePurchaseRefunds} from "./purchase-manifest";
import {providerPaymentIdentity} from "./refref-contract/purchase-manifest-v1";
import type {PurchaseQuoteEnvelopeV2,PurchaseQualification} from "./refref-contract/purchase-manifest-v1";
const viewSchema=z.object({
 schema:z.literal("refref.purchase-payment/1"),businessId:z.string(),purchaseRef:z.string(),payableHash:z.string(),
 attemptId:z.string().uuid(),snapshotHash:z.string(),state:z.enum(["PENDING","CUSTOMER_ACTION_REQUIRED","PAID","DECLINED","EXPIRED","REVIEW_REQUIRED"]),
 checkoutUrl:z.string().url().optional(),qualification:z.unknown().optional(),
}).strict();
class HttpError extends Error{constructor(readonly status:number){super("V9_HTTP_"+status);}}
export interface V9RailConfig {
 apiBaseUrl:string;apiKey:string;businessId:string;environment:"local"|"test";
 fetch?:typeof fetch;timeoutMs?:number;
 /** Local opt-in observation only: never creates or submits a bank refund. */
 externalRefundObservation?:boolean;
}
export class RefrefV9PaymentRail implements PaymentRail{
 readonly purchaseManifest;
 readonly checkoutSnapshotConfig;
 private readonly request:typeof fetch;
 private readonly base:string;
 constructor(private readonly config:V9RailConfig){
  if(!["local","test"].includes(config.environment))throw new Error("V9_LOCAL_QUALIFICATION_ONLY");
  const url=new URL(config.apiBaseUrl);
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash
   ||url.pathname.replace(/\/$/,"")!=="/v1-v9")throw new Error("V9_API_BASE_INVALID");
  this.base=url.href.replace(/\/$/,"");this.request=config.fetch??fetch;
  this.purchaseManifest={businessId:config.businessId,schema:"refref.purchase-payable/2" as const};
  this.checkoutSnapshotConfig={merchantId:config.businessId,fiscalizationMode:"PROVIDER" as const};
 }
 private async json(path:string,method="GET",body?:unknown):Promise<unknown>{
  const response=await this.request(this.base+path,{method,headers:{authorization:"Bearer "+this.config.apiKey,
   ...(body===undefined?{}:{"content-type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),
   signal:AbortSignal.timeout(this.config.timeoutMs??10000),cache:"no-store"});
  if(!response.ok)throw new HttpError(response.status);
  return response.json();
 }
 private path(ref:string){return "/integrations/purchases/"+encodeURIComponent(ref);}
 async resolve(input:PaymentResolveInput):Promise<RailResolution>{
  if(!input.purchase||input.purchase.input.businessId!==this.config.businessId
   ||input.purchase.input.purchaseRef!==input.request.merchantOrderRef)throw new RailRefusalError("PURCHASE_INPUT_BINDING_MISMATCH");
  const body={input:input.purchase.input,inputHash:input.purchase.inputHash,context:{
   ...(input.request.storefrontOrigin?{storefrontOrigin:input.request.storefrontOrigin}:{}),
   ...(input.request.browserContextId?{browserContextId:input.request.browserContextId}:{}),
   ...(input.request.checkoutCode?{checkoutCode:input.request.checkoutCode}:{}),deliveryDegraded:input.request.deliveryDegraded}};
  const consume=(raw:unknown):RailResolution=>{
   let q:PurchaseQuoteEnvelopeV2;
   try{q=consumePurchaseQuote(input.purchase!,raw);}catch(error){
    const message=error instanceof Error?error.message:"";
    if(/BINDING_MISMATCH|HASH_MISMATCH|UNSUPPORTED_CLAIM_POLICY/.test(message))throw new RailRefusalError(message);
    throw error;
   }
   return {state:"PRICE_REVIEW_REQUIRED",quote:{resolutionId:q.payable.quote.quoteRef,termsVersionId:q.payable.terms.termsVersionId,
    baseAmountKopecks:q.payable.lines.reduce((a,l)=>a+l.merchantAmountKopecks,0),
    discountKopecks:q.payable.lines.reduce((a,l)=>a+l.referralDiscountKopecks,0),
    finalAmountKopecks:q.payable.totalKopecks,expiresAt:q.payable.quote.expiresAt,purchase:q}};
  };
  try{return consume(await this.json("/integrations/purchases","POST",body));}
  catch(error){
   if(error instanceof RailRefusalError)throw error;
   if(error instanceof HttpError&&[400,401,403,409,422].includes(error.status))throw new RailRefusalError(error.message);
   try{return consume(await this.json(this.path(input.request.merchantOrderRef)));}
   catch(readError){if(readError instanceof RailRefusalError)throw readError;throw new AmbiguousRailCreateError();}
  }
 }
 private projection(raw:unknown,input:{orderPublicId:string;attemptId?:string;snapshotHash?:string;quote?:PurchaseQuoteEnvelopeV2}):RailProjection{
  const v=viewSchema.parse(raw);
  if(v.businessId!==this.config.businessId||v.purchaseRef!==input.orderPublicId
   ||(input.attemptId&&v.attemptId!==input.attemptId)||(input.snapshotHash&&v.snapshotHash!==input.snapshotHash)
   ||(input.quote&&v.payableHash!==input.quote.payableHash))throw new Error("PURCHASE_PAYMENT_BINDING_MISMATCH");
  let qualification:PurchaseQualification|undefined;
  if(v.qualification!==undefined){
   if(!input.quote)throw new Error("PURCHASE_QUOTE_REQUIRED");
   const p=input.quote.payable;const frozen=merchantPurchase(p.businessId,p.purchaseRef,p.lines.map(
    ({lineRef,offerRef,quantity,merchantAmountKopecks,service})=>({lineRef,offerRef,quantity,merchantAmountKopecks,service})));
   const q=v.qualification as PurchaseQualification;
   qualification=consumePurchaseQualification(frozen,input.quote,q.acceptance,q.payment,q.purchaseQualifiedAt);
   if(digest(qualification)!==digest(q))throw new Error("PURCHASE_QUALIFICATION_MISMATCH");
  }
  if(v.state==="PAID"&&!qualification)throw new Error("PURCHASE_QUALIFICATION_REQUIRED");
  if(v.state==="CUSTOMER_ACTION_REQUIRED"&&(!v.checkoutUrl||new URL(v.checkoutUrl).protocol!=="https:"))throw new Error("PAYMENT_URL_INVALID");
  return {attemptId:v.attemptId,state:v.state,...(v.state==="REVIEW_REQUIRED"?{failureCode:"PURCHASE_QUALIFICATION_UNVERIFIED"}:{}),resolutionId:input.quote?.payable.quote.quoteRef,snapshotHash:v.snapshotHash,
   ...(v.checkoutUrl?{checkoutUrl:v.checkoutUrl}:{}),...(qualification?{purchaseQualification:qualification,
    paymentAmountKopecks:qualification.payment.amountKopecks}:{} )};
 }
 private async read(input:{orderPublicId:string;attemptId?:string;snapshotHash?:string;quote?:PurchaseQuoteEnvelopeV2}):Promise<RailProjection>{
  let quote=input.quote;
  if(!quote){
   const raw=await this.json(this.path(input.orderPublicId)) as PurchaseQuoteEnvelopeV2;
   const p=raw.payable;
   if(p.businessId!==this.config.businessId||p.purchaseRef!==input.orderPublicId)throw new Error("PURCHASE_INPUT_BINDING_MISMATCH");
   quote=consumePurchaseQuote(merchantPurchase(p.businessId,p.purchaseRef,p.lines.map(
    ({lineRef,offerRef,quantity,merchantAmountKopecks,service})=>({lineRef,offerRef,quantity,merchantAmountKopecks,service}))),raw);
  }
  return this.projection(await this.json(this.path(input.orderPublicId)+"/payment"),{...input,quote});
 }
 async create(input:PaymentCreateInput,options:PaymentRecoveryOptions={mayInitiate:()=>false}):Promise<RailProjection>{
  if(!input.quote.purchase||!input.purchaseAcceptance||!input.successUrl)throw new Error("V9_PAYMENT_INPUT_REQUIRED");
  if(!options.mayInitiate())throw new PaymentInitiationStoppedError();
  const expected={orderPublicId:input.orderPublicId,snapshotHash:input.snapshotHash,quote:input.quote.purchase};
  try{
   return this.projection(await this.json(this.path(input.orderPublicId)+"/payment","POST",{
    acceptance:input.purchaseAcceptance,snapshot:input.snapshot,snapshotHash:input.snapshotHash,successUrl:input.successUrl,
    ...(input.snapshot.paymentObligations[0].fiscalizationMode==="PROVIDER"?{receiptContact:{email:input.customerEmail}}:{})}),expected);
  }catch{
   try{return await this.read(expected);}catch{throw new AmbiguousRailCreateError();}
  }
 }
 async recoverCreate(input:PaymentCreateInput,knownAttemptId?:string,options:PaymentRecoveryOptions={mayInitiate:()=>false}):Promise<RailProjection>{
  try{return await this.read({orderPublicId:input.orderPublicId,attemptId:knownAttemptId,snapshotHash:input.snapshotHash,quote:input.quote.purchase});}
  catch(error){
   // Only an authenticated no-attempt readback may repeat the SAME server-idempotent command.
   if(error instanceof HttpError&&error.status===404&&!knownAttemptId&&options.mayInitiate())return this.create(input,options);
   throw new AmbiguousRailCreateError(knownAttemptId?{attemptId:knownAttemptId}:undefined);
  }
 }
 reconcile(input:{idempotencyKey:string;orderPublicId:string;attemptId:string}):Promise<RailProjection>{
  return this.read({orderPublicId:input.orderPublicId,attemptId:input.attemptId});
 }
 async acknowledgeFulfillment(input:{idempotencyKey:string;orderPublicId:string;attemptId:string}):Promise<void>{
  const current=await this.read({orderPublicId:input.orderPublicId,attemptId:input.attemptId});
  if(!current.purchaseQualification)throw new Error("PURCHASE_QUALIFICATION_REQUIRED");
  await this.json(this.path(input.orderPublicId)+"/fulfillment","POST",{payableHash:current.purchaseQualification.payableHash});
 }
 private observationEnabled(){if(!this.config.externalRefundObservation)throw new Error("V9_REFUND_TRANSPORT_NOT_QUALIFIED");}
 async prepareRefund(input:PaymentRefundInput):Promise<RefundEnvelope>{
  this.observationEnabled();if(!input.purchase)throw new Error("PURCHASE_QUOTE_REQUIRED");
  const paid=await this.read({orderPublicId:input.orderPublicId,attemptId:input.attemptId,quote:input.purchase});
  const line=input.purchase.payable.lines.find(l=>l.lineRef===input.lineRef);
  if(!paid.purchaseQualification||!line||input.amountKopecks!==line.payableAmountKopecks)throw new Error("REFUND_FULL_ONLY");
  const refundId="v9r:"+Buffer.from(JSON.stringify({orderPublicId:input.orderPublicId,lineRef:input.lineRef})).toString("base64url");
  const payment=paid.purchaseQualification.payment.payment;
  return {idempotencyKey:input.idempotencyKey,paymentId:providerPaymentIdentity(payment),amountKopecks:input.amountKopecks,
   body:{schema:"refref.v9-refund-observation/1",refundId}};
 }
 /** PaymentRail's submission seam observes already executed external refunds.
  * It makes GETs only and grants no bank execution capability. */
 async submitRefund(envelope:RefundEnvelope):Promise<RefundSubmission>{
  this.observationEnabled();const b=z.object({schema:z.literal("refref.v9-refund-observation/1"),refundId:z.string()}).strict().parse(envelope.body);
  const refund=await this.readRefund(b.refundId);
  if(refund&&(refund.paymentId!==envelope.paymentId||refund.amountKopecks!==envelope.amountKopecks))throw new Error("REFUND_FACT_MISMATCH");
  return {status:"PROCESSING",refundExecutionId:b.refundId,...(refund?{canonicalRefundId:b.refundId}:{})};
 }
 async readRefundExecution(id:string):Promise<RefundSubmission>{
  this.observationEnabled();return {status:"PROCESSING",refundExecutionId:id,...(await this.readRefund(id)?{canonicalRefundId:id}:{})};
 }
 async readRefund(id:string):Promise<AcceptedRefund|null>{
  this.observationEnabled();if(!id.startsWith("v9r:")||id.length>1024)throw new Error("PURCHASE_REFUND_INVALID");
  const binding=z.object({orderPublicId:z.string(),lineRef:z.string()}).strict().parse(JSON.parse(Buffer.from(id.slice(4),"base64url").toString()));
  const paid=await this.read({orderPublicId:binding.orderPublicId});if(!paid.purchaseQualification)throw new Error("PURCHASE_QUALIFICATION_REQUIRED");
  const rawQuote=await this.json(this.path(binding.orderPublicId)) as PurchaseQuoteEnvelopeV2;
  const p=rawQuote.payable,quote=consumePurchaseQuote(merchantPurchase(this.config.businessId,binding.orderPublicId,p.lines.map(({lineRef,offerRef,quantity,merchantAmountKopecks,service})=>({lineRef,offerRef,quantity,merchantAmountKopecks,service}))),rawQuote);
  const refund=consumePurchaseRefunds(quote,paid.purchaseQualification,binding.lineRef,await this.json(this.path(binding.orderPublicId)+"/refunds"));
  return refund?{id,...refund}:null;
 }
}
