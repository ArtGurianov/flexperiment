/** Spawned only by the isolated Refref qualification runner. Never imported by the runtime. */
import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {serve} from "@hono/node-server";
import Database from "better-sqlite3";
import {createCommerceV2App} from "../../src/app";
import {migrateV2} from "../../src/db";
import {RefrefV9PaymentRail} from "../../src/refref-v9-payment-rail";
import {BrowserContexts} from "../../src/browser-context";
import {saveEditorialDraft,publishEditorialDraft} from "../../src/course-editorial";
import {merchantPurchase,acceptPurchase} from "../../src/purchase-manifest";
import {checkoutSnapshotHash,type SharedCheckoutSnapshot} from "../../src/checkout-snapshot";
import {labLegalReview} from "../../src/lab-tickets";
import {reconcilePendingCheckouts,type PaymentResolveInput} from "../../src/checkout";
import {testCheckoutConfig,qualifyTestFiscalPolicies} from "./sales";
import {stageBLegalManifestJson} from "./legal";

async function main(){
const base=process.env.V9_E2E_URL!,key=process.env.V9_E2E_KEY!,businessId=process.env.V9_E2E_BUSINESS!;
const controlUrl=process.env.V9_E2E_CONTROL!,controlKey=process.env.V9_E2E_CONTROL_KEY!;
const scenario=process.env.V9_E2E_SCENARIO!;
assert(base&&key&&businessId&&controlUrl&&controlKey&&scenario,"runner fixture configuration required");
const cfg={apiBaseUrl:base,apiKey:key,businessId,environment:"test" as const};
const rail=new RefrefV9PaymentRail(cfg);
const db=new Database(":memory:");migrateV2(db);
const origins={platform:"https://platform.test",lab:"https://lab.test",admin:"https://admin.test",api:"https://api.test"};
let clock=new Date();
const config={...testCheckoutConfig,paymentMode:"refref" as const,refref:{apiKey:key,merchantId:businessId,merchantSlug:"isolated",
 apiBaseUrl:base,handoffStateSecret:"synthetic-handoff-secret",checkoutOrigin:"https://checkout.refref.test",
 vnextApiBaseUrl:base,vnextCheckoutStorefronts:["COURSES","LAB"] as ("COURSES"|"LAB")[]}};
db.exec("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.test')");
for(const storefront of ["COURSES","LAB"])db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES (?,?,?,?,?,1)")
 .run(storefront,storefront,storefront+"-b",stageBLegalManifestJson,"2026-10-20");
db.exec("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('course','course:one','ONLINE_COURSE','PAID','one')");
db.exec("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('course','course:one','course',10000,'PUBLIC')");
saveEditorialDraft(db,{expectedRevision:0,actor:"fixture",document:{courseRef:"one",title:"Course",slug:"course-one",summary:"Summary",visibility:"LISTED",
 sections:[{sectionRef:"section",title:"Section",position:0,visibility:"LISTED"}],lessons:[{lessonRef:"lesson",sectionRef:"section",title:"Lesson",slug:"lesson",position:0,visibility:"LISTED",freePreview:false}]}},clock.toISOString());
publishEditorialDraft(db,{courseRef:"one",expectedRevision:1,expectedPublishedVersion:0,idempotencyKey:"publish",actor:"fixture"},clock.toISOString());
db.exec("INSERT INTO video_upload_sessions(id,lesson_ref,video_id,status,uploader_endpoint) VALUES ('upload','lesson','video','READY','https://example.test/upload')");
db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,duration_seconds,bound_at,updated_at) VALUES ('lesson','video',150,?,?)").run(clock.toISOString(),clock.toISOString());
db.exec("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Novosibirsk')");
db.prepare("INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address) VALUES ('lab','lab:one','city','LAB',?,?,'Asia/Novosibirsk',1,'CONFIRMED','Studio','Address')")
 .run(new Date(Math.ceil((clock.getTime()+86400000)/1000)*1000).toISOString(),new Date(Math.ceil((clock.getTime()+90000000)/1000)*1000).toISOString());
db.exec("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('lab','lab:one','LAB','PAID','lab:one')");
db.exec("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('lab','lab:one','lab',10000,'PUBLIC')");
qualifyTestFiscalPolicies(db);
const contexts=new BrowserContexts({db,origins,config:{maxAgeSeconds:{COURSES:2592000,LAB:2592000}},now:()=>clock,schedule:()=>{}});
const app=createCommerceV2App({db,config,paymentRail:rail,browserContexts:contexts,origins,serviceToken:"synthetic",
 sourceCommit:process.env.V9_E2E_FLEX_SHA!,now:()=>clock,authenticateCustomer:async h=>h.get("x-test-customer"),
 labGuestTrustedProxyIps:["127.0.0.1"],labGuestPeerAddress:()=>"127.0.0.1",sendLabTicketEmail:async()=>{}});
const server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});
await new Promise<void>(resolve=>server.once("listening",resolve));
const address=server.address();assert(address&&typeof address==="object");
const appUrl="http://127.0.0.1:"+address.port;
const count=(table:string)=>(db.prepare("SELECT count(*) n FROM "+table).get() as {n:number}).n;
type ReplyBody={state?:string;quoteId?:string;legalAcceptance?:{releaseVersion:string;manifestSha256:string;receiptEmail:string}};
type IntentRow={resolution_request_json:string;expires_at:string};
async function control(body:Record<string,unknown>){
 const r=await fetch(controlUrl,{method:"POST",headers:{authorization:"Bearer "+controlKey,"content-type":"application/json"},body:JSON.stringify(body)});
 assert.equal(r.status,200);return await r.json() as {foreignKey?:string;duplicateSubmissions:number;begunAttempts:number;commissions?:{count:number;amount:string}};
}
async function post(path:string,body:unknown,id:string,storefront:"COURSES"|"LAB"="COURSES",token?:string){
 clock=new Date(Math.max(Date.now(),clock.getTime()));
 const r=await fetch(appUrl+path,{method:"POST",headers:{"content-type":"application/json","idempotency-key":id,
  origin:storefront==="COURSES"?origins.platform:origins.lab,"x-forwarded-host":storefront==="COURSES"?"platform.test":"lab.test",
  ...(token?{authorization:"Bearer "+token,"x-real-ip":"203.0.113.1"}:{"x-test-customer":"customer"})},body:JSON.stringify(body)});
 return {status:r.status,body:await r.json() as ReplyBody};
}
async function preview(id="preview"){return post("/v1/checkout/preview",{offerRef:"course:one"},id);}
async function pay(q:ReplyBody,id="pay"){
 return post("/v1/checkout",{quoteId:q.quoteId,legalAcceptance:{...q.legalAcceptance,accepted:true}},id);
}
try{
 await control({paymentState:"PAID",bankEvidence:true,dropPaymentAckOnce:false,corruptQuotes:false,tamperPaymentHash:false,limiterFailure:false,admission:true,rewardType:"PERCENT",eligibleNone:false});
 if(scenario==="F01"){
  for(const [name,rewardType,eligibleNone,expected] of [["percent","PERCENT",false,3600],["fixed","FIXED_RUB",false,2500],["zero","FIXED_RUB",true,0]] as const){
   await control({rewardType,eligibleNone});const order=randomUUID();const proof={sourceRef:"synthetic-lms-ready",contentHash:"sha256:"+"b".repeat(64),occurredAt:new Date().toISOString()};
   const frozen=merchantPurchase(businessId,order,["A","B"].map(lineRef=>({lineRef,offerRef:"course:"+lineRef,quantity:1,merchantAmountKopecks:10000,service:{kind:"LMS",accessProfile:"IMMEDIATE",readinessEvidence:proof}})));
   const resolution=await rail.resolve({idempotencyKey:name,purchase:frozen,request:{merchantOrderRef:order,currency:"RUB",lines:[{lineRef:"A",offerRef:"course:A",quantity:1,merchantOfferAmountKopecks:10000}],deliveryDegraded:{degraded:false}}});
   assert.equal(resolution.state,"PRICE_REVIEW_REQUIRED");if(resolution.state!=="PRICE_REVIEW_REQUIRED")throw new Error("quote required");
   const q=resolution.quote.purchase!;const acceptance=acceptPurchase(frozen,q,new Date().toISOString());
   const snapshot:SharedCheckoutSnapshot={schema:"refref.shared-checkout-snapshot/2",paymentPurpose:"Synthetic purchase",merchantId:businessId,merchantOrderRef:order,currency:"RUB",
    referralResolutionId:q.payable.quote.quoteRef,termsVersionId:q.payable.terms.termsVersionId,
    lines:q.payable.lines.map(l=>({lineRef:l.lineRef,offerRef:l.offerRef,quantity:1,merchantOfferAmountKopecks:l.merchantAmountKopecks,referralDiscountAmountKopecks:l.referralDiscountKopecks,finalAmountKopecks:l.payableAmountKopecks})),
    totalContractAmountKopecks:q.payable.totalKopecks,paymentObligations:[{obligationRef:"full",kind:"FULL",executionMode:"ORCHESTRATED",amountKopecks:q.payable.totalKopecks,
     allocations:q.payable.lines.map(l=>({lineRef:l.lineRef,amountKopecks:l.payableAmountKopecks})),fiscalizationMode:"PROVIDER",fiscal:{taxSystem:"USN_INCOME",items:q.payable.lines.map(l=>({lineRef:l.lineRef,name:"Synthetic course",quantity:1,amountKopecks:l.payableAmountKopecks,vatCode:"NONE",paymentMethod:"FULL_PREPAYMENT",paymentObject:"SERVICE"}))}}],legalReleaseRef:"synthetic-legal",legalReleaseHash:"synthetic-hash"};
   const input={idempotencyKey:name,orderPublicId:order,amountKopecks:q.payable.totalKopecks,customerEmail:"synthetic@example.test",offerRef:"course:A",productRef:"course:A",lineRef:"A",legalReleaseRef:"synthetic-legal",legalReleaseHash:"synthetic-hash",quote:resolution.quote,purchaseAcceptance:acceptance,snapshot,snapshotHash:checkoutSnapshotHash(snapshot),successUrl:"https://platform.test/purchases"};
   const paid=await rail.create(input,{mayInitiate:()=>true});assert.equal(paid.state,"PAID");
   await rail.create(input,{mayInitiate:()=>true});const stats=await control({purchaseRef:order});assert.equal(stats.commissions?.count,expected?1:0);assert.equal(Number(stats.commissions?.amount),expected);assert.equal(stats.duplicateSubmissions,0);
  }
 }else if(scenario==="T04"){
  await control({corruptQuotes:true});
  const first=await preview();assert.equal(first.body.state,"RESOLUTION_PENDING",JSON.stringify(first));
  const before=db.prepare("SELECT resolution_request_json,expires_at FROM checkout_quotes").get();
  await preview();assert.deepEqual(db.prepare("SELECT resolution_request_json,expires_at FROM checkout_quotes").get(),before);
  assert.equal(count("checkout_attempts"),0);
  await control({corruptQuotes:false});
  const recovered=await preview();assert.equal(recovered.status,200,JSON.stringify(recovered));
  assert.deepEqual(db.prepare("SELECT resolution_request_json FROM checkout_quotes").get(),{resolution_request_json:(before as IntentRow).resolution_request_json});
  assert.equal(count("checkout_attempts"),0);
 }else if(scenario==="T02"){
  const token=randomBytes(32).toString("base64url");
  const started=await post("/v1/lab/guest/start",{email:"guest@example.test",accessToken:token},"start","LAB",token);assert(started.status<300,JSON.stringify(started));
  const q=await post("/v1/checkout/preview",{offerRef:"lab:one"},"lab-preview","LAB",token);assert.equal(q.status,200,JSON.stringify(q));
  const legal=labLegalReview(db);const body={quoteId:q.body.quoteId,labAcceptance:{personalDataConsent:true,termsAccepted:true,receiptContactAccepted:true,
   releaseVersion:legal.releaseVersion,manifestSha256:legal.manifestSha256}};
  const paid=await post("/v1/checkout",body,"lab-pay","LAB",token);assert.equal(paid.body.state,"PAID",JSON.stringify(paid));
  await post("/v1/checkout",body,"lab-pay-repeat","LAB",token);assert.equal(count("lab_tickets"),1);assert.equal(count("checkout_attempts"),1);
  const token2=randomBytes(32).toString("base64url");
  await post("/v1/lab/guest/start",{email:"second@example.test",accessToken:token2},"start2","LAB",token2);
  const full=await post("/v1/checkout/preview",{offerRef:"lab:one"},"full","LAB",token2);assert.equal(full.status,409,JSON.stringify(full));
 }else{
  if(scenario==="T03")await control({dropPaymentAckOnce:true});
  if(scenario.startsWith("T05"))await control({paymentState:scenario==="T05_EXPIRED"?"EXPIRED":"DECLINED"});
  if(scenario==="DELAYED")await control({bankEvidence:false});
  const q=await preview();assert.equal(q.status,200,JSON.stringify(q));assert.equal(count("checkout_attempts"),0);
  if(scenario==="T06"){
   const row=db.prepare("SELECT resolution_request_json FROM checkout_quotes").get() as IntentRow;
   const original=JSON.parse(row.resolution_request_json) as PaymentResolveInput;assert(original.purchase);const path="/integrations/purchases/"+original.purchase.input.purchaseRef;
   const other=await control({foreignKey:true});
   const foreign=await fetch(base+path,{headers:{authorization:"Bearer "+other.foreignKey}});assert.equal(foreign.status,404);
   const absent=await fetch(base+"/integrations/purchases/unknown",{headers:{authorization:"Bearer "+other.foreignKey}});assert.equal(absent.status,404);
   assert.equal((await foreign.json() as {error:{message:string}}).error.message,(await absent.json() as {error:{message:string}}).error.message);
   const noAuth=await fetch(base+path);assert.equal(noAuth.status,401);
   const input={input:original.purchase.input,inputHash:"refref-jcs-1:"+"0".repeat(64),context:{deliveryDegraded:{degraded:false}}};
   const tampered=await fetch(base+"/integrations/purchases",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify(input)});
   assert.equal(tampered.status,400);assert.equal(count("checkout_attempts"),0);
  }
  const refused=await post("/v1/checkout",{quoteId:q.body.quoteId},"no-consent");assert(refused.status>=400);assert.equal(count("checkout_attempts"),0);
  let paid;
  if(scenario==="T06"){
   const before=await control({tamperPaymentHash:true});const bad=await pay(q.body);assert.equal(bad.body.state,"CREATE_UNKNOWN");assert.equal(count("course_entitlements"),0);
   const after=await control({tamperPaymentHash:false});assert.equal(after.begunAttempts,before.begunAttempts);
   clock=new Date(Date.now()+180000);await reconcilePendingCheckouts(db,rail,clock.toISOString(),config);
   paid=await pay(q.body,"same-intent-readback");
  }else paid=await pay(q.body);
  if(scenario.startsWith("T05")){
   assert.equal(paid.body.state,scenario==="T05_EXPIRED"?"EXPIRED":"DECLINED",JSON.stringify(paid));await control({paymentState:"PAID"});
   const q2=await preview("new-preview");assert.equal(q2.status,200,JSON.stringify(q2));
   assert.notEqual(q2.body.quoteId,q.body.quoteId);
   const second=await pay(q2.body,"new-pay");assert.equal(second.body.state,"PAID",JSON.stringify(second));assert.equal(count("checkout_attempts"),2);
  }else if(scenario==="DELAYED"){
   assert.equal(paid.body.state,"REVIEW_REQUIRED",JSON.stringify(paid));assert.equal(count("course_entitlements"),0);
   await control({bankEvidence:true});clock=new Date(Date.now()+60000);
   await reconcilePendingCheckouts(db,new RefrefV9PaymentRail(cfg),clock.toISOString(),config);
   assert.equal(count("course_entitlements"),1);assert.equal(count("checkout_attempts"),1);
  }else{
   assert.equal(paid.body.state,"PAID",JSON.stringify(paid));assert.equal(count("course_entitlements"),1);
   const repeat=await pay(q.body,"pay-repeat");assert.equal(repeat.body.state,"PAID",JSON.stringify(repeat));assert.equal(count("checkout_attempts"),1);assert.equal(count("course_entitlements"),1);
   if(scenario==="T03"){
    await control({restart:true});
    const attempt=db.prepare("SELECT o.public_id order_public_id,a.refref_attempt_id FROM checkout_attempts a JOIN orders o ON o.id=a.order_id").get() as {order_public_id:string;refref_attempt_id:string};
    const read=await new RefrefV9PaymentRail(cfg).reconcile({idempotencyKey:"pay",orderPublicId:attempt.order_public_id,attemptId:attempt.refref_attempt_id});
    assert.equal(read.state,"PAID");assert.equal(count("course_entitlements"),1);
   }
  }
 }
 const stats=await control({stats:true});assert.equal(stats.duplicateSubmissions,0);
 console.log(JSON.stringify({scenario,result:"PASS",entitlements:count("course_entitlements"),tickets:count("lab_tickets"),attempts:count("checkout_attempts")}));
}finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();}


}
main().catch(error=>{console.error(error);process.exitCode=1;});
