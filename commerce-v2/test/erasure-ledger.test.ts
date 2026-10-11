import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErasureLedgerStore, VerifiedErasureLedger, erasureSubject, issueErasureCheckpoint, type ErasureKeys, type ErasureBundle } from "../src/erasure-ledger";

const now = new Date("2026-10-11T12:00:00.000Z");
let directory: string;
let stores: ErasureLedgerStore[];
let keys: ErasureKeys;
let signer: ReturnType<typeof generateKeyPairSync> & { keyId: string };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "flex-erasure-core-")); stores = [];
  mkdirSync(join(directory, "merchant"), { mode: 0o700 }); mkdirSync(join(directory, "ledger"), { mode: 0o700 });
  signer = { ...generateKeyPairSync("ed25519"), keyId: "signing-1" };
  keys = { signing: { "signing-1": signer.publicKey }, subject: { "subject-1": randomBytes(32) } };
});
afterEach(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
const options = () => ({ directory: join(directory, "ledger"), scope: "canary" as const,
  forbiddenRoots: [join(directory, "merchant")], keys, signer });
const open = () => { const store = new ErasureLedgerStore(options()); stores.push(store); return store; };
const subject = () => erasureSubject(keys, "subject-1", "canary", { email: " Owner@Example.test ", customerId: "customer-old", userId: "user-old" });
const append = (store: ErasureLedgerStore) => store.append({ requestId: randomUUID(), kind: "ERASURE", subject: subject() }, now);
const read = (bundle: ErasureBundle, current = bundle, changes = {}) => VerifiedErasureLedger.read({
  scope: "canary", bundle, keys, now: () => now,
  readCurrentCheckpoint: async nonce => issueErasureCheckpoint(current, nonce, signer, keys, now), ...changes,
});

describe("independent signed erasure journal core, no merchant/live wiring", () => {
  it("durably reopens minimal pseudonyms and returns an idempotent existing append", async () => {
    const store = open(); const entry = append(store);
    expect(store.append({ requestId: entry.body.requestId, kind: "ERASURE", subject: subject() }, new Date(now.getTime() + 1000))).toEqual(entry);
    expect(() => store.append({ requestId: entry.body.requestId, kind: "MARKETING_SUPPRESSION", subject: subject() }, now)).toThrow("ERASURE_REQUEST_CONFLICT");
    const bundle = open().export(); expect(bundle.entries).toEqual([entry]);
    expect((await read(bundle)).bundle).toEqual(bundle);
    expect(JSON.stringify(bundle)).not.toMatch(/owner@example|customer-old|user-old/i);
    expect(JSON.stringify(store)).toBe("{}");
    expect(readFileSync(join(directory, "ledger", "erasure-ledger.sqlite")).includes(Buffer.from("Owner@Example.test"))).toBe(false);
    expect(statSync(join(directory, "ledger", "erasure-ledger.sqlite")).mode & 0o777).toBe(0o600);
  });
  it("serializes separate writers on one independent SQLite sequence", async () => {
    const first = open(); const second = open(); append(first); append(second); append(first);
    expect(second.export().entries.map(entry => entry.body.sequence)).toEqual([1, 2, 3]);
    await expect(read(first.export())).resolves.toBeInstanceOf(VerifiedErasureLedger);
  });
  it("refuses wrong-environment reopen without contaminating the existing identity", () => {
    const store = open(); append(store); const before = store.export();
    expect(() => new ErasureLedgerStore({ ...options(), scope: "production" })).toThrow("ERASURE_STORAGE_INVALID");
    expect(store.export()).toEqual(before); expect(open().export()).toEqual(before);
  });
  it.each(["delete", "reorder", "duplicate", "body", "signature", "hash", "extra"])("rejects causal %s corruption even with a genuine latest checkpoint", async change => {
    const store = open(); append(store); append(store);
    const complete = store.export(); const altered = structuredClone(complete);
    if (change === "delete") altered.entries.pop();
    if (change === "reorder") altered.entries.reverse();
    if (change === "duplicate") altered.entries[1] = altered.entries[0];
    if (change === "body") altered.entries[0].body.kind = "MARKETING_SUPPRESSION";
    if (change === "signature") altered.entries[0].signature = "a".repeat(86);
    if (change === "hash") altered.entries[0].hash = "a".repeat(64);
    if (change === "extra") Object.assign(altered.entries[0].body, { rawEmail: "secret@example.test" });
    await expect(read(altered, complete)).rejects.toThrow(/ERASURE_/);
  });
  it("rejects an authentic older complete ledger and never trusts its own signed head for freshness", async () => {
    const store = open(); const old = store.export(); append(store);
    await expect(read(old, store.export())).rejects.toThrow("ERASURE_LEDGER_STALE_OR_INCOMPLETE");
    await expect(read(store.export(), old)).rejects.toThrow("ERASURE_LEDGER_STALE_OR_INCOMPLETE");
  });
  it.each(["unavailable", "nonce", "expired", "future", "scope", "signature"])("fails closed on checkpoint %s", async change => {
    const store = open(); const bundle = store.export();
    await expect(read(bundle, bundle, { readCurrentCheckpoint: async (nonce: string) => {
      if (change === "unavailable") throw new Error("RAW_PROVIDER_TOKEN_NEVER_EXPOSE");
      const checkpoint = issueErasureCheckpoint(bundle, change === "nonce" ? "a".repeat(64) : nonce, signer, keys,
        change === "expired" ? new Date(now.getTime() - 60_001) : change === "future" ? new Date(now.getTime() + 1) : now);
      if (change === "scope") checkpoint.body.scope = "production";
      if (change === "signature") checkpoint.signature = "a".repeat(86);
      return checkpoint;
    } })).rejects.toThrow(/ERASURE_/);
  });
  it("requires all historical signing and subject key generations, including matching subject key fingerprints", async () => {
    const store = open(); append(store); const bundle = store.export();
    const checkpoint = async (nonce: string) => issueErasureCheckpoint(bundle, nonce, signer, keys, now);
    await expect(read(bundle, bundle, { keys: { ...keys, signing: {} }, readCurrentCheckpoint: checkpoint })).rejects.toThrow("ERASURE_SIGNING_KEY_MISSING");
    await expect(read(bundle, bundle, { keys: { ...keys, subject: {} }, readCurrentCheckpoint: checkpoint })).rejects.toThrow("ERASURE_SUBJECT_KEY_MISSING");
    await expect(read(bundle, bundle, { keys: { ...keys, subject: { "subject-1": randomBytes(32) } }, readCurrentCheckpoint: checkpoint })).rejects.toThrow("ERASURE_SUBJECT_KEY_MISSING");
  });
  it("verifies mixed signing/subject generations after rotation without rewriting history", async () => {
    const store = open(); append(store); const first = store.export().entries[0];
    const next = generateKeyPairSync("ed25519");
    keys = { signing: { ...keys.signing, "signing-2": next.publicKey }, subject: { ...keys.subject, "subject-2": randomBytes(32) } };
    signer = { ...next, keyId: "signing-2" };
    const rotated = open();
    rotated.append({ requestId: randomUUID(), kind: "MARKETING_SUPPRESSION",
      subject: erasureSubject(keys, "subject-2", "canary", { email: "owner@example.test", customerId: "customer-old", userId: "user-old" }) }, now);
    const bundle = rotated.export(); expect(bundle.entries[0]).toEqual(first);
    await expect(read(bundle)).resolves.toBeInstanceOf(VerifiedErasureLedger);
  });
  it("expires admission, freezes verified data and refuses a structurally forged capability", async () => {
    const store = open(); append(store); const verified = await read(store.export());
    expect(() => verified.assertFresh(new Date(now.getTime() + 60_001))).toThrow("ERASURE_ADMISSION_EXPIRED");
    expect(() => { verified.bundle.entries[0].body.kind = "MARKETING_SUPPRESSION"; }).toThrow();
    const fake = Object.create(VerifiedErasureLedger.prototype) as VerifiedErasureLedger;
    expect(() => fake.assertFresh(now)).toThrow("ERASURE_ADMISSION_INVALID");
    // TypeScript private is erased at runtime; direct JS construction is refused.
    expect(() => Reflect.construct(VerifiedErasureLedger, [verified.bundle, now.getTime(), {}])).toThrow("ERASURE_ADMISSION_INVALID");
  });
  it("rejects a cached signed checkpoint replay because each read uses a new nonce", async () => {
    const bundle = open().export(); let cached: unknown;
    const readCurrentCheckpoint = async (nonce: string) => cached ??= issueErasureCheckpoint(bundle, nonce, signer, keys, now);
    await read(bundle, bundle, { readCurrentCheckpoint });
    await expect(read(bundle, bundle, { readCurrentCheckpoint })).rejects.toThrow("ERASURE_CHECKPOINT_INVALID");
  });
  it("refuses an invalid verification clock instead of issuing an indefinitely fresh capability", async () => {
    const bundle = open().export();
    await expect(read(bundle, bundle, { now: () => new Date(NaN) })).rejects.toThrow("ERASURE_CHECKPOINT_INVALID");
  });
  it("refuses an invalid admission clock even for a genuine capability", async () => {
    const verified = await read(open().export());
    expect(() => verified.assertFresh(new Date(NaN))).toThrow("ERASURE_ADMISSION_EXPIRED");
  });
  it.each(["scope", "sequence", "version"])("rejects an append input overriding owner-controlled %s without corrupting the ledger", field => {
    const store = open(); const before = store.export();
    expect(() => store.append({ requestId: randomUUID(), kind: "ERASURE", subject: subject(),
      [field]: field === "scope" ? "production" : field === "sequence" ? 2 : 1 }, now)).toThrow("ERASURE_LEDGER_INVALID");
    expect(store.export()).toEqual(before); expect(open().export()).toEqual(before);
  });
  it("pins owner scope/configuration rather than trusting a subsequently mutated caller object", async () => {
    const configuration = options(); const store = new ErasureLedgerStore(configuration); stores.push(store);
    Object.assign(configuration, { scope: "production" });
    append(store); expect(store.export().scope).toBe("canary"); await expect(read(store.export())).resolves.toBeInstanceOf(VerifiedErasureLedger);
  });
  it("refuses merchant roots, symlinks, loose permissions and foreign SQLite tables", () => {
    expect(() => new ErasureLedgerStore({ ...options(), directory: join(directory, "merchant") })).toThrow("ERASURE_STORAGE_NOT_INDEPENDENT");
    chmodSync(join(directory, "ledger"), 0o755);
    expect(() => new ErasureLedgerStore(options())).toThrow("ERASURE_STORAGE_INVALID");
    chmodSync(join(directory, "ledger"), 0o700);
    const link = join(directory, "link"); symlinkSync(join(directory, "ledger"), link);
    expect(() => new ErasureLedgerStore({ ...options(), directory: link })).toThrow("ERASURE_STORAGE_INVALID");
    const foreign = new Database(join(directory, "ledger", "erasure-ledger.sqlite")); foreign.exec("CREATE TABLE customers(id TEXT)"); foreign.close();
    chmodSync(join(directory, "ledger", "erasure-ledger.sqlite"), 0o600);
    expect(() => new ErasureLedgerStore(options())).toThrow("ERASURE_STORAGE_INVALID");
  });
  it("refuses time regression and mutation of durable records", () => {
    const store = open(); append(store);
    expect(() => store.append({ requestId: randomUUID(), kind: "ERASURE", subject: subject() }, new Date(now.getTime() - 1))).toThrow("ERASURE_CLOCK_REGRESSION");
    const other = new Database(join(directory, "ledger", "erasure-ledger.sqlite"));
    try {
      expect(() => other.exec("DELETE FROM erasure_entries")).toThrow("ERASURE_HISTORY_IMMUTABLE");
      expect(() => other.exec("UPDATE erasure_entries SET request_id='forged'")).toThrow("ERASURE_HISTORY_IMMUTABLE");
    } finally { other.close(); }
  });
});
