import { createPublicKey } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import type Database from "better-sqlite3";
import { ErasureRuntimeFence, type DrainedErasureRuntime } from "./erasure-fence";
import { applyDrainedRuntimeErasure } from "./erasure-restore";
import { CUSTODY_MAX_BYTES, confirmRemoteErasureRequest, type ErasureCustodian, type RemoteErasureAck } from "./erasure-custody";
import { ErasureLedgerError, type ErasureKeys, type VerifiedErasureLedger } from "./erasure-ledger";
import { prepareLibraryErasureRead } from "./erasure-library-read";
import { VerifiedErasureRequest } from "./erasure-request";
import { ErasureInstallationEvidence, readErasureInstallation } from "./erasure-installation";

function refuse(code: string): never {throw new ErasureLedgerError(code);}
/** Protected read authority only; never S3 privileges/private signer/recovery identity.
 * URL is a reviewed independent authority, not a restored/cached checkpoint endpoint. */
export function erasureRemoteReadAdapter(url: string, token: string, fetcher: typeof fetch = fetch) {
  let parsed:URL; try {parsed=new URL(url);} catch{return refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");}
  if(parsed.protocol!=="https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname!=="/v1/erasure/read" || token.length<32 || /[\r\n]/.test(token)) refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");
  const target=parsed.href;
  return async (nonce:string):Promise<RemoteErasureAck>=>{
    if(!/^[a-f0-9]{64}$/.test(nonce)) refuse("ERASURE_RUNTIME_AUTHORITY_UNAVAILABLE");
    try {
      const response=await fetcher(target,{method:"GET",headers:{authorization:`Bearer ${token}`,"x-erasure-nonce":nonce,
        "cache-control":"no-cache"},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10_000)});
      const length=response.headers.get("content-length");
      if(!response.ok || !response.body || (length!==null && (!/^\d+$/.test(length) || Number(length)>CUSTODY_MAX_BYTES))) {
        await response.body?.cancel(); refuse("ERASURE_RUNTIME_AUTHORITY_UNAVAILABLE");
      }
      const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let total=0;
      try {
        while(true) {const result=await reader.read(); if(result.done)break;
          total+=result.value.length; if(total>CUSTODY_MAX_BYTES) refuse("ERASURE_RUNTIME_AUTHORITY_UNAVAILABLE"); chunks.push(result.value);}
      } finally {await reader.cancel();reader.releaseLock();}
      if(!total || (length!==null && Number(length)!==total)) refuse("ERASURE_RUNTIME_AUTHORITY_UNAVAILABLE");
      return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))) as RemoteErasureAck;
    } catch {return refuse("ERASURE_RUNTIME_AUTHORITY_UNAVAILABLE");}
  };
}
const configSchema=z.object({version:z.literal(1),scope:z.enum(["canary","production"]),
  signing:z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),z.string().max(2048)),
  subject:z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),z.string().regex(/^[A-Za-z0-9+/]{43}=$/))}).strict();
export function readErasureVerificationKeys(file:string,scope:"canary"|"production"):ErasureKeys {
  try {
    const stat=lstatSync(file); if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || (stat.mode&0o777)!==0o600
      || stat.uid!==process.getuid?.() || stat.size>64*1024) refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");
    const parsed=configSchema.parse(JSON.parse(readFileSync(file,"utf8")));
    if(parsed.scope!==scope || !Object.keys(parsed.signing).length || !Object.keys(parsed.subject).length) refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");
    const signing=Object.fromEntries(Object.entries(parsed.signing).map(([id,pem])=>{
      if(!pem.startsWith("-----BEGIN PUBLIC KEY-----")) refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");
      const key=createPublicKey(pem);if(key.asymmetricKeyType!=="ed25519")refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");return[id,key];}));
    return {signing,subject:Object.fromEntries(Object.entries(parsed.subject).map(([id,key])=>[id,Buffer.from(key,"base64")]))};
  } catch {return refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");}
}

/** Separately admitted installation. Only explicit protected NEVER_INSTALLED
 * evidence permits legacy behavior; missing evidence or installed downgrade stops
 * BEFORE traffic/timers. No env switch or merchant restore establishes admission. */
export async function prepareErasureRuntime(input:{db:Database.Database; environment:Readonly<Record<string,string|undefined>>;
  forbiddenRoots:readonly string[]; libraryRead?:()=>Promise<VerifiedErasureLedger>; now?:()=>Date; installation?:ErasureInstallationEvidence}) {
  const env=input.environment;
  const installation=input.installation??readErasureInstallation(env);
  if(!ErasureInstallationEvidence.assertRuntime(installation,env))return undefined;
  if(env.ERASURE_FENCING_ENABLED!=="true" || !["canary","production"].includes(env.ERASURE_SCOPE??"")) refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");
  const scope=env.ERASURE_SCOPE as "canary"|"production";
  if(scope==="production" && env.DEPLOY_ENV!=="production" || scope==="canary" && env.DEPLOY_ENV!=="staging") refuse("ERASURE_RUNTIME_CONFIGURATION_INVALID");
  const keys=readErasureVerificationKeys(env.ERASURE_VERIFICATION_KEYS_FILE??"",scope);
  const now=input.now??(()=>new Date());
  // Trusted dependency seam for isolated composition tests only. Actual startup
  // selects a protected library configuration; no HTTPS/unfenced fallback.
  const library=input.libraryRead ? undefined : prepareLibraryErasureRead({file:env.ERASURE_LIBRARY_CONFIG_FILE??"",scope,keys,
    forbiddenRoots:input.forbiddenRoots,now});
  if(library) {try {ErasureInstallationEvidence.assertReaderBinding(installation,library.bindingSha256);}
    catch(error){library.close();throw error;}}
  const readCurrent=input.libraryRead??library!.read;
  let fence:ErasureRuntimeFence;
  try {fence=new ErasureRuntimeFence({directory:env.ERASURE_FENCE_DIRECTORY??"",forbiddenRoots:input.forbiddenRoots,scope,keys,readCurrent,now});}
  catch(error){library?.close();throw error;}
  const close=fence.close.bind(fence);fence.close=()=>{library?.close();close();};
  try {
    await fence.withDrained(input.db,async drain=>{
      const proof=await readCurrent();
      const application=applyDrainedRuntimeErasure(input.db,proof,keys,scope,drain,now(),"BOOT_RESTORE");
      await fence.reopen(drain,proof,application.application);
    });
    fence.openQualified(); return fence;
  } catch {fence.close();return refuse("ERASURE_RUNTIME_BOOT_HOLD");}
}

/** Owner-side workflow, not a public endpoint. Verify fresh session before closing;
 * drain -> remote publication -> independent ACK -> purge/revoke -> reopen.
 * Any uncertain ACK/schema/financial/audit/lease condition leaves admission CLOSED. */
export async function admitVerifiedErasure(input:{db:Database.Database; request:VerifiedErasureRequest;
  fence:ErasureRuntimeFence; custodian:ErasureCustodian; keys:ErasureKeys; now?:()=>Date;
  publishReadMirror?:(proof:VerifiedErasureLedger,drain:DrainedErasureRuntime)=>Promise<void>}) {
  const now=input.now??(()=>new Date()); VerifiedErasureRequest.assertCurrent(input.request,input.db,now());
  const result=await input.fence.withDrained(input.db,async drain=>{
    VerifiedErasureRequest.assertCurrent(input.request,input.db,now());
    await input.custodian.submit(input.db,input.request,now());
    const remote=await confirmRemoteErasureRequest(input.request,{scope:input.request.scope,keys:input.keys,now,
      read:nonce=>input.custodian.reconcile(input.request.requestId,nonce,now())});
    // Owner-only existing bundle export, AFTER durable remote confirmation and
    // BEFORE purge/reopen. Export failure retains CLOSED, never a local-only ACK.
    await input.publishReadMirror?.(remote.proof,drain);
    const applied=applyDrainedRuntimeErasure(input.db,remote.proof,input.keys,input.request.scope,drain,now());
    await input.fence.reopen(drain,remote.proof,applied.application);
    return {requestId:input.request.requestId,state:"ERASURE_APPLIED" as const,sequence:applied.sequence,
      processorDeletion:"PENDING" as const,archiveDisposition:"PENDING" as const};
  });
  input.fence.openQualified();return result;
}
