/** Spawned only by the isolated Refref qualification runner. Never imported by the runtime. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {serve} from "@hono/node-server";
import Database from "better-sqlite3";
import {createCommerceV2App} from "../../src/app";
import {migrateV2} from "../../src/db";
import {RefrefV9PaymentRail} from "../../src/refref-v9-payment-rail";
import {BrowserContexts} from "../../src/browser-context";
import {saveEditorialDraft,publishEditorialDraft} from "../../src/course-editorial";
import {merchantPurchase,acceptPurchase} from "../../src/purchase-manifest";
import {checkoutSnapshotHash,type SharedCheckoutSnapshot} from "../../src/checkout-snapshot";
import {controlRoomSessionCookie,issueControlRoomSession} from "../../src/control-room-auth";
import {reconcilePendingRefunds} from "../../src/refunds";
import {purchaseIdentity,type PurchaseQuoteEnvelopeV2,type PurchaseQualification} from "../../src/refref-contract/purchase-manifest-v1";
import {labLegalReview,readLabTicket} from "../../src/lab-tickets";
import {reconcilePendingCheckouts,type PaymentResolveInput,type PaymentCreateInput} from "../../src/checkout";
import {testCheckoutConfig,qualifyTestFiscalPolicies} from "./sales";
import {stageBLegalManifestJson} from "./legal";

async function main(){
const base=process.env.V9_E2E_URL!,key=process.env.V9_E2E_KEY!,businessId=process.env.V9_E2E_BUSINESS!;
const controlUrl=process.env.V9_E2E_CONTROL!,controlKey=process.env.V9_E2E_CONTROL_KEY!;
const scenario=process.env.V9_E2E_SCENARIO!;
let details:Record<string,unknown>={};
assert(base&&key&&businessId&&controlUrl&&controlKey&&scenario,"runner fixture configuration required");
const cfg={apiBaseUrl:base,apiKey:key,businessId,environment:"test" as const};
let lastPayment:{url:string;body:string}|undefined;
const capture:typeof fetch=async(url,init)=>{
 if(init?.method==="POST"&&String(url).endsWith("/payment"))lastPayment={url:String(url),body:String(init.body)};
 return fetch(url,init);
};
const rail=new RefrefV9PaymentRail({...cfg,fetch:capture,externalRefundObservation:scenario.startsWith("F02_"),...(scenario==="A_TIMEOUT"?{timeoutMs:150}:{})});
const db=new Database(process.env.V9_E2E_DB_FILE??":memory:");migrateV2(db);
const origins={platform:"https://platform.test",lab:"https://lab.test",admin:"https://admin.test",api:"https://api.test"};
let clock=new Date();
const config={...testCheckoutConfig,paymentMode:"refref" as const,refref:{apiKey:key,merchantId:businessId,merchantSlug:"isolated",
 apiBaseUrl:base,handoffStateSecret:"synthetic-handoff-secret",checkoutOrigin:"https://checkout.refref.test",
 vnextApiBaseUrl:base,vnextCheckoutStorefronts:["COURSES","LAB"] as ("COURSES"|"LAB")[]}};
if(!(db.prepare("SELECT 1 FROM products LIMIT 1").get())){
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
}
const contexts=new BrowserContexts({db,origins,config:{maxAgeSeconds:{COURSES:2592000,LAB:2592000}},now:()=>clock,schedule:()=>{}});
const adminAuth={origin:origins.admin,sessionSecret:"isolated-admin-session-secret-32-chars",passwordScrypt:"unused"};
const adminSession=issueControlRoomSession(adminAuth.sessionSecret,"singleton-admin",Date.now());
db.prepare("INSERT INTO control_room_admin_sessions(id,admin_id,created_at,expires_at) VALUES (?,?,?,?)").run(adminSession.session.sid,adminSession.session.sub,clock.toISOString(),new Date(adminSession.session.exp).toISOString());
const adminCookie=controlRoomSessionCookie(adminSession.token,3600).split(";")[0];
const app=createCommerceV2App({db,config,paymentRail:rail,controlRoomAuth:adminAuth,refundEnvelopeKeys:{currentKeyId:"isolated",keys:{isolated:Buffer.alloc(32,7)}},browserContexts:contexts,origins,serviceToken:"synthetic",
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
 assert.equal(r.status,200);return await r.json() as {foreignKey?:string;duplicateSubmissions:number;begunAttempts:number;commissions?:{count:number;amount:string};hits:number;providerJournal:{kind:string;purchase_id:string;attempt_id:string}[];crashHistory:unknown[];attempt?:string;cookies:Record<string,string>;productOrigin:string;calendarVersion:string};
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
async function adminPost(path:string,body:unknown){
 clock=new Date(Math.max(Date.now(),clock.getTime()));
 const r=await fetch(appUrl+path,{method:"POST",headers:{origin:origins.admin,cookie:adminCookie,"content-type":"application/json"},body:JSON.stringify(body)});
 const data=await r.json() as {requestPublicId:string;state:string};assert(r.status<300,JSON.stringify(data));return data;
}
async function f02(){
 const info=await control({f02Config:true});
 const product=async(id:string,suffix:string,body?:unknown,actor="merchant")=>{
  const path="/cabinet/"+(actor==="moderator"?"review":"business")+"/v9/purchases/"+encodeURIComponent(id)+suffix;
  const r=await fetch(base.replace(/\/v1-v9$/,"")+path,{method:body===undefined?"GET":"POST",headers:{origin:info.productOrigin,cookie:info.cookies[actor],"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:await r.json() as Record<string,unknown>};
 };
 const isLab=scenario==="F02_LAB",token=isLab?randomBytes(32).toString("base64url"):undefined;
 if(token)await post("/v1/lab/guest/start",{email:"guest@example.test",accessToken:token},"f02-start","LAB",token);
 const prepared=isLab?await post("/v1/checkout/preview",{offerRef:"lab:one"},"f02-preview","LAB",token):await preview();assert.equal(prepared.status,200,JSON.stringify(prepared));
 const legal=labLegalReview(db),labBody={quoteId:prepared.body.quoteId,labAcceptance:{personalDataConsent:true,termsAccepted:true,receiptContactAccepted:true,releaseVersion:legal.releaseVersion,manifestSha256:legal.manifestSha256}};
 const paid=isLab?await post("/v1/checkout",labBody,"f02-pay","LAB",token):await pay(prepared.body);assert.equal(paid.body.state,"PAID",JSON.stringify(paid));
 const row=db.prepare("SELECT resolution_request_json FROM checkout_quotes WHERE id=?").get(prepared.body.quoteId) as IntentRow;
 const input=JSON.parse(row.resolution_request_json) as PaymentResolveInput;assert(input.purchase);const id=purchaseIdentity(input.purchase.input),ref=input.purchase.input.purchaseRef;
 assert.equal((await product(id,"",undefined,"foreign")).status,403);assert.equal((await product(id,"",undefined,"noMfa")).status,403);
 const state=await product(id,"");assert.equal(state.status,200,JSON.stringify(state));
 const p=state.body.payable as PurchaseQuoteEnvelopeV2["payable"],qualification=state.body.qualification as PurchaseQualification;
 const bind={businessId,purchaseRef:ref,payableHash:qualification.payableHash},line=p.lines[0],threshold=Math.min(p.rewardKopecks,p.eligibleAfterDiscountKopecks);
 const now=new Date().toISOString(),material={schema:"isolated.merchant-cancellation-material/1",purchaseId:id,lineRef:line.lineRef,at:now};
 const proof={sourceRef:"isolated-merchant-material",contentHash:"sha256:"+createHash("sha256").update(JSON.stringify(material)).digest("hex"),occurredAt:now};
 const allocation=(amount:number,name:string)=>({...bind,operation:{...qualification.payment.payment,refundRef:"external-"+name+"-"+ref},amountKopecks:amount,currency:"RUB",allocationSource:"MERCHANT_BANK_EXECUTED",allocationEvidence:proof,lineAllocations:[{lineRef:line.lineRef,amountKopecks:amount}]});
 const r1=allocation(threshold-1,"below"),r2=allocation(1,"equal"),r3=allocation(line.payableAmountKopecks-threshold,"rest");
 const bindAllocation=async(r:ReturnType<typeof allocation>)=>{const out=await product(id,"/refund-allocations",{refund:r});assert.equal(out.status,200,JSON.stringify(out));};
 const bank=async(r:ReturnType<typeof allocation>,status:string)=>control({refundEvidence:{purchaseId:id,refundRef:r.operation.refundRef,status}});
 assert.equal((await product(id,"/refund-allocations",{refund:r1,bankStatus:"SUCCEEDED"})).status,400);
 await bindAllocation(r1);await bank(r1,"PENDING");
 const coverage=[{lineRef:line.lineRef,coveredQuantity:line.quantity,segments:[{coverageRef:"all",quantity:line.quantity,evidence:[proof]}]}];
 const claim={schema:"refref.purchase-cancellation-claim/1",...bind,scope:"WHOLE_PURCHASE",idempotencyKey:"f02-claim",reason:"ALL_ELIGIBLE_SERVICES_CANCELLED",coverage,refunds:[r1]};
 assert([400,409].includes((await product(id,"/claim",{claim:{...claim,coverage:[]},calendarVersion:info.calendarVersion})).status));
 assert.equal((await product(id,"")).body.claim,null);
 const admitted=await product(id,"/claim",{claim,calendarVersion:info.calendarVersion});assert.equal(admitted.status,200,JSON.stringify(admitted));
 if(isLab){
  const originalWindow=(await product(id,"")).body.window as {hardDeadline:string};
  const end=Date.parse((line.service as {serviceEndsAt:string}).serviceEndsAt);
  for(const [key,anchorAt] of [["later",new Date(end+86400000).toISOString()],["earlier",new Date(end-1800000).toISOString()]] as const){
   const command={key:key+"-"+ref,lineRef:line.lineRef,anchorAt};
   assert.equal((await product(id,"/service-move",command,"moderator")).status,409);
   await control({scheduleEvidence:{purchaseId:id,...command}});
   const out=await product(id,"/service-move",command,"moderator");assert.equal(out.status,200,JSON.stringify(out));
   const current=await product(id,"");assert.deepEqual((current.body.claim as {receipt:unknown}).receipt,admitted.body);
   const w=current.body.window as {deadline:string;hardDeadline:string};assert.equal(w.hardDeadline,originalWindow.hardDeadline);assert(w.deadline<=w.hardDeadline);
  }
 }
 const review={outcome:"UPHELD",reason:"SYNTHETIC_CANCELLATION_CHECK",evidence:[proof],verifiedCoverage:[{lineRef:line.lineRef,coveredQuantity:line.quantity,nonOverlapping:true,rightsTerminated:true,evidence:proof}]};
 if(scenario==="F02_EXPIRED"){
  await control({historicalClaim:id});const historical=await product(id,"");
  await control({expireFixture:id});const expired=await product(id,"");
  assert.equal(((expired.body.claim as {resolution:{outcome:string}}).resolution).outcome,"EXPIRED");
  assert.deepEqual((expired.body.claim as {receipt:unknown}).receipt,(historical.body.claim as {receipt:unknown}).receipt);
  if(!isLab)assert.equal((db.prepare("SELECT count(*) n FROM course_entitlements WHERE revoked_at IS NULL").get() as {n:number}).n,1);
 await bank(r1,"SUCCEEDED");assert.equal((await product(id,"/claim/decision",{review},"moderator")).status,409);
  assert.equal(Number((expired.body.position as {PENDING:number}).PENDING),p.rewardKopecks);assert.equal(count("course_entitlements"),1);
  return;
 }
 // A merchant cannot decide, or supply its session identity in the command.
 const forged=await fetch(base.replace(/\/v1-v9$/,"")+"/cabinet/review/v9/purchases/"+encodeURIComponent(id)+"/claim/decision",{method:"POST",headers:{origin:info.productOrigin,cookie:info.cookies.merchant,"content-type":"application/json"},body:JSON.stringify({review})});assert.equal(forged.status,403);
 assert.equal((await product(id,"/claim/decision",{review},"moderator")).status,409);
 await bank(r1,"SUCCEEDED");assert.equal((await product(id,"/claim/decision",{review},"moderator")).status,409);
 for(const r of [r2,r3]){
  await bindAllocation(r);await bank(r,"SUCCEEDED");await bank(r,"SUCCEEDED");
  const supplement={schema:"refref.claim-refund-supplement/1",...bind,claimHash:admitted.body.claimHash,idempotencyKey:"supplement-"+r.operation.refundRef,refund:r,evidence:proof};
  const out=await product(id,"/claim/supplements",{supplement});assert.equal(out.status,200,JSON.stringify(out));
 }
 const refund=await adminPost("/v1/admin/v2/refunds",{orderPublicId:ref,senderEmail:isLab?"guest@example.test":"student@example.test",evidenceRef:"synthetic:received-email",receivedAt:new Date().toISOString(),idempotencyKey:"f02-refund"});
 await adminPost("/v1/admin/v2/refunds/"+refund.requestPublicId+"/decision",{outcome:"APPROVE",amountKopecks:line.payableAmountKopecks,policyBasis:"SYNTHETIC_FULL_CANCELLATION",rationale:"Synthetic customer request and independently verified refund"});
 await adminPost("/v1/admin/v2/refunds/"+refund.requestPublicId+"/execute",{});
 await reconcilePendingRefunds(db,rail,{currentKeyId:"isolated",keys:{isolated:Buffer.alloc(32,7)}},new Date().toISOString());
 if(isLab)assert.notEqual(readLabTicket(db,token!).status,"VALID");else assert.equal((db.prepare("SELECT count(*) n FROM course_entitlements WHERE revoked_at IS NULL").get() as {n:number}).n,0);
 const receipt=(await product(id,"")).body.claim as {receipt:unknown};assert.deepEqual(receipt.receipt,admitted.body);
 assert.equal((await product(id,"/claim/decision",{review:{...review,sessionId:"forged"}},"moderator")).status,400);
 const decided=await product(id,"/claim/decision",{review},"moderator");assert.equal(decided.status,200,JSON.stringify(decided));
 await control({kill:true});assert.equal((await product(id,"/claim/decision",{review},"moderator")).status,200);
 assert.deepEqual(((await product(id,"")).body.claim as {receipt:unknown}).receipt,admitted.body);
 assert.equal((db.prepare("SELECT count(*) n FROM refund_executions WHERE state='SUCCEEDED'").get() as {n:number}).n,1);
 assert.equal((await product(id,"")).body.position&&Number(((await product(id,"")).body.position as {PENDING:number}).PENDING),0);
}
try{
 await control({paymentState:"PAID",bankEvidence:true,dropPaymentAckOnce:false,corruptQuotes:false,tamperPaymentHash:false,limiterFailure:false,admission:true,rewardType:"PERCENT",eligibleNone:false});
 if(scenario.startsWith("A_ACCESS_")){
  const lab=scenario.endsWith("_LAB"),before=scenario.includes("BEFORE");
  if(process.env.V9_E2E_ACCESS_PHASE==="crash"){
   if(before){const original=rail.create.bind(rail);rail.create=async(...args)=>{const value=await original(...args);if(value.state==="PAID")process.kill(process.pid,"SIGKILL");return value;};}
   if(lab){
    const token=process.env.V9_E2E_GUEST_TOKEN!;await post("/v1/lab/guest/start",{email:"crash@example.test",accessToken:token},"access-start","LAB",token);
    const q=await post("/v1/checkout/preview",{offerRef:"lab:one"},"access-preview","LAB",token);assert.equal(q.status,200);
    const legal=labLegalReview(db);const paid=await post("/v1/checkout",{quoteId:q.body.quoteId,labAcceptance:{personalDataConsent:true,termsAccepted:true,receiptContactAccepted:true,releaseVersion:legal.releaseVersion,manifestSha256:legal.manifestSha256}},"access-pay","LAB",token);assert.equal(paid.body.state,"PAID");
   }else{const q=await preview();assert.equal((await pay(q.body)).body.state,"PAID");}
   process.kill(process.pid,"SIGKILL");
  }else{
   clock=new Date(Date.now()+180000);await reconcilePendingCheckouts(db,new RefrefV9PaymentRail(cfg),clock.toISOString(),config);
   await reconcilePendingCheckouts(db,new RefrefV9PaymentRail(cfg),clock.toISOString(),config);
   assert.equal(count("checkout_attempts"),1);
   if(lab){assert.equal(count("lab_tickets"),1);assert.equal(readLabTicket(db,process.env.V9_E2E_GUEST_TOKEN!).status,"VALID");}
   else assert.equal(count("course_entitlements"),1);
  }
 }else if(scenario.startsWith("F02_")){await f02();}
 else if(scenario.startsWith("A_")&&scenario!=="A_LAB_DEADLINE"){
  const q=await preview();assert.equal(q.status,200,JSON.stringify(q));
  const saved=db.prepare("SELECT * FROM checkout_quotes WHERE id=?").get(q.body.quoteId) as {expires_at:string;seat_hold_expires_at:string;created_at:string;resolution_request_json:string};
  const identity=JSON.parse(saved.resolution_request_json) as PaymentResolveInput;
  assert(identity.purchase);const ref=identity.purchase.input.purchaseRef;
  const frozen={expires_at:saved.expires_at,request:saved.resolution_request_json};
  const before=await control({stats:true});
  if(scenario==="A_TIMEOUT"){
   await control({arm:"AFTER_BEGIN"});const pending=pay(q.body);
   await control({waitHits:1});const result=await pending;
   assert.notEqual(result.body.state,"PAID");assert.equal(count("course_entitlements"),0);
   await control({release:true});
   await pay(q.body,"recover-timeout");
   assert.equal(count("course_entitlements"),1);
  }else if(scenario.startsWith("A_RACE")){
   await control({arm:scenario==="A_RACE_RECONCILE"?"AFTER_SUBMIT":"BEFORE_BEGIN"});
   const first=pay(q.body,"race-a");await control({waitHits:1});
   let other:Promise<unknown>;
   if(scenario==="A_RACE_CONFIRM")other=pay(q.body,"race-b");
   else if(scenario==="A_RACE_RECONCILE"){
    const saved=await control({purchaseRef:ref});assert(saved.attempt);
    other=new RefrefV9PaymentRail(cfg).reconcile({idempotencyKey:"read",orderPublicId:ref,attemptId:saved.attempt});
   }else{
    const payload=db.prepare("SELECT request_payload_json FROM checkout_attempts").get() as {request_payload_json:string};
    other=new RefrefV9PaymentRail(cfg).recoverCreate(JSON.parse(payload.request_payload_json) as PaymentCreateInput,undefined,{mayInitiate:()=>true});
   }
   assert(lastPayment);
   const duplicate=fetch(lastPayment.url,{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json","idempotency-key":"different-transport-key"},body:lastPayment.body});
   if(scenario!=="A_RACE_RECONCILE")await control({waitHits:2});else await other;
   const bad=JSON.parse(lastPayment.body) as {acceptance:{payableHash:string}};bad.acceptance.payableHash="refref-jcs-1:"+"0".repeat(64);
   const conflict=fetch(lastPayment.url,{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify(bad)});
   await control({release:true});await Promise.all([first,other]);assert.equal((await duplicate).status,200);assert.equal((await conflict).status,409);
   await pay(q.body,"race-final-read");assert.equal(count("course_entitlements"),1);
  }else{
   const name=scenario.slice(2);await control({arm:name});const pending=pay(q.body);
   await control({waitHits:1});assert.equal(count("course_entitlements"),0);
   await control({kill:true});await pending;
   const midway=await control({stats:true});
   if(name==="AFTER_BEGIN"){
    await pay(q.body,"blocked-retry");await reconcilePendingCheckouts(db,new RefrefV9PaymentRail(cfg),new Date(Date.now()+60000).toISOString(),config);
    assert.equal(count("course_entitlements"),0);
    assert.equal(midway.providerJournal.filter(e=>e.kind==="SUBMIT").length,before.providerJournal.filter(e=>e.kind==="SUBMIT").length);
   }else{
    clock=new Date(Date.now()+60000);await reconcilePendingCheckouts(db,new RefrefV9PaymentRail(cfg),clock.toISOString(),config);
    await pay(q.body,"crash-recover");assert.equal(count("course_entitlements"),1);
   }
  }
  const after=await control({stats:true});
  const delta=(kind:string)=>after.providerJournal.filter(e=>e.kind===kind).length-before.providerJournal.filter(e=>e.kind===kind).length;
  assert.equal(delta("SUBMIT"),scenario==="A_AFTER_BEGIN"?0:1);assert.equal(delta("OPERATION"),delta("SUBMIT"));assert.equal(delta("DEBIT"),delta("OPERATION"));
  const final=db.prepare("SELECT expires_at,resolution_request_json FROM checkout_quotes WHERE id=?").get(q.body.quoteId) as typeof saved;
  assert.deepEqual({expires_at:final.expires_at,request:final.resolution_request_json},frozen);
  assert.equal(count("checkout_attempts"),1);assert(ref);
  details={originalDeadline:frozen.expires_at,finalDeadline:final.expires_at,submitCalls:delta("SUBMIT"),providerOperations:delta("OPERATION"),debitEffects:delta("DEBIT"),recovery:scenario==="A_AFTER_BEGIN"?"BLOCKED_PENDING_MANUAL_REVIEW":"ORIGINAL_OPERATION"};
 }else if(scenario==="F01"){
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
 }else if(scenario==="T02"||scenario==="A_LAB_DEADLINE"){
  if(scenario==="A_LAB_DEADLINE")db.prepare("UPDATE lab_occurrences SET starts_at=?,ends_at=? WHERE id='lab'").run(new Date(Math.ceil((Date.now()+120000)/1000)*1000).toISOString(),new Date(Math.ceil((Date.now()+3600000)/1000)*1000).toISOString());
  const token=randomBytes(32).toString("base64url");
  const started=await post("/v1/lab/guest/start",{email:"guest@example.test",accessToken:token},"start","LAB",token);assert(started.status<300,JSON.stringify(started));
  const q=await post("/v1/checkout/preview",{offerRef:"lab:one"},"lab-preview","LAB",token);assert.equal(q.status,200,JSON.stringify(q));
  if(scenario==="A_LAB_DEADLINE"){
   const saved=db.prepare("SELECT * FROM checkout_quotes WHERE id=?").get(q.body.quoteId) as {expires_at:string;seat_hold_expires_at:string;created_at:string};
   const starts=(db.prepare("SELECT starts_at FROM lab_occurrences WHERE id='lab'").get() as {starts_at:string}).starts_at;
   assert.equal(saved.expires_at,[new Date(Date.parse(saved.created_at)+900000).toISOString(),saved.seat_hold_expires_at,starts].sort()[0]);
   clock=new Date(Date.parse(saved.expires_at)+1);
   const old=await control({stats:true});const late=await post("/v1/checkout",{quoteId:q.body.quoteId},"late","LAB",token);assert(late.status>=400);
   const again=await post("/v1/checkout/preview",{offerRef:"lab:one"},"expired-recovery","LAB",token);assert(again.status>=400);
   assert.equal((db.prepare("SELECT expires_at FROM checkout_quotes WHERE id=?").get(q.body.quoteId) as {expires_at:string}).expires_at,saved.expires_at);
   assert.equal((await control({stats:true})).begunAttempts,old.begunAttempts);
  }else{
  const legal=labLegalReview(db);const body={quoteId:q.body.quoteId,labAcceptance:{personalDataConsent:true,termsAccepted:true,receiptContactAccepted:true,
   releaseVersion:legal.releaseVersion,manifestSha256:legal.manifestSha256}};
  const paid=await post("/v1/checkout",body,"lab-pay","LAB",token);assert.equal(paid.body.state,"PAID",JSON.stringify(paid));
  await post("/v1/checkout",body,"lab-pay-repeat","LAB",token);assert.equal(count("lab_tickets"),1);assert.equal(count("checkout_attempts"),1);
  const token2=randomBytes(32).toString("base64url");
  await post("/v1/lab/guest/start",{email:"second@example.test",accessToken:token2},"start2","LAB",token2);
  const full=await post("/v1/checkout/preview",{offerRef:"lab:one"},"full","LAB",token2);assert.equal(full.status,409,JSON.stringify(full));
  }
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
 console.log(JSON.stringify({scenario,result:"PASS",entitlements:count("course_entitlements"),tickets:count("lab_tickets"),attempts:count("checkout_attempts"),details}));
}finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();}


}
async function accessCrash(){
 const scenario=process.env.V9_E2E_SCENARIO!,dir=mkdtempSync(join(tmpdir(),"v9-access-")),file=join(dir,"commerce.sqlite"),token=randomBytes(32).toString("base64url");
 try{
  let saved:unknown,beforeAccess=0;
  for(const phase of ["crash","resume"]){
   const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null;output:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,["--import","tsx",process.argv[1]],{env:{...process.env,V9_E2E_DB_FILE:file,V9_E2E_ACCESS_PHASE:phase,V9_E2E_GUEST_TOKEN:token},stdio:["ignore","pipe","pipe"]});
    let output="",errors="";child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>errors+=b);child.on("error",reject);child.on("exit",(code,signal)=>code&&code!==0?reject(new Error(errors)):resolve({code,signal,output}));
   });
   const db=new Database(file,{readonly:true});
   const frozen=db.prepare("SELECT expires_at,resolution_request_json,rail_quote_json FROM checkout_quotes").get();
   const access=(db.prepare("SELECT (SELECT count(*) FROM course_entitlements)+(SELECT count(*) FROM lab_tickets) n").get() as {n:number}).n;
   if(phase==="crash"){assert.equal(result.signal,"SIGKILL");saved=frozen;beforeAccess=access;assert.equal(access,scenario.includes("BEFORE")?0:1);}
   else{assert.equal(result.code,0);assert.deepEqual(frozen,saved);assert.equal(access,1);const final=JSON.parse(result.output.trim().split("\n").at(-1)!);console.log(JSON.stringify({...final,details:{consumerSignal:"SIGKILL",beforeAccess,afterAccess:access,frozenCheckoutPreserved:true}}));}
   db.close();
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
}
const run=process.env.V9_E2E_SCENARIO?.startsWith("A_ACCESS_")&&!process.env.V9_E2E_ACCESS_PHASE?accessCrash:main;
run().catch(error=>{console.error(error);process.exitCode=1;});
