import Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ErasureLedgerError, VerifiedErasureLedger, assertErasureSubjectKey, erasurePseudonym, type ErasureKeys } from "./erasure-ledger";
import { assertErasureApplication } from "./erasure-restore";

function refuse(code: string): never { throw new ErasureLedgerError(code); }
const drainAuthority = Object.freeze({});
const drains = new WeakSet<DrainedErasureRuntime>();
let issueDrain: (scope: "canary" | "production", db: Database.Database, assertOwner: () => void) => DrainedErasureRuntime;
/** Valid only while its owning SQLite fence is CLOSED/drained and exclusive owner claim
 * remains present. Not a watermark carried by a restored merchant database. */
export class DrainedErasureRuntime {
  private constructor(readonly scope: "canary" | "production", readonly merchant: Database.Database,
    readonly assertOwner: () => void, token: object) {
    if (token !== drainAuthority) refuse("ERASURE_DRAIN_INVALID");
    drains.add(this); Object.freeze(this);
  }
  static assert(proof: DrainedErasureRuntime, db: Database.Database, scope: "canary" | "production") {
    if (!drains.has(proof) || proof.merchant !== db || proof.scope !== scope) refuse("ERASURE_DRAIN_INVALID");
    proof.assertOwner();
  }
  // Constructor authority is inaccessible; the sole issuing closure is initialized here.
  static { issueDrain = (scope, db, assertOwner) => new DrainedErasureRuntime(scope, db, assertOwner, drainAuthority); }
}

const schema = `CREATE TABLE fence_state(id INTEGER PRIMARY KEY CHECK(id=1),scope TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('CLOSED','OPEN')),sequence INTEGER NOT NULL,head_hash TEXT NOT NULL,owner TEXT);
CREATE TABLE fence_leases(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('REQUEST','WORKER','SEND')),
  outcome TEXT NOT NULL CHECK(outcome IN ('ACTIVE','UNKNOWN')));`;
type State = {scope: string; state: "OPEN" | "CLOSED"; sequence: number; head_hash: string; owner: string | null};
type Context = {id: string; proof: VerifiedErasureLedger; active: boolean};

/** Shared independent control DB, mounted by every participating writer. No expiry-based
 * lease deletion: a crashed/ambiguous send remains UNKNOWN/ACTIVE and blocks erasure.
 * Construction alone cannot reopen it; boot always requires owner recovery admission. */
export class ErasureRuntimeFence {
  readonly #db!: Database.Database;
  readonly #scope: "canary" | "production";
  readonly #keys: ErasureKeys;
  readonly #read: () => Promise<VerifiedErasureLedger>;
  readonly #now: () => Date;
  readonly #context = new AsyncLocalStorage<Context>();
  #bootQualified = false;
  constructor(input: {directory: string; forbiddenRoots: readonly string[]; scope: "canary" | "production";
    keys: ErasureKeys; readCurrent: () => Promise<VerifiedErasureLedger>; now?: () => Date; initialize?:boolean}) {
    let connection: Database.Database | undefined;
    try {
    if (!["canary","production"].includes(input.scope) || !input.forbiddenRoots.length || !isAbsolute(input.directory)) refuse("ERASURE_FENCE_STORAGE_INVALID");
    const dir = lstatSync(input.directory); const resolved = realpathSync(input.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 || dir.uid !== process.getuid?.()) refuse("ERASURE_FENCE_STORAGE_INVALID");
    for (const root of input.forbiddenRoots) {
      if (!isAbsolute(root)) refuse("ERASURE_FENCE_STORAGE_INVALID");
      const rel = relative(realpathSync(root),resolved);
      if (!rel || (rel!==".." && !rel.startsWith("../") && !isAbsolute(rel))) refuse("ERASURE_FENCE_NOT_INDEPENDENT");
    }
    const file = join(resolved,"erasure-fence.sqlite");
    if (existsSync(file)) {
      const stat=lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777)!==0o600 || stat.uid!==dir.uid) refuse("ERASURE_FENCE_STORAGE_INVALID");
    } else {
      if(input.initialize!==true)refuse("ERASURE_FENCE_NOT_INITIALIZED");
      const fd=openSync(file,"wx",0o600); try {fsyncSync(fd);} finally {closeSync(fd);}
      const directoryFd=openSync(resolved,"r"); try {fsyncSync(directoryFd);} finally {closeSync(directoryFd);}
    }
    this.#db = connection = new Database(file, {timeout:5_000});
    try {
      this.#db.pragma("journal_mode=DELETE"); this.#db.pragma("synchronous=EXTRA");
      if (this.#db.pragma("journal_mode",{simple:true})!=="delete" || this.#db.pragma("synchronous",{simple:true})!==3) refuse("ERASURE_FENCE_STORAGE_INVALID");
      const ddl=this.#db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
      if (!ddl.length) {
        if(input.initialize!==true)refuse("ERASURE_FENCE_NOT_INITIALIZED");
        this.#db.exec(schema);
        this.#db.prepare("INSERT INTO fence_state VALUES (1,?,'CLOSED',-1,'',NULL)").run(input.scope);
      } else {
        const expected=new Database(":memory:");
        try { expected.exec(schema); if(JSON.stringify(ddl)!==JSON.stringify(expected.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all())) refuse("ERASURE_FENCE_STORAGE_INVALID"); }
        finally {expected.close();}
      }
      if (this.#state().scope!==input.scope || (this.#db.prepare("SELECT COUNT(*) AS n FROM fence_state").get() as {n:number}).n!==1) refuse("ERASURE_FENCE_STORAGE_INVALID");
    } catch {refuse("ERASURE_FENCE_STORAGE_INVALID");}
    this.#scope=input.scope; this.#keys={signing:{...input.keys.signing},subject:Object.fromEntries(Object.entries(input.keys.subject).map(([id,key])=>[id,Buffer.from(key)]))};
    this.#read=input.readCurrent; this.#now=input.now??(()=>new Date());
    } catch(error) {
      connection?.close();
      if(error instanceof ErasureLedgerError)throw error;
      refuse("ERASURE_FENCE_STORAGE_INVALID");
    }
  }
  #state() {return this.#db.prepare("SELECT * FROM fence_state WHERE id=1").get() as State;}
  #proof(proof: VerifiedErasureLedger) {
    VerifiedErasureLedger.prototype.assertFresh.call(proof,this.#now());
    if(proof.bundle.scope!==this.#scope) refuse("ERASURE_SCOPE_MISMATCH");
    for(const entry of proof.bundle.entries)assertErasureSubjectKey(this.#keys,entry.body.subject);
  }
  closeAdmission() {this.#bootQualified=false; this.#db.prepare("UPDATE fence_state SET state='CLOSED' WHERE id=1").run();}
  status() {return {state:this.#state().state, leases:(this.#db.prepare("SELECT COUNT(*) AS n FROM fence_leases").get() as {n:number}).n,
    unknown:(this.#db.prepare("SELECT COUNT(*) AS n FROM fence_leases WHERE outcome='UNKNOWN'").get() as {n:number}).n};}
  async ready() {
    if(!this.#bootQualified || this.#state().state!=="OPEN" || this.#state().owner)return false;
    try {const proof=await this.#read();this.#proof(proof);const state=this.#state();
      if(state.sequence!==proof.bundle.entries.length || state.head_hash!==(proof.bundle.entries.at(-1)?.hash??"EMPTY")) throw new Error();
      return state.state==="OPEN" && !state.owner;
    } catch {this.closeAdmission();return false;}
  }
  #assertDrained() {if(this.#state().state!=="CLOSED" || this.status().leases) refuse("ERASURE_DRAIN_PENDING");}
  /** Only this exclusive owner closure may append/apply/reopen. Crash leaves owner set:
   * explicit independently evidenced operator reconciliation is required, not a timeout. */
  async withDrained<T>(merchant: Database.Database, operation: (proof: DrainedErasureRuntime) => Promise<T>): Promise<T> {
    this.closeAdmission(); const owner=randomUUID();
    this.#db.transaction(()=>{
      this.#assertDrained(); if(this.#state().owner) refuse("ERASURE_OWNER_RECONCILIATION_REQUIRED");
      this.#db.prepare("UPDATE fence_state SET owner=? WHERE id=1").run(owner);
    }).immediate();
    const assertOwner=()=>{this.#assertDrained(); if(this.#state().owner!==owner) refuse("ERASURE_DRAIN_INVALID");};
    try { return await operation(issueDrain(this.#scope,merchant,assertOwner)); }
    finally {this.#db.prepare("UPDATE fence_state SET owner=NULL WHERE id=1 AND owner=?").run(owner);}
  }
  /** Applied proof and newest remote proof must coincide. Caller must apply the signed
   * ledger to the closed merchant database inside this same drain capability first. */
  async reopen(drain: DrainedErasureRuntime, applied: VerifiedErasureLedger, application: unknown) {
    DrainedErasureRuntime.assert(drain,drain.merchant,this.#scope); this.#proof(applied);
    assertErasureApplication(application,drain,drain.merchant,applied);
    const latest=await this.#read(); this.#proof(latest);
    if(JSON.stringify(latest.bundle)!==JSON.stringify(applied.bundle)) refuse("ERASURE_LEDGER_CHANGED_DURING_ADMISSION");
    DrainedErasureRuntime.assert(drain,drain.merchant,this.#scope);
    assertErasureApplication(application,drain,drain.merchant,applied);
    this.#db.prepare("UPDATE fence_state SET sequence=?,head_hash=? WHERE id=1")
      .run(latest.bundle.entries.length,latest.bundle.entries.at(-1)?.hash??"EMPTY");
    // OPEN is set only after the owner closure returns, never while the owner lock remains.
    this.#bootQualified=true;
  }
  /** Opens only the same process that performed/verified application under withDrained.
   * Shared clients must separately boot-qualify; copied OPEN control DB is not authority. */
  openQualified() {
    if(!this.#bootQualified || this.#state().owner) refuse("ERASURE_RUNTIME_BOOT_UNQUALIFIED");
    this.#assertDrained(); this.#db.prepare("UPDATE fence_state SET state='OPEN' WHERE id=1").run();
  }
  async #acquire(kind: "REQUEST" | "WORKER" | "SEND") {
    if(!this.#bootQualified) refuse("ERASURE_RUNTIME_BOOT_UNQUALIFIED");
    const id=randomUUID();
    this.#db.transaction(()=>{
      const state=this.#state(); if(state.state!=="OPEN" || state.owner) refuse("ERASURE_RUNTIME_CLOSED");
      this.#db.prepare("INSERT INTO fence_leases VALUES (?,?,'ACTIVE')").run(id,kind);
    }).immediate();
    try {
      const proof=await this.#read(); this.#proof(proof); const state=this.#state();
      if(state.sequence!==proof.bundle.entries.length || state.head_hash!==(proof.bundle.entries.at(-1)?.hash??"EMPTY")) refuse("ERASURE_RUNTIME_LEDGER_UNAPPLIED");
      return {id,proof,active:true};
    } catch {
      this.closeAdmission(); this.#db.prepare("DELETE FROM fence_leases WHERE id=?").run(id);
      return refuse("ERASURE_RUNTIME_AUTHORITY_UNAVAILABLE");
    }
  }
  async run<T>(kind: "REQUEST" | "WORKER", operation: () => Promise<T>): Promise<T> {
    const context=await this.#acquire(kind);
    try {return await this.#context.run(context,operation);}
    finally {context.active=false; this.#db.prepare("DELETE FROM fence_leases WHERE id=?").run(context.id);}
  }
  assertIdentity(identity: {email?: string; userId?: string; customerId?: string}, purpose: "ACCOUNT" | "MAIL") {
    const context=this.#context.getStore();
    if(!context?.active) refuse("ERASURE_RUNTIME_OPERATION_UNFENCED");
    this.#proof(context.proof);
    if(!Object.values(identity).some(value=>typeof value==="string" && value.length)) refuse("ERASURE_RUNTIME_IDENTITY_REQUIRED");
    for(const entry of context.proof.bundle.entries) {
      if(purpose==="ACCOUNT" && entry.body.kind!=="ERASURE") continue;
      const subject=entry.body.subject;
      const match=(category:"email"|"user"|"customer",value:string|undefined)=>value!==undefined && erasurePseudonym(this.#keys,subject.keyId,this.#scope,category,value)===subject[category];
      if(match("email",identity.email)||match("user",identity.userId)||match("customer",identity.customerId)) refuse("ERASURE_SUBJECT_SUPPRESSED");
    }
  }
  /** Separate durable SEND lease survives swallowed auth/worker errors. UNKNOWN means
   * remote delivery may have happened; no timed release, no retry/send-after-admission. */
  async send<T>(email: string, operation: () => Promise<T>): Promise<T> {
    this.assertIdentity({email},"MAIL");
    const context=await this.#acquire("SEND");
    // Definite pre-send refusal is not an ambiguous provider attempt.
    try {this.assertIdentity({email},"MAIL");}
    catch(error) {this.#db.prepare("DELETE FROM fence_leases WHERE id=?").run(context.id);throw error;}
    try {
      const result=await operation();
      this.#db.prepare("DELETE FROM fence_leases WHERE id=?").run(context.id); return result;
    } catch {
      this.#db.prepare("UPDATE fence_leases SET outcome='UNKNOWN' WHERE id=?").run(context.id); this.closeAdmission();
      return refuse("ERASURE_SEND_OUTCOME_UNKNOWN");
    }
  }
  close() {this.#db.close();}
}
