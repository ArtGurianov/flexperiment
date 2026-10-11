import Database from "better-sqlite3";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV2 } from "../src/db";
import { createAuthRuntime } from "../src/auth";
import { bindVerifiedAuthUser } from "../src/customers";
import { ErasureLedgerStore, type ErasureKeys, type ErasureSigner } from "../src/erasure-ledger";
import { VerifiedErasureRequest, pendingManualErasureCase } from "../src/erasure-request";
import { ErasureCustodian, confirmRemoteErasureRequest, readRemoteErasureLedger, type ErasureCustodyObjects } from "../src/erasure-custody";

let directory: string; let db: Database.Database; let remoteDb: Database.Database;
let keys: ErasureKeys; let signer: ErasureSigner; let store: ErasureLedgerStore;
let remote: ErasureCustodyObjects; let owner: ErasureCustodian; let identity: string; let recipient: string;
const now = new Date("2026-10-11T12:00:00Z");
const uuid = () => randomUUID();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "flex-erasure-custody-"));
  mkdirSync(join(directory, "merchant"), { mode: 0o700 }); mkdirSync(join(directory, "ledger"), { mode: 0o700 });
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  db.exec(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('user','Owner','owner@example.test',1);
    INSERT INTO "session"(id,token,user_id,expires_at) VALUES ('session','private-session-token','user','2026-10-12T12:00:00Z');`);
  bindVerifiedAuthUser(db, { id: "user", email: "owner@example.test", name: "Owner" });
  const pair = generateKeyPairSync("ed25519"); signer = { keyId: "signing-1", privateKey: pair.privateKey };
  keys = { signing: { "signing-1": pair.publicKey }, subject: { "subject-1": randomBytes(32) } };
  store = new ErasureLedgerStore({ directory: join(directory, "ledger"), scope: "canary", forbiddenRoots: [join(directory, "merchant")], keys, signer });
  const generated = spawnSync("age-keygen", [], { encoding: "utf8" }); expect(generated.status).toBe(0);
  identity = join(directory, "recovery.age"); writeFileSync(identity, generated.stdout, { mode: 0o600 });
  recipient = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
  // Durable local remote-store fixture, NOT proof of Cloud.ru/off-VPS operation.
  remoteDb = new Database(join(directory, "remote.sqlite")); chmodSync(join(directory, "remote.sqlite"), 0o600);
  remoteDb.pragma("journal_mode=DELETE"); remoteDb.pragma("synchronous=EXTRA");
  remoteDb.exec("CREATE TABLE objects(key TEXT PRIMARY KEY,bytes BLOB NOT NULL,etag TEXT NOT NULL)");
  remote = {
    read: async key => (remoteDb.prepare("SELECT bytes,etag FROM objects WHERE key=?").get(key) as {bytes: Buffer; etag: string} | undefined) ?? null,
    create: async (key, bytes) => { remoteDb.prepare("INSERT INTO objects VALUES (?,?,?)").run(key, bytes, `"${sha(bytes)}"`); },
    compareExchange: async (key, bytes, etag) => {
      if (remoteDb.prepare("UPDATE objects SET bytes=?,etag=? WHERE key=? AND etag=?").run(bytes, `"${sha(bytes)}"`, key, etag).changes !== 1) throw new Error("412 REFLECTED_SECRET");
    },
  };
  owner = new ErasureCustodian({ store, remote, scope: "canary", keys, signer, recipient });
});
afterEach(() => { store.close(); db.close(); remoteDb.close(); rmSync(directory, { recursive: true, force: true }); });
const session = () => ({ user: { id: "user", email: "owner@example.test", emailVerified: true },
  session: { id: "session", userId: "user", expiresAt: new Date("2026-10-12T12:00:00Z") } });
const request = (changes = {}) => VerifiedErasureRequest.fromSession({ db, scope: "canary", keys,
  subjectKeyId: "subject-1", body: {requestId: uuid()}, headers: new Headers({origin: "https://canary-platform.flexperiment.ru"}),
  allowedOrigins: ["https://canary-platform.flexperiment.ru"], getSession: async () => session(), now: () => now, ...changes });
const reader = () => ({ scope: "canary" as const, keys, read: (nonce: string) => owner.reconcile(null, nonce, now), now: () => now });

describe("verified requests and independent encrypted custody, installation CLOSED", () => {
  it("derives proof from a real Better Auth magic-link session, without requiring content consent", async () => {
    let link = "";
    const auth = createAuthRuntime({ db, sendMagicLinkEmail: async message => { link = message.url; },
      environment: { NODE_ENV: "test", BETTER_AUTH_SECRET: "a-test-secret-that-is-long-enough-for-auth" } });
    const initiation = await auth.auth.handler(new Request("http://localhost:3002/v1/auth/sign-in/magic-link", {
      method: "POST", headers: {"content-type": "application/json", origin: "http://localhost:3002"},
      body: JSON.stringify({email: "owner@example.test", callbackURL: "http://localhost:3001/account", metadata: {storefront: "COURSES"}}) }));
    expect(initiation.status).toBe(200);
    const verification = await auth.auth.handler(new Request(link, {headers: {origin: "http://localhost:3002"}}));
    expect([200,302]).toContain(verification.status);
    const cookies = verification.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const verified = await request({ headers: new Headers({cookie: cookies, origin: "http://localhost:3002"}),
      allowedOrigins: ["http://localhost:3002"], getSession: (headers: Headers) => auth.auth.api.getSession({headers}), now: () => new Date() });
    verified.assertCurrent(db); expect(JSON.stringify(verified)).not.toMatch(/owner@example|private-session|cookie/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM authenticated_consent_actions").get()).toEqual({n: 0});
  });
  it.each(["foreign-origin","no-origin","raw-email","unverified","wrong-user","revoked","expired","changed-email"])("refuses %s without any ledger append", async scenario => {
    let options = {};
    if (scenario === "foreign-origin") options = {headers: new Headers({origin: "https://foreign.test"})};
    if (scenario === "no-origin") options = {headers: new Headers()};
    if (scenario === "raw-email") options = {body: {requestId: uuid(), email: "victim@example.test"}};
    if (scenario === "unverified") options = {getSession: async () => ({...session(), user: {...session().user, emailVerified: false}})};
    if (scenario === "wrong-user") options = {getSession: async () => ({...session(), session: {...session().session, userId: "foreign"}})};
    if (scenario === "revoked") db.exec('DELETE FROM "session"');
    if (scenario === "expired") db.exec(`UPDATE "session" SET expires_at='2026-10-10T12:00:00Z'`);
    if (scenario === "changed-email") db.exec(`UPDATE "user" SET email='other@example.test'`);
    await expect(request(options)).rejects.toThrow(/ERASURE_REQUEST_/); expect(store.export().entries).toHaveLength(0);
  });
  it("keeps manual email pending; rejects forged/stale capabilities and rechecks session before append", async () => {
    expect(pendingManualErasureCase(uuid()).state).toBe("PENDING_IDENTITY_VERIFICATION");
    await owner.initializeEmptyCustody(now); const verified = await request();
    await expect(owner.submit(db, {...verified, assertCurrent: () => undefined} as unknown as VerifiedErasureRequest, now)).rejects.toThrow("ERASURE_REQUEST_UNVERIFIED");
    await expect(owner.submit(db, verified, new Date(now.getTime()+60_001))).rejects.toThrow("ERASURE_REQUEST_UNVERIFIED");
    db.exec('DELETE FROM "session"'); await expect(owner.submit(db, verified, now)).rejects.toThrow("ERASURE_REQUEST_UNVERIFIED");
    expect(store.export().entries).toHaveLength(0);
  });
  it("requires explicit initialization and confirms only encrypted remote read-back, never local append", async () => {
    const verified = await request(); await expect(owner.reconcile(null, "0".repeat(64), now)).rejects.toThrow("ERASURE_REMOTE_UNINITIALIZED");
    await owner.initializeEmptyCustody(now); await expect(owner.initializeEmptyCustody(now)).rejects.toThrow("INITIALIZATION_REFUSED");
    expect((await owner.submit(db, verified, now)).state).toBe("REMOTE_RECONCILIATION_REQUIRED");
    expect((await confirmRemoteErasureRequest(verified, reader())).state).toBe("REMOTE_DURABLE_CONFIRMED");
    const head = JSON.parse((await remote.read("head.json"))!.bytes.toString());
    const packet = JSON.parse((await remote.read(head.body.objectRef))!.bytes.toString());
    const plain = spawnSync("age", ["--decrypt", "--identity", identity], {input: Buffer.from(packet.ciphertext, "base64")});
    expect(plain.status).toBe(0); expect(JSON.parse(plain.stdout.toString())).toEqual(store.export());
    expect(JSON.stringify(packet)).not.toContain(verified.subject.email);
    const reopened = new Database(join(directory, "remote.sqlite"), {readonly: true});
    try { expect(reopened.prepare("SELECT COUNT(*) AS n FROM objects").get()).toEqual({n: 3}); } finally { reopened.close(); }
  });
  it.each(["before-upload","after-upload","after-head"])("survives %s failure with GET-only reconciliation and explicit pending publication", async point => {
    await owner.initializeEmptyCustody(now); const verified = await request();
    const originalCreate = remote.create; const originalCAS = remote.compareExchange;
    if (point !== "after-head") remote.create = async (key, bytes) => {
      if (point === "after-upload") await originalCreate(key, bytes);
      throw new Error("REFLECTED_SECRET_URL");
    };
    else remote.compareExchange = async (...args) => { await originalCAS(...args); throw new Error("REFLECTED_SECRET_URL"); };
    await expect(owner.submit(db, verified, now)).rejects.toThrow("ERASURE_REMOTE_OPERATION_UNCONFIRMED");
    expect(store.export().entries).toHaveLength(1);
    remote.create = vi.fn(originalCreate); remote.compareExchange = vi.fn(originalCAS);
    await owner.submit(db, verified, now); expect(remote.create).not.toHaveBeenCalled(); expect(remote.compareExchange).not.toHaveBeenCalled();
    if (point !== "after-head") {
      await expect(confirmRemoteErasureRequest(verified, reader())).rejects.toThrow(/ERASURE_/);
      await owner.publishPending(now);
    }
    expect((await confirmRemoteErasureRequest(verified, reader())).state).toBe("REMOTE_DURABLE_CONFIRMED");
    if (point === "after-head") { expect(remote.create).not.toHaveBeenCalled(); expect(remote.compareExchange).not.toHaveBeenCalled(); }
  });
  it("refuses stale local recovery against the newer durable remote head", async () => {
    await owner.initializeEmptyCustody(now); await owner.submit(db, await request(), now);
    const other = join(directory, "old-ledger"); mkdirSync(other, {mode: 0o700});
    const old = new ErasureLedgerStore({directory: other, scope: "canary", forbiddenRoots: [join(directory,"merchant")], keys, signer});
    try {
      const stale = new ErasureCustodian({store: old, remote, scope: "canary", keys, signer, recipient});
      await expect(stale.publishPending(now)).rejects.toThrow("ERASURE_LOCAL_LEDGER_STALE_OR_FORKED");
      await expect(stale.reconcile(null,"0".repeat(64),now)).rejects.toThrow("ERASURE_LOCAL_LEDGER_STALE_OR_FORKED");
    } finally { old.close(); }
  });
  it("rejects a conditional-write race; never treats a different head as ACK", async () => {
    await owner.initializeEmptyCustody(now);
    const original = remote.compareExchange;
    remote.compareExchange = async (key, bytes, etag) => {
      remoteDb.prepare("UPDATE objects SET etag=? WHERE key=?").run('"raced"', key);
      await original(key, bytes, etag);
    };
    await expect(owner.submit(db, await request(), now)).rejects.toThrow("ERASURE_REMOTE_OPERATION_UNCONFIRMED");
    await expect(readRemoteErasureLedger(reader())).rejects.toThrow(/ERASURE_/);
  });
  it.each(["ciphertext","signature","oversized","malformed","missing"])("fails closed on remote %s", async mode => {
    await owner.initializeEmptyCustody(now); await owner.submit(db,await request(),now);
    const head = JSON.parse((await remote.read("head.json"))!.bytes.toString());
    const row = await remote.read(head.body.objectRef); const parsed = JSON.parse(row!.bytes.toString());
    let bytes = row!.bytes;
    if (mode === "ciphertext") { parsed.ciphertext = Buffer.from("reflected-secret").toString("base64"); bytes = Buffer.from(JSON.stringify(parsed)); }
    if (mode === "signature") { parsed.signature = "a".repeat(86); bytes = Buffer.from(JSON.stringify(parsed)); }
    if (mode === "oversized") bytes = Buffer.alloc(9*1024*1024, 0x61);
    if (mode === "malformed") bytes = Buffer.from("SECRET not JSON");
    if (mode === "missing") remoteDb.prepare("DELETE FROM objects WHERE key=?").run(head.body.objectRef);
    else remoteDb.prepare("UPDATE objects SET bytes=? WHERE key=?").run(bytes, head.body.objectRef);
    await expect(readRemoteErasureLedger(reader())).rejects.toThrow(/ERASURE_/);
  });
  it("requires a fresh nonce, exact request subject and all retained key generations", async () => {
    await owner.initializeEmptyCustody(now); const verified = await request(); await owner.submit(db,verified,now);
    let cached: Awaited<ReturnType<typeof owner.reconcile>> | undefined;
    const read = async (nonce: string) => cached ??= await owner.reconcile(null,nonce,now);
    await readRemoteErasureLedger({...reader(),read});
    await expect(readRemoteErasureLedger({...reader(),read})).rejects.toThrow("ERASURE_CHECKPOINT_INVALID");
    await expect(confirmRemoteErasureRequest(await request(),reader())).rejects.toThrow("ERASURE_REQUEST_NOT_REMOTE_CONFIRMED");
    await expect(readRemoteErasureLedger({...reader(),keys:{...keys,subject:{}}})).rejects.toThrow("ERASURE_SUBJECT_KEY_MISSING");
    await expect(readRemoteErasureLedger({...reader(),keys:{...keys,signing:{}}})).rejects.toThrow(/ERASURE_/);
    await expect(readRemoteErasureLedger({...reader(),now:()=>new Date(now.getTime()+60_001)})).rejects.toThrow("ERASURE_CHECKPOINT_INVALID");
    await expect(readRemoteErasureLedger({...reader(),read:async()=>({secret:"REFLECTED_SECRET"}) as never})).rejects.toThrow("ERASURE_CHECKPOINT_UNAVAILABLE");
  });
});
