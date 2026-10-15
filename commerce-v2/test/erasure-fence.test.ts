import type { ErasureDiagnostic } from "../src/erasure-diagnostics";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV2 } from "../src/db";
import { createCommerceV2App } from "../src/app";
import { createAuthRuntime } from "../src/auth";
import { bindVerifiedAuthUser } from "../src/customers";
import { ErasureLedgerStore, VerifiedErasureLedger, erasureSubject, issueErasureCheckpoint, type ErasureKeys, type ErasureSigner } from "../src/erasure-ledger";
import { ErasureCustodian, readRemoteErasureLedger, type CustodyObject } from "../src/erasure-custody";
import { ErasureRuntimeFence, DrainedErasureRuntime } from "../src/erasure-fence";
import { applyDrainedRuntimeErasure } from "../src/erasure-restore";
import { admitVerifiedErasure, erasureRemoteReadAdapter, prepareErasureRuntime } from "../src/erasure-runtime";
import { VerifiedErasureRequest } from "../src/erasure-request";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { activateLegalRelease } from "../src/legal-control";
import { stageALegalManifest } from "./fixtures/legal";
import { installationFixture } from "./fixtures/erasure-installation";

let root:string;let db:Database.Database;let ledger:ErasureLedgerStore;let keys:ErasureKeys;let signer:ErasureSigner;
let clock:Date;let gates:ErasureRuntimeFence[];let gate:ErasureRuntimeFence;let owner:ErasureCustodian;
let unavailable:boolean;let objects:Map<string,CustodyObject>;let remoteWrites:number;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
const proof=()=>readRemoteErasureLedger({scope:"canary",keys,now:()=>clock,
  read:async nonce=>{if(unavailable)throw new Error("SECRET_URL");return owner.reconcile(null,nonce,clock);}});
const gateOptions=()=>({directory:join(root,"fence"),forbiddenRoots:[join(root,"merchant"),join(root,"ledger")],scope:"canary" as const,
  keys,readCurrent:proof,now:()=>clock});
const makeGate=()=>{const value=new ErasureRuntimeFence({...gateOptions(),initialize:gates.length===0});gates.push(value);return value;};
const bootstrap=async(value=gate,mode:"LIVE_ADMISSION"|"BOOT_RESTORE"="LIVE_ADMISSION",database=db)=>{
  await value.withDrained(database,async drain=>{const current=await proof();
    const applied=applyDrainedRuntimeErasure(database,current,keys,"canary",drain,clock,mode);
    await value.reopen(drain,current,applied.application);});value.openQualified();
};
const account=(id="user",email="owner@example.test")=>{
  db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,?,?,1)').run(id,"Owner",email);
  bindVerifiedAuthUser(db,{id,email,name:"Owner"});
  db.prepare('INSERT INTO "session"(id,token,user_id,expires_at) VALUES (?,?,?,?)').run(`session-${id}`,`token-${id}`,id,"2026-10-12T12:00:00Z");
};
const request=()=>VerifiedErasureRequest.fromSession({db,scope:"canary",keys,subjectKeyId:"subject-1",body:{requestId:randomUUID()},
  headers:new Headers({origin:"https://canary-platform.flexperiment.ru"}),allowedOrigins:["https://canary-platform.flexperiment.ru"],now:()=>clock,
  getSession:async()=>({user:{id:"user",email:"owner@example.test",emailVerified:true},session:{id:"session-user",userId:"user",expiresAt:new Date("2026-10-12T12:00:00Z")}})});
const append=async(kind:"ERASURE"|"MARKETING_SUPPRESSION"="ERASURE")=>{
  const c=db.prepare("SELECT id FROM customers WHERE auth_user_id='user'").get() as {id:string};
  ledger.append({requestId:randomUUID(),kind,subject:erasureSubject(keys,"subject-1","canary",{email:"owner@example.test",customerId:c.id,userId:"user"})},clock);
  await owner.publishPending(clock);
};
const app=()=>createCommerceV2App({db,erasureFence:gate,config:loadCommerceRuntimeConfig({DEPLOY_ENV:"staging",PAYMENT_MODE:"disabled"}),
  sourceCommit:"a".repeat(40),serviceToken:"private-service-token",now:()=>clock});
beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),"flex-erasure-fence-"));gates=[];clock=new Date("2026-10-11T12:00:00Z");unavailable=false;
  for(const dir of ["merchant","ledger","fence"])mkdirSync(join(root,dir),{mode:0o700});
  db=new Database(join(root,"merchant","db.sqlite"));db.pragma("foreign_keys=ON");migrateV2(db);
  const pair=generateKeyPairSync("ed25519");signer={keyId:"signing-1",privateKey:pair.privateKey};
  keys={signing:{"signing-1":pair.publicKey},subject:{"subject-1":randomBytes(32)}};
  ledger=new ErasureLedgerStore({directory:join(root,"ledger"),forbiddenRoots:[join(root,"merchant")],scope:"canary",keys,signer});
  const recipient=spawnSync("age-keygen",[],{encoding:"utf8"}).stderr.match(/age1[0-9a-z]{58}/)![0];
  objects=new Map();remoteWrites=0;
  owner=new ErasureCustodian({store:ledger,scope:"canary",keys,signer,recipient,remote:{
    read:async key=>objects.get(key)??null,
    create:async(key,bytes)=>{if(objects.has(key))throw new Error("412");remoteWrites++;objects.set(key,{bytes,etag:randomUUID()});},
    compareExchange:async(key,bytes,etag)=>{if(objects.get(key)?.etag!==etag)throw new Error("412");remoteWrites++;objects.set(key,{bytes,etag:randomUUID()});}
  }});
  await owner.initializeEmptyCustody(clock);gate=makeGate();
});
afterEach(()=>{for(const value of gates)value.close();db.close();ledger.close();rmSync(root,{recursive:true,force:true});});

describe("durable runtime/send fencing, not operational installation",()=>{
  it("boots CLOSED, refuses a saved OPEN watermark, and requires an actual application receipt",async()=>{
    await expect(gate.run("REQUEST",async()=>undefined)).rejects.toThrow("BOOT_UNQUALIFIED");
    await gate.withDrained(db,async drain=>{
      await expect(gate.reopen(drain,await proof(),{})).rejects.toThrow("APPLICATION_UNVERIFIED");
      const forged={bundle:{version:1,scope:"canary",entries:[]},assertFresh:()=>undefined} as unknown as VerifiedErasureLedger;
      const before=db.serialize();
      expect(()=>applyDrainedRuntimeErasure(db,forged,keys,"canary",drain,clock)).toThrow("ADMISSION_INVALID");
      expect(db.serialize()).toEqual(before);
    });
    await bootstrap();expect(await gate.ready()).toBe(true);
    const other=makeGate();await expect(other.run("REQUEST",async()=>undefined)).rejects.toThrow("BOOT_UNQUALIFIED");
    expect(()=>applyDrainedRuntimeErasure(db,{} as VerifiedErasureLedger,keys,"canary",{} as DrainedErasureRuntime,clock)).toThrow("DRAIN_INVALID");
  });
  it.each(["REQUEST", "WORKER"] as const)("refuses a pending %s after concurrent readiness closes the shared fence", async kind => {
    const started = deferred(), finish = deferred(); let delay = false, fail = false;
    const readCurrent = async () => {
      if (fail) throw new Error("REFLECTED_SECRET_PROVIDER_BODY");
      if (delay) {delay = false; started.resolve(); await finish.promise;}
      return proof();
    };
    const diagnostics: ErasureDiagnostic[] = [];
    const concurrent = new ErasureRuntimeFence({...gateOptions(), readCurrent, diagnostics: e => diagnostics.push(e)}); gates.push(concurrent);
    await bootstrap(concurrent); delay = true;
    const handler = vi.fn(async () => undefined);
    const pending = concurrent.run(kind, handler); const refused = expect(pending).rejects.toThrow("AUTHORITY_UNAVAILABLE");
    await started.promise; fail = true;
    expect(await concurrent.ready()).toBe(false);
    fail = false; finish.resolve(); await refused;
    expect(handler).not.toHaveBeenCalled(); expect(concurrent.status()).toEqual({state: "CLOSED", leases: 0, unknown: 0});
    expect(await concurrent.ready()).toBe(false);
    expect(diagnostics.map(e => [e.event, e.operation])).toEqual([["ERASURE_ADMISSION_CLOSED", "READY"], ["ERASURE_ADMISSION_CLOSED", kind]]);
    expect(JSON.stringify(diagnostics)).not.toContain("REFLECTED_SECRET");
  });
  it("does not send email after an overlapping authority verification closed admission", async () => {
    const started = deferred(), finish = deferred(); let delay = false;
    const concurrent = new ErasureRuntimeFence({...gateOptions(), readCurrent: async () => {
      if (delay) {delay = false; started.resolve(); await finish.promise;}
      return proof();
    }}); gates.push(concurrent); await bootstrap(concurrent);
    const provider = vi.fn(async () => undefined);
    const pending = concurrent.run("REQUEST", async () => {delay = true; return concurrent.send("owner@example.test", provider, "AUTH_MAIL");});
    const refused = expect(pending).rejects.toThrow("AUTHORITY_UNAVAILABLE");
    await started.promise; unavailable = true; expect(await concurrent.ready()).toBe(false);
    unavailable = false; finish.resolve(); await refused;
    expect(provider).not.toHaveBeenCalled(); expect(concurrent.status()).toEqual({state: "CLOSED", leases: 0, unknown: 0});
  });
  it.each(["REQUEST", "WORKER", "SEND"] as const)("refuses %s when CLOSED is queued after acquire completes but before operation entry", async kind => {
    const current = await proof(); let armed = false; let closedWithActiveLease = false;
    const concurrent = new ErasureRuntimeFence({...gateOptions(), readCurrent: () => {
      const result = Promise.resolve(current);
      if (armed) {
        armed = false;
        // This .then runs before acquire's await continuation. Its nested
        // microtask runs AFTER acquire's final OPEN check / fulfilled return,
        // but BEFORE run/send resumes its await and calls the operation.
        void result.then(() => queueMicrotask(() => {
          closedWithActiveLease = concurrent.status().leases > 0;
          concurrent.closeAdmission();
        }));
      }
      return result;
    }}); gates.push(concurrent); await bootstrap(concurrent);
    const operation = vi.fn(async () => undefined);
    const pending = kind === "SEND" ? concurrent.run("REQUEST", async () => {
      armed = true; return concurrent.send("owner@example.test", operation, "AUTH_MAIL");
    }) : (armed = true, concurrent.run(kind, operation));
    await expect(pending).rejects.toThrow("ERASURE_RUNTIME_CLOSED");
    expect(closedWithActiveLease).toBe(true); expect(operation).not.toHaveBeenCalled();
    expect(concurrent.status()).toEqual({state: "CLOSED", leases: 0, unknown: 0});
  });
  it.each(["REQUEST", "SEND"] as const)("validates the %s lease immediately before entry and preserves UNKNOWN evidence", async kind => {
    const current = await proof(); let armed = false;
    const control = new Database(join(root, "fence", "erasure-fence.sqlite"));
    const concurrent = new ErasureRuntimeFence({...gateOptions(), readCurrent: () => {
      const result = Promise.resolve(current);
      if (armed) {armed = false; void result.then(() => queueMicrotask(() => {
        control.prepare("UPDATE fence_leases SET outcome='UNKNOWN' WHERE kind=?").run(kind);
      }));}
      return result;
    }}); gates.push(concurrent);
    try {
      await bootstrap(concurrent); const operation = vi.fn(async () => undefined);
      const pending = kind === "SEND" ? concurrent.run("REQUEST", async () => {
        armed = true; return concurrent.send("owner@example.test", operation, "AUTH_MAIL");
      }) : (armed = true, concurrent.run(kind, operation));
      await expect(pending).rejects.toThrow("ERASURE_RUNTIME_CLOSED");
      expect(operation).not.toHaveBeenCalled(); expect(concurrent.status()).toEqual({state: "CLOSED", leases: 1, unknown: 1});
      await expect(concurrent.withDrained(db, async () => undefined)).rejects.toThrow("DRAIN_PENDING");
    } finally {control.close();}
  });
  it("blocks erasure before ledger publication while an async request still owns a lease",async()=>{
    await bootstrap();account();const verified=await request();const started=deferred(),finish=deferred();
    const active=gate.run("REQUEST",async()=>{started.resolve();await finish.promise;db.exec(`UPDATE "user" SET name='late-name' WHERE id='user'`);});
    await started.promise;const writes=remoteWrites;
    await expect(admitVerifiedErasure({db,request:verified,fence:gate,custodian:owner,keys,now:()=>clock})).rejects.toThrow("DRAIN_PENDING");
    expect(ledger.export().entries).toHaveLength(0);expect(remoteWrites).toBe(writes);
    finish.resolve();await active;
    const result=await admitVerifiedErasure({db,request:verified,fence:gate,custodian:owner,keys,now:()=>clock});
    expect(result.state).toBe("ERASURE_APPLIED");expect(db.prepare('SELECT id FROM "user"').all()).toEqual([]);
    expect(gate.status()).toEqual({state:"OPEN",leases:0,unknown:0});
  });
  it("holds a network send through its final completion, independent of campaign lease expiry",async()=>{
    await bootstrap();account();const verified=await request();const started=deferred(),finish=deferred();
    const sending=gate.run("WORKER",()=>gate.send("owner@example.test",async()=>{started.resolve();await finish.promise;}));
    await started.promise;expect(gate.status().leases).toBe(2);
    clock=new Date(clock.getTime()+61_000);
    await expect(gate.withDrained(db,async()=>undefined)).rejects.toThrow("DRAIN_PENDING");
    finish.resolve();await sending;
    clock=new Date(clock.getTime()-61_000);
    await admitVerifiedErasure({db,request:verified,fence:gate,custodian:owner,keys,now:()=>clock});
    const send=vi.fn(async()=>undefined);
    await expect(gate.run("WORKER",()=>gate.send("owner@example.test",send))).rejects.toThrow("SUBJECT_SUPPRESSED");
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps UNKNOWN send evidence even when a caller swallows the error; no TTL or restart unlock",async()=>{
    await bootstrap();await gate.run("WORKER",async()=>{try{await gate.send("owner@example.test",async()=>{throw new Error("SECRET transport timeout");});}catch{ /* worker swallows */ }});
    expect(gate.status()).toEqual({state:"CLOSED",leases:1,unknown:1});
    clock=new Date(clock.getTime()+24*3600_000);
    await expect(makeGate().withDrained(db,async()=>undefined)).rejects.toThrow("DRAIN_PENDING");
    expect(gate.status().leases).toBe(1);
  });
  it("does not invent UNKNOWN delivery when a definite pre-send check rejects before transport",async()=>{
    await bootstrap();const send=vi.fn(async()=>undefined);
    await gate.run("WORKER",async()=>{
      const original=owner.reconcile.bind(owner);const spy=vi.spyOn(owner,"reconcile").mockImplementation(async(...args)=>{
        clock=new Date(clock.getTime()+61_000);return original(args[0],args[1],clock);
      });
      try {await expect(gate.send("owner@example.test",send)).rejects.toThrow("ADMISSION_EXPIRED");}finally{spy.mockRestore();}
    });
    expect(send).not.toHaveBeenCalled();expect(gate.status()).toEqual({state:"OPEN",leases:0,unknown:0});
  });
  it("retains a truly crashed child-process SEND lease and refuses replay/automatic expiry",async()=>{
    await bootstrap();
    const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",
      `import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.pragma('synchronous=EXTRA');db.prepare("INSERT INTO fence_leases VALUES ('crashed','SEND','ACTIVE')").run();process.kill(process.pid,'SIGKILL');`,join(root,"fence","erasure-fence.sqlite")]);
    expect(child.signal).toBe("SIGKILL");expect(gate.status().leases).toBe(1);
    await expect(makeGate().withDrained(db,async()=>undefined)).rejects.toThrow("DRAIN_PENDING");
  });
  it("excludes another owner and invalidates a returned drain capability",async()=>{
    const started=deferred(),finish=deferred();let old:DrainedErasureRuntime|undefined;
    const first=gate.withDrained(db,async drain=>{old=drain;started.resolve();await finish.promise;});
    await started.promise;
    await expect(makeGate().withDrained(db,async()=>undefined)).rejects.toThrow("OWNER_RECONCILIATION_REQUIRED");
    finish.resolve();await first;expect(()=>DrainedErasureRuntime.assert(old!,db,"canary")).toThrow("DRAIN_INVALID");
  });
  it("fences actual HTTP before handlers and reports CLOSED readiness without losing identity",async()=>{
    expect((await app().request("/v1/internal/catalog-summary",{headers:{authorization:"Bearer private-service-token"}})).status).toBe(503);
    expect((await app().request("/readyz")).status).toBe(503);expect((await app().request("/identity")).status).toBe(200);
    await bootstrap();expect((await app().request("/v1/internal/catalog-summary",{headers:{authorization:"Bearer private-service-token"}})).status).toBe(200);
    unavailable=true;expect((await app().request("/readyz")).status).toBe(503);
    expect((await app().request("/v1/internal/catalog-summary",{headers:{authorization:"Bearer private-service-token"}})).status).toBe(503);
  });
  it("stops before processing when current ledger advanced outside the applied watermark",async()=>{
    await bootstrap();account();await append();const action=vi.fn(async()=>undefined);
    await expect(gate.run("REQUEST",action)).rejects.toThrow("AUTHORITY_UNAVAILABLE");expect(action).not.toHaveBeenCalled();expect(gate.status().state).toBe("CLOSED");
  });
  it("never lowers a persisted applied prefix on reboot even with a freshly signed stale authority response",async()=>{
    await bootstrap();account();
    const older=await owner.reconcile(null,"a".repeat(64),clock);
    await append("MARKETING_SUPPRESSION");await bootstrap();
    const stale=()=>readRemoteErasureLedger({scope:"canary",keys,now:()=>clock,
      read:async nonce=>({...older,checkpoint:issueErasureCheckpoint(older.bundle,nonce,signer,keys,clock)})});
    const restarted=new ErasureRuntimeFence({...gateOptions(),readCurrent:stale});gates.push(restarted);
    await expect(restarted.withDrained(db,async drain=>{
      const current=await stale();
      const applied=applyDrainedRuntimeErasure(db,current,keys,"canary",drain,clock,"BOOT_RESTORE");
      await restarted.reopen(drain,current,applied.application);
    })).rejects.toThrow("LEDGER_ROLLBACK_OR_FORK");
    expect(restarted.status().state).toBe("CLOSED");
    const control=new Database(join(root,"fence","erasure-fence.sqlite"),{readonly:true});
    try {expect(control.prepare("SELECT sequence,head_hash FROM fence_state").get()).toEqual({sequence:1,head_hash:ledger.export().entries[0].hash});}
    finally {control.close();}
    await expect(bootstrap(restarted)).rejects.toThrow("LEDGER_ROLLBACK_OR_FORK");
    expect(await restarted.ready()).toBe(false);
  });
  it("denies delayed async children after the request lease completed",async()=>{
    await bootstrap();const finish=deferred();let later:Promise<unknown>|undefined;
    await gate.run("REQUEST",async()=>{later=finish.promise.then(()=>gate.send("owner@example.test",async()=>undefined));});
    finish.resolve();await expect(later).rejects.toThrow("OPERATION_UNFENCED");
  });
  it("preserves unrelated live sessions, invalidates target links and excludes all restored sessions at boot",async()=>{
    await bootstrap();account();account("other","other@example.test");
    db.prepare("INSERT INTO verification(id,identifier,value,expires_at) VALUES (?,?,?,?)").run("target-link","hashed-target",JSON.stringify({email:"owner@example.test"}),"2026-10-12T12:00:00Z");
    db.prepare("INSERT INTO verification(id,identifier,value,expires_at) VALUES (?,?,?,?)").run("other-link","hashed-other",JSON.stringify({email:"other@example.test"}),"2026-10-12T12:00:00Z");
    const archive=join(root,"older.sqlite");await db.backup(archive);
    await admitVerifiedErasure({db,request:await request(),fence:gate,custodian:owner,keys,now:()=>clock});
    expect(db.prepare('SELECT user_id FROM "session"').all()).toEqual([{user_id:"other"}]);
    expect(db.prepare("SELECT id FROM verification").all()).toEqual([{id:"other-link"}]);
    const restored=new Database(archive);restored.pragma("foreign_keys=ON");
    try {await bootstrap(makeGate(),"BOOT_RESTORE",restored);
      expect(restored.prepare('SELECT id FROM "user"').all()).toEqual([{id:"other"}]);
      expect(restored.prepare('SELECT id FROM "session"').all()).toEqual([]);expect(restored.prepare("SELECT id FROM verification").all()).toEqual([]);
      expect(restored.prepare("SELECT reason FROM email_suppressions").get()).toEqual({reason:"INDEPENDENT_ERASURE_LEDGER"});
    }finally{restored.close();}
  });
  it("keeps marketing-only suppression separate from account access",async()=>{
    await bootstrap();account();await append("MARKETING_SUPPRESSION");await bootstrap();
    await gate.run("REQUEST",async()=>gate.assertIdentity({email:"owner@example.test",userId:"user"},"ACCOUNT"));
    await expect(gate.run("WORKER",()=>gate.send("owner@example.test",async()=>undefined))).rejects.toThrow("SUBJECT_SUPPRESSED");
    expect(db.prepare('SELECT id FROM "user"').all()).toEqual([{id:"user"}]);
    const transactional=vi.fn(async()=>undefined);
    await gate.run("REQUEST",()=>gate.send("owner@example.test",transactional,"AUTH_MAIL"));
    expect(transactional).toHaveBeenCalledOnce();
    let link="";
    const auth=createAuthRuntime({db,erasureFence:gate,sendMagicLinkEmail:async message=>{link=message.url;},environment:{NODE_ENV:"test",BETTER_AUTH_SECRET:"a-test-secret-that-is-long-enough-for-auth"}});
    const initiation=await gate.run("REQUEST",()=>auth.auth.handler(new Request("http://localhost:3002/v1/auth/sign-in/magic-link",{method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3002"},body:JSON.stringify({email:"owner@example.test",metadata:{storefront:"COURSES"}})})));
    expect(initiation.status).toBe(200);expect(link).toContain("magic-link");
  });
  it.each(["schema","financial","audit","verification"])("retains CLOSED on %s uncertainty after durable remote ACK",async reason=>{
    await bootstrap();account();const verified=await request();
    if(reason==="schema")db.exec("CREATE TABLE unclassified(email TEXT)");
    if(reason==="financial") {db.exec(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('legal','COURSES','v1','{}','now',1)`);
      db.prepare("INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id) SELECT 'o','FX-O',id,'FULFILLED',100,'{}',?,'legal' FROM customers WHERE auth_user_id='user'").run("a".repeat(64));}
    if(reason==="audit")db.exec(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json) VALUES ('a','user','TEST','USER','user','{}')`);
    if(reason==="verification")db.exec(`INSERT INTO verification(id,identifier,value,expires_at) VALUES ('unknown','hashed','not-json','2026-10-12T12:00:00Z')`);
    await expect(admitVerifiedErasure({db,request:verified,fence:gate,custodian:owner,keys,now:()=>clock})).rejects.toThrow(/ERASURE_/);
    expect(ledger.export().entries).toHaveLength(1);expect(gate.status().state).toBe("CLOSED");
    expect(db.prepare('SELECT id FROM "user" WHERE id=\'user\'').get()).toEqual({id:"user"});
  });
  it("does not reopen on newest-ledger change during application/read-back",async()=>{
    account();await gate.withDrained(db,async drain=>{const current=await proof();const applied=applyDrainedRuntimeErasure(db,current,keys,"canary",drain,clock);
      await append("MARKETING_SUPPRESSION");await expect(gate.reopen(drain,current,applied.application)).rejects.toThrow("LEDGER_CHANGED_DURING_ADMISSION");});
    expect(()=>gate.openQualified()).toThrow("BOOT_UNQUALIFIED");
  });
  it("fails closed for missing enabled custody/config and never installs private signer/S3 credentials",async()=>{
    const installation=installationFixture("REQUIRED",join(root,"fence")).read();
    const environment={ERASURE_FENCING_ENABLED:"true",ERASURE_SCOPE:"canary",DEPLOY_ENV:"staging",ERASURE_FENCE_DIRECTORY:join(root,"fence")};
    expect(await prepareErasureRuntime({db,environment:{ERASURE_FENCING_ENABLED:"false",DEPLOY_ENV:"staging"},installation:installationFixture("NEVER_INSTALLED").read(),forbiddenRoots:[join(root,"merchant")]})).toBeUndefined();
    await expect(prepareErasureRuntime({db,environment,installation,forbiddenRoots:[join(root,"merchant")]})).rejects.toThrow("CONFIGURATION_INVALID");
    const file=join(root,"keys.json");writeFileSync(file,JSON.stringify({version:1,scope:"canary",signing:{"signing-1":signer.privateKey.export({type:"pkcs8",format:"pem"})},subject:{"subject-1":keys.subject["subject-1"].toString("base64")}}),{mode:0o600});
    await expect(prepareErasureRuntime({db,environment:{...environment,ERASURE_VERIFICATION_KEYS_FILE:file},installation,forbiddenRoots:[join(root,"merchant")]})).rejects.toThrow("CONFIGURATION_INVALID");
    chmodSync(file,0o644);await expect(prepareErasureRuntime({db,environment:{...environment,ERASURE_VERIFICATION_KEYS_FILE:file},installation,forbiddenRoots:[join(root,"merchant")]})).rejects.toThrow("CONFIGURATION_INVALID");
  });
  it("uses uncached nonce-authenticated GET only and refuses redirect/body/status failures without secrets",async()=>{
    const fetcher=vi.fn(async()=>new Response("{}"));const read=erasureRemoteReadAdapter("https://authority.example.test/v1/erasure/read","t".repeat(32),fetcher);
    await read("a".repeat(64));expect(fetcher).toHaveBeenCalledWith("https://authority.example.test/v1/erasure/read",expect.objectContaining({method:"GET",redirect:"error",cache:"no-store",headers:expect.objectContaining({"x-erasure-nonce":"a".repeat(64)})}));
    for(const response of [new Response("SECRET",{status:403}),new Response("SECRET",{headers:{"content-length":"999999999"}}),new Response("SECRET")]) {
      const bad=erasureRemoteReadAdapter("https://authority.example.test/v1/erasure/read","t".repeat(32),async()=>response);
      await expect(bad("a".repeat(64))).rejects.toThrow("AUTHORITY_UNAVAILABLE");
    }
    expect(()=>erasureRemoteReadAdapter("http://authority.example.test/v1/erasure/read","t".repeat(32))).toThrow("CONFIGURATION_INVALID");
  });
  it("closes failed publication without purging; reconciles a committed remote head GET-only",async()=>{
    await bootstrap();account();const verified=await request();
    let failHead=true;
    // Loss of the owner's reply after genuine remote publication/read-back,
    // before applying any merchant change. Network-boundary cases are in #204.
    const original=owner;
    const submit=vi.spyOn(original,"submit").mockImplementation(async(db,request,time)=>{
      const result=await ErasureCustodian.prototype.submit.call(original,db,request,time);
      if(failHead)throw new Error("ERASURE_REMOTE_OPERATION_UNCONFIRMED");return result;
    });
    await expect(admitVerifiedErasure({db,request:verified,fence:gate,custodian:original,keys,now:()=>clock})).rejects.toThrow("UNCONFIRMED");
    expect(gate.status().state).toBe("CLOSED");expect(db.prepare('SELECT id FROM "user" WHERE id=\'user\'').get()).toEqual({id:"user"});
    const writes=remoteWrites;failHead=false;submit.mockRestore();
    await admitVerifiedErasure({db,request:verified,fence:gate,custodian:original,keys,now:()=>clock});
    expect(remoteWrites).toBe(writes);expect(db.prepare('SELECT id FROM "user"').all()).toEqual([]);
  });
  it("qualifies enabled boot using actual signed remote read-back and refuses missing/stale authority",async()=>{
    account();const file=join(root,"verification-keys.json");
    writeFileSync(file,JSON.stringify({version:1,scope:"canary",signing:{"signing-1":keys.signing["signing-1"].export({type:"spki",format:"pem"})},
      subject:{"subject-1":keys.subject["subject-1"].toString("base64")}}),{mode:0o600});
    const env={ERASURE_FENCING_ENABLED:"true",ERASURE_SCOPE:"canary",DEPLOY_ENV:"staging",ERASURE_VERIFICATION_KEYS_FILE:file,
      ERASURE_FENCE_DIRECTORY:join(root,"fence")};
    const installation=installationFixture("REQUIRED",join(root,"fence")).read();
    const ready=await prepareErasureRuntime({db,environment:env,installation,forbiddenRoots:[join(root,"merchant"),join(root,"ledger")],libraryRead:proof,now:()=>clock});
    gates.push(ready!);expect(await ready!.ready()).toBe(true);expect(db.prepare('SELECT id FROM "session"').all()).toEqual([]);
    for(const enabled of [undefined,"false"]) {
      await expect(prepareErasureRuntime({db,environment:{...env,ERASURE_FENCING_ENABLED:enabled},installation,forbiddenRoots:[join(root,"merchant")],now:()=>clock})).rejects.toThrow("DOWNGRADE_REFUSED");
    }
    await expect(prepareErasureRuntime({db,environment:env,installation,forbiddenRoots:[join(root,"merchant"),join(root,"ledger")],libraryRead:async()=>{throw new Error("SECRET_AUTH_URL");},now:()=>clock})).rejects.toThrow("BOOT_HOLD");
    expect(ready!.status().state).toBe("CLOSED");
  });
  it("guards real Better Auth callbacks, mail transport, sign-in, sessions and logout within the HTTP lease",async()=>{
    await bootstrap();account();let link="";let sent=0;
    activateLegalRelease(db,{storefront:"COURSES",version:"synthetic-stage-a",manifest:stageALegalManifest,actor:"isolated-test"});
    const auth=createAuthRuntime({db,erasureFence:gate,sendMagicLinkEmail:async message=>{link=message.url;sent++;},
      environment:{NODE_ENV:"test",BETTER_AUTH_SECRET:"a-test-secret-that-is-long-enough-for-auth"}});
    const application=createCommerceV2App({db,erasureFence:gate,config:loadCommerceRuntimeConfig({DEPLOY_ENV:"staging",PAYMENT_MODE:"disabled"}),sourceCommit:"a".repeat(40),serviceToken:"service",
      authHandler:auth.auth.handler,prepareMagicLinkInitiation:auth.prepareMagicLinkInitiation,authenticateCustomer:auth.authenticateCustomer,now:()=>clock});
    const choices={storefront:"COURSES",personalDataConsent:true,accountTermsAccepted:true,marketingConsent:false,
      personalDataVersion:"personal_data-v1",personalDataSha256:"a".repeat(64),accountTermsVersion:"account_terms-v1",accountTermsSha256:"a".repeat(64),
      marketingDocumentVersion:"marketing_consent-v1",marketingDocumentSha256:"a".repeat(64)};
    const response=await application.request("http://localhost:3002/v1/auth/sign-in/magic-link",{method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3002"},
      body:JSON.stringify({email:"owner@example.test",callbackURL:"http://localhost:3001/account",metadata:{storefront:"COURSES"},...choices})});
    expect(response.status).toBe(200);expect(sent).toBe(1);
    const verified=await application.request(link,{headers:{origin:"http://localhost:3002"}});expect([200,302]).toContain(verified.status);
    const cookies=verified.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    expect((await application.request("http://localhost:3002/v1/auth/get-session",{headers:{cookie:cookies,origin:"http://localhost:3002"}})).status).toBe(200);
    // No content-consent grant was needed to sign out; marketing remains off.
    expect((await application.request("http://localhost:3002/v1/auth/sign-out",{method:"POST",headers:{cookie:cookies,origin:"http://localhost:3002"}})).status).toBe(200);
    await admitVerifiedErasure({db,request:await request(),fence:gate,custodian:owner,keys,now:()=>clock});
    const after=await application.request(link,{headers:{origin:"http://localhost:3002"}});expect(after.status).not.toBe(200);
    const denied=await application.request("http://localhost:3002/v1/auth/sign-in/magic-link",{method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3002"},body:JSON.stringify({email:"owner@example.test",metadata:{storefront:"COURSES"},...choices})});
    expect(denied.status).not.toBe(200);expect(sent).toBe(1);expect(db.prepare('SELECT id FROM "user"').all()).toEqual([]);
    expect(gate.status().leases).toBe(0);
  });
  it("does not admit erasure while a real auth callback is waiting before DB/session writes",async()=>{
    await bootstrap();account();let link="";
    const auth=createAuthRuntime({db,erasureFence:gate,sendMagicLinkEmail:async message=>{link=message.url;},environment:{NODE_ENV:"test",BETTER_AUTH_SECRET:"a-test-secret-that-is-long-enough-for-auth"}});
    await gate.run("REQUEST",()=>auth.auth.handler(new Request("http://localhost:3002/v1/auth/sign-in/magic-link",{method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3002"},body:JSON.stringify({email:"owner@example.test",metadata:{storefront:"COURSES"}})})));
    const started=deferred(),finish=deferred();
    const application=createCommerceV2App({db,erasureFence:gate,config:loadCommerceRuntimeConfig({DEPLOY_ENV:"staging",PAYMENT_MODE:"disabled"}),sourceCommit:"a".repeat(40),serviceToken:"service",
      authHandler:async request=>{started.resolve();await finish.promise;return auth.auth.handler(request);},now:()=>clock});
    const verified=await request();const callback=application.request(link,{headers:{origin:"http://localhost:3002"}});
    await started.promise;await expect(admitVerifiedErasure({db,request:verified,fence:gate,custodian:owner,keys,now:()=>clock})).rejects.toThrow("DRAIN_PENDING");
    expect(ledger.export().entries).toHaveLength(0);
    finish.resolve();expect([200,302]).toContain((await callback).status);
    await admitVerifiedErasure({db,request:verified,fence:gate,custodian:owner,keys,now:()=>clock});
    expect(db.prepare('SELECT id FROM "session"').all()).toEqual([]);expect(db.prepare('SELECT id FROM "user"').all()).toEqual([]);
  });
});
