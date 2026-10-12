import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErasureCustodian, ageCustodyEncryption } from "../src/erasure-custody";
import { createErasureS3Custody } from "../src/erasure-custody-s3";
import { createCurrentErasureRead, createErasureCurrentObjects, erasureReaderBinding, readErasureReaderFile, type ErasureReadConfiguration } from "../src/erasure-library-read";
import { ErasureLedgerStore, erasureSubject, readOwnerErasureBundle, type ErasureKeys, type ErasureSigner } from "../src/erasure-ledger";
import { ErasureInstallationEvidence } from "../src/erasure-installation";
import { ErasureRuntimeFence } from "../src/erasure-fence";
import { prepareErasureRuntime } from "../src/erasure-runtime";
import { migrateV2 } from "../src/db";
import { bindVerifiedAuthUser } from "../src/customers";
import { installationFixture } from "./fixtures/erasure-installation";
import { erasureS3Fixture } from "./fixtures/erasure-s3";

let root: string; let keys: ErasureKeys; let signer: ErasureSigner; let ledger: ErasureLedgerStore;
let owner: ErasureCustodian; let wire: ReturnType<typeof erasureS3Fixture>; let config: ErasureReadConfiguration;
let reader: ReturnType<typeof createErasureCurrentObjects>; let writer: ReturnType<typeof createErasureS3Custody>;
let clock: Date; let gates: ErasureRuntimeFence[]; let recipient: string;
const bundle = () => readOwnerErasureBundle({directory: join(root, "ledger"), scope: "canary", keys, forbiddenRoots: [join(root, "merchant")]});
const read = () => createCurrentErasureRead({scope: "canary", keys, remote: reader, recipientSha256: config.recipientSha256, readBundle: bundle, now: () => clock});
const append = async () => {
  ledger.append({requestId: randomUUID(), kind: "ERASURE", subject: erasureSubject(keys, "subject-1", "canary", {
    email: "owner@example.test", userId: "user", customerId: "customer",
  })}, clock); await owner.publishPending(clock);
};
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "flex-erasure-library-")); gates = []; clock = new Date("2026-10-12T00:00:00Z");
  for (const d of ["merchant", "ledger", "fence"]) mkdirSync(join(root, d), {mode: 0o700});
  const pair = generateKeyPairSync("ed25519"); signer = {keyId: "signing-1", privateKey: pair.privateKey};
  keys = {signing: {"signing-1": pair.publicKey}, subject: {"subject-1": randomBytes(32)}};
  ledger = new ErasureLedgerStore({directory: join(root, "ledger"), scope: "canary", keys, signer, forbiddenRoots: [join(root, "merchant")]});
  const generated = spawnSync("age-keygen", [], {encoding: "utf8"}); expect(generated.status).toBe(0);
  recipient = generated.stderr.match(/age1[0-9a-z]{58}/)![0]; wire = erasureS3Fixture();
  config = {version: 1, scope: "canary", endpoint: "https://s3.cloud.ru", region: "ru-central-1", bucket: "erasure-canary",
    expectedBucketOwner: "qualification-owner", prefix: "flexperiment/erasure/canary/", bundleFile: join(root, "mirror.json"),
    recipientSha256: ageCustodyEncryption(recipient).recipientSha256, accessKeyId: "TEST_READ_ID", secretAccessKey: "TEST_READ_SECRET"};
  writer = createErasureS3Custody({...config, requestHandler: wire.handler}); reader = createErasureCurrentObjects(config, wire.handler);
  owner = new ErasureCustodian({store: ledger, remote: writer, scope: "canary", keys, signer, recipient});
  await owner.initializeEmptyCustody(clock); wire.requests.length = 0;
});
afterEach(() => {gates.forEach(g => g.close()); reader.close(); writer.close(); ledger.close(); rmSync(root, {recursive: true, force: true});});

describe("library current custody read, real SDK/SQLite/age; no Cloud.ru admission", () => {
  it("reads signed current head, complete packet and version history with READ identity only", async () => {
    await append(); wire.requests.length = 0;
    const current = read(); const proof = await current(); proof.assertFresh(clock);
    expect(proof.bundle.entries).toHaveLength(1); expect(Object.isFrozen(proof.bundle.entries[0].body.subject)).toBe(true);
    const first = wire.requests.length; await current(); expect(wire.requests.length).toBeGreaterThan(first);
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
    expect(wire.requests.filter(r => r.path.endsWith("head.json") && !r.query.versionId)).toHaveLength(4);
    expect(wire.requests.every(r => r.headers["x-amz-expected-bucket-owner"] === "qualification-owner")).toBe(true);
    expect(wire.requests.every(r => r.headers.authorization.includes("TEST_READ_ID") && !r.headers.authorization.includes("TEST_READ_SECRET"))).toBe(true);
    expect(() => proof.assertFresh(new Date(clock.getTime() + 60_001))).toThrow("EXPIRED");
  });
  it.each(["absent", "unavailable", "versioning-off", "delete-marker", "history-empty", "packet-missing", "packet-tampered", "wrong-recipient", "keys-missing"])("fails CLOSED on %s without provider writes", async kind => {
    if (kind === "absent") wire.objects.delete("head.json");
    if (kind === "unavailable") wire.state.unavailable = true;
    if (kind === "versioning-off") wire.state.enabled = false;
    if (kind === "delete-marker") wire.state.deleteMarker = true;
    if (kind === "history-empty") wire.versions.clear();
    const head = JSON.parse(wire.objects.get("head.json")?.toString() ?? "{}");
    if (kind === "packet-missing") wire.objects.delete(head.body.objectRef);
    if (kind === "packet-tampered") wire.objects.set(head.body.objectRef, Buffer.from("REFLECTED_SECRET"));
    if (kind === "wrong-recipient") config.recipientSha256 = "0".repeat(64);
    if (kind === "keys-missing") keys = {...keys, signing: {}};
    await expect(read()()).rejects.toThrow(/ERASURE_/);
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
  });
  it("refuses an old local mirror although the remote current head is newer", async () => {
    const old = bundle(); await append();
    const current = createCurrentErasureRead({scope: "canary", keys, remote: reader, recipientSha256: config.recipientSha256, readBundle: () => old, now: () => clock});
    await expect(current()).rejects.toThrow(/ERASURE_/);
  });
  it("rechecks remote current head on every use and retains the highest confirmed in-process prefix", async () => {
    const current = read(); const oldHead = wire.objects.get("head.json")!;
    await current(); await append(); expect((await current()).bundle.entries).toHaveLength(1);
    wire.objects.set("head.json", oldHead); await expect(current()).rejects.toThrow(/ERASURE_/);
  });
  it.each(["malformed", "incomplete-pagination", "duplicate-version"])("refuses %s version history without repeated requests", async mode => {
    const original = wire.handler.handle;
    wire.handler.handle = async r => {
      if (!Object.hasOwn(r.query, "versions")) return original(r);
      const xml = mode === "malformed" ? "<ListVersionsResult/>" : mode === "incomplete-pagination" ?
        "<ListVersionsResult><IsTruncated>true</IsTruncated></ListVersionsResult>" :
        `<ListVersionsResult><IsTruncated>false</IsTruncated>${[1, 2].map(() => '<Version><Key>flexperiment/erasure/canary/head.json</Key><VersionId>same</VersionId></Version>').join("")}</ListVersionsResult>`;
      const {Readable} = await import("node:stream"); const bytes = Buffer.from(xml);
      return {response: {statusCode: 200, headers: {"content-length": String(bytes.length)}, body: Readable.from([bytes])}};
    };
    await expect(read()()).rejects.toThrow(/ERASURE_/);
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
  });
  it("detects accidental head rollback on a COLD reader even with the matching OLD local snapshot", async () => {
    const oldHead = wire.objects.get("head.json")!; const old = bundle(); await append();
    wire.objects.set("head.json", oldHead);
    const current = createCurrentErasureRead({scope: "canary", keys, remote: reader, recipientSha256: config.recipientSha256, readBundle: () => old, now: () => clock});
    await expect(current()).rejects.toThrow(/ERASURE_/);
  });
  it("rejects a valid signed same-sequence fork against independently retained history", async () => {
    await append(); const saved = ledger.export(); const path = join(root, "fork"); mkdirSync(path, {mode: 0o700});
    const fork = new ErasureLedgerStore({directory: path, scope: "canary", keys, signer, forbiddenRoots: [join(root, "merchant")]});
    try {
      fork.append({requestId: randomUUID(), kind: "ERASURE", subject: saved.entries[0].body.subject}, clock);
      const otherWire = erasureS3Fixture(); const otherWriter = createErasureS3Custody({...config, requestHandler: otherWire.handler});
      try {
        // A separately signed competing branch, then copied accidentally as current.
        const emptyPath = join(root, "empty"); mkdirSync(emptyPath, {mode: 0o700});
        const empty = new ErasureLedgerStore({directory: emptyPath, scope: "canary", keys, signer, forbiddenRoots: [join(root, "merchant")]});
        try {await new ErasureCustodian({store: empty, scope: "canary", keys, signer, recipient, remote: otherWriter}).initializeEmptyCustody(clock);} finally {empty.close();}
        await new ErasureCustodian({store: fork, scope: "canary", keys, signer, recipient, remote: otherWriter}).publishPending(clock);
        otherWire.objects.forEach((v, k) => wire.objects.set(k, v));
        wire.versions.set("competing-current", wire.objects.get("head.json")!);
      } finally {otherWriter.close();}
      const mirror = fork.export();
      const current = createCurrentErasureRead({scope: "canary", keys, remote: reader, recipientSha256: config.recipientSha256, readBundle: () => mirror, now: () => clock});
      await expect(current()).rejects.toThrow(/ERASURE_/);
    } finally {fork.close();}
  });
  it("rejects a head change between independent reads; never admits the earlier packet", async () => {
    const remote = {headVersions: reader.headVersions, read: async (name: string, id?: string) => {
      const result = await reader.read(name, id); if (name.startsWith("bundles/")) await append(); return result;
    }};
    await expect(createCurrentErasureRead({scope: "canary", keys, remote, recipientSha256: config.recipientSha256, readBundle: bundle, now: () => clock})()).rejects.toThrow(/ERASURE_/);
  });
  it("reconciles a committed lost head ACK with GET-only, not a repeated PUT", async () => {
    ledger.append({requestId: randomUUID(), kind: "ERASURE", subject: erasureSubject(keys, "subject-1", "canary", {email: "owner@example.test", userId: "user", customerId: "customer"})}, clock);
    wire.state.loseAck = "head.json";
    await expect(owner.publishPending(clock)).rejects.toThrow("UNCONFIRMED"); wire.requests.length = 0;
    expect((await read()()).bundle.entries).toHaveLength(1);
    await owner.publishPending(clock); expect(wire.requests.every(r => r.method === "GET")).toBe(true);
  });
  it("boots an OLD merchant backup with NEWEST ledger, erases deleted user and invalidates sessions", async () => {
    const db = new Database(join(root, "merchant", "db.sqlite")); migrateV2(db);
    db.exec(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('user','Owner','owner@example.test',1);
      INSERT INTO "session"(id,token,user_id,expires_at) VALUES ('session','session-private','user','2027-01-01T00:00:00Z');`);
    const customer = bindVerifiedAuthUser(db, {id: "user", email: "owner@example.test", name: "Owner"});
    const backup = db.serialize(); db.close();
    ledger.append({requestId: randomUUID(), kind: "ERASURE", subject: erasureSubject(keys, "subject-1", "canary", {email: "owner@example.test", userId: "user", customerId: customer})}, clock);
    await owner.publishPending(clock);
    const restored = new Database(backup); restored.pragma("foreign_keys=ON");
    const current = read();
    const seed = new ErasureRuntimeFence({directory: join(root, "fence"), scope: "canary", keys, forbiddenRoots: [join(root, "merchant")], readCurrent: current, initialize: true, now: () => clock}); seed.close();
    const keyFile = join(root, "keys.json"); writeFileSync(keyFile, JSON.stringify({version: 1, scope: "canary", signing: {"signing-1": keys.signing["signing-1"].export({type: "spki", format: "pem"})}, subject: {"subject-1": keys.subject["subject-1"].toString("base64")}}), {mode: 0o600});
    const env = {DEPLOY_ENV: "staging", ERASURE_FENCING_ENABLED: "true", ERASURE_SCOPE: "canary", ERASURE_VERIFICATION_KEYS_FILE: keyFile, ERASURE_FENCE_DIRECTORY: join(root, "fence")};
    const installation = installationFixture("REQUIRED", env.ERASURE_FENCE_DIRECTORY, "canary", erasureReaderBinding(config)).read();
    try {
      const gate = await prepareErasureRuntime({db: restored, environment: env, installation, libraryRead: current, forbiddenRoots: [join(root, "merchant")], now: () => clock}); gates.push(gate!);
      expect(await gate!.ready()).toBe(true); expect(restored.prepare('SELECT id FROM "user"').all()).toEqual([]);
      expect(restored.prepare('SELECT id FROM "session"').all()).toEqual([]);
      for (const flag of [undefined, "false"]) await expect(prepareErasureRuntime({db: restored, environment: {...env, ERASURE_FENCING_ENABLED: flag}, installation, forbiddenRoots: [join(root, "merchant")]})).rejects.toThrow("DOWNGRADE_REFUSED");
    } finally {restored.close();}
  });
  it("pins independent namespace and refuses configuration rollback despite valid old signatures", () => {
    const evidence = installationFixture("REQUIRED", join(root, "fence"), "canary", erasureReaderBinding(config)).read();
    ErasureInstallationEvidence.assertReaderBinding(evidence, erasureReaderBinding(config));
    for (const change of [{bucket: "old-canary"}, {scope: "production" as const}, {expectedBucketOwner: "other-owner"}, {recipientSha256: "b".repeat(64)}])
      expect(() => ErasureInstallationEvidence.assertReaderBinding(evidence, erasureReaderBinding({...config, ...change}))).toThrow("READ_BINDING_MISMATCH");
    expect(() => ErasureInstallationEvidence.assertReaderBinding(installationFixture("REQUIRED").read(), erasureReaderBinding(config))).toThrow("READ_BINDING_MISMATCH");
  });
  it("refuses unprotected reader files rather than silently using an HTTPS or unfenced fallback", () => {
    const file = join(root, "reader.json"); writeFileSync(file, JSON.stringify(config), {mode: 0o600});
    expect(() => readErasureReaderFile(file, [join(root, "merchant")])).toThrow("CONFIGURATION_INVALID");
    chmodSync(file, 0o644); expect(() => readErasureReaderFile(file, [join(root, "merchant")])).toThrow("CONFIGURATION_INVALID");
    expect(() => createErasureCurrentObjects({...config, prefix: "flexperiment/erasure/production/"}, wire.handler)).toThrow("CONFIGURATION_INVALID");
    expect(wire.requests).toHaveLength(0);
  });
});
