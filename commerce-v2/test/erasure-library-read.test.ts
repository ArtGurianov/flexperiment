import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { erasureReadFailure, type ErasureDiagnostic } from "../src/erasure-diagnostics";
import Database from "better-sqlite3";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let clock: Date; let gates: ErasureRuntimeFence[]; let recipient: string; let ageIdentity: string;
const bundle = () => readOwnerErasureBundle({directory: join(root, "ledger"), scope: "canary", keys, forbiddenRoots: [join(root, "merchant")]});
const read = (diagnostics?: (event: ErasureDiagnostic) => void) => createCurrentErasureRead({scope: "canary", keys, remote: reader, recipientSha256: config.recipientSha256, readBundle: bundle, now: () => clock, diagnostics});
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
  ageIdentity = generated.stdout;
  recipient = generated.stderr.match(/age1[0-9a-z]{58}/)![0]; wire = erasureS3Fixture();
  config = {version: 1, scope: "canary", endpoint: "https://s3.cloud.ru", region: "ru-central-1", bucket: "erasure-canary",
    expectedBucketOwner: "qualification-owner", prefix: "flexperiment/erasure/canary/", bundleFile: join(root, "mirror.json"),
    recipientSha256: ageCustodyEncryption(recipient).recipientSha256, accessKeyId: "TEST_READ_ID", secretAccessKey: "TEST_READ_SECRET"};
  writer = createErasureS3Custody({...config, requestHandler: wire.handler}); reader = createErasureCurrentObjects(config, wire.handler);
  owner = new ErasureCustodian({store: ledger, remote: writer, scope: "canary", keys, signer, recipient});
  await owner.initializeEmptyCustody(clock); wire.requests.length = 0;
});
afterEach(() => {vi.restoreAllMocks(); vi.useRealTimers(); gates.forEach(g => g.close()); reader.close(); writer.close(); ledger.close(); rmSync(root, {recursive: true, force: true});});

describe("library current custody read, real SDK/SQLite/age; no Cloud.ru admission", () => {
  it.each(["head", "versioning", "versions", "history_head", "packet", "final_head"])("re-verifies a full current proof after one transient %s failure", async stage => {
    await append(); const diagnostics: ErasureDiagnostic[] = []; const original = wire.handler.handle;
    let failed = false; let heads = 0;
    wire.handler.handle = async r => {
      if (r.path.endsWith("head.json") && !r.query.versionId) heads++;
      const matches = stage === "versioning" ? Object.hasOwn(r.query, "versioning")
        : stage === "versions" ? Object.hasOwn(r.query, "versions")
        : stage === "history_head" ? Boolean(r.query.versionId)
        : stage === "packet" ? r.path.includes("/bundles/")
        : r.path.endsWith("head.json") && !r.query.versionId && (stage !== "final_head" || heads === 2);
      if (!failed && matches) { failed = true; throw Object.assign(new Error("REFLECTED_SECRET_URL_TOKEN"), {code: "ECONNRESET"}); }
      return original(r);
    };
    wire.requests.length = 0;
    const proof = await read(e => diagnostics.push(e))(); proof.assertFresh(clock);
    expect(proof.bundle.entries).toHaveLength(1); expect(failed).toBe(true);
    expect(diagnostics).toEqual([
      expect.objectContaining({event: "ERASURE_READ_FAILURE", stage: stage === "final_head" ? "head" : stage, reason: "TRANSPORT", attempt: 1}),
      expect.objectContaining({event: "ERASURE_READ_RECOVERED", attempt: 2}),
    ]);
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toMatch(/REFLECTED|TEST_READ|version-[0-9]|cloud\.ru|head\.json|owner@|bundles\//);
    // The successful retry made its own first AND final signed head reads.
    expect(heads).toBe(stage === "final_head" ? 4 : 3);
  });
  it("discards an exhausted rejected history Promise without forgetting successful history", async () => {
    const original = wire.handler.handle; let fail = true; let lists = 0;
    wire.handler.handle = async r => {
      if (Object.hasOwn(r.query, "versions")) { lists++; if (fail) throw Object.assign(new Error("REFLECTED_SECRET"), {name: "TimeoutError"}); }
      return original(r);
    };
    const current = read(); await expect(current()).rejects.toThrow("ERASURE_LIBRARY_READ_UNAVAILABLE");
    expect(lists).toBe(2); fail = false;
    await expect(current()).resolves.toBeDefined(); expect(lists).toBe(3);
    await current(); expect(lists).toBe(3); // successful history only; current remote always fetched
  });
  it.each(["cold", "warm"])("bounds a persistent %s transport failure to two attempts, never a prior proof", async temperature => {
    const diagnostics: ErasureDiagnostic[] = []; const current = read(e => diagnostics.push(e));
    if (temperature === "warm") await current();
    wire.requests.length = 0; wire.state.unavailable = true;
    await expect(current()).rejects.toThrow("ERASURE_LIBRARY_READ_UNAVAILABLE");
    expect(wire.requests).toHaveLength(2);
    expect(diagnostics.map(e => [e.event, e.reason, e.httpStatus, e.attempt])).toEqual([
      ["ERASURE_READ_FAILURE", "SERVER_5XX", 503, 1], ["ERASURE_READ_FAILURE", "SERVER_5XX", 503, 2],
    ]);
    wire.state.unavailable = false; expect((await current()).bundle.entries).toHaveLength(0);
  });
  it("does not admit a stale mirror when the remote ledger advances between transport attempts", async () => {
    const old = bundle(); const original = wire.handler.handle; let failed = false;
    wire.handler.handle = async r => {
      if (!failed && r.path.includes("/bundles/")) {
        failed = true; await append(); throw Object.assign(new Error("REFLECTED_SECRET"), {code: "ECONNRESET"});
      }
      return original(r);
    };
    const events: ErasureDiagnostic[] = [];
    const current = createCurrentErasureRead({scope: "canary", keys, remote: reader, recipientSha256: config.recipientSha256,
      readBundle: () => old, now: () => clock, diagnostics: e => events.push(e)});
    await expect(current()).rejects.toThrow(/ERASURE_/);
    expect(events.at(-1)).toMatchObject({event: "ERASURE_READ_FAILURE", reason: "VERIFICATION", attempt: 2});
    expect(events.some(e => e.event === "ERASURE_READ_RECOVERED")).toBe(false);
  });
  it("never lets an older overlapping proof lower an already confirmed newer prefix", async () => {
    const context = new AsyncLocalStorage<string>(); const old = bundle(); const oldObjects = new Map(wire.objects);
    let finish!: () => void, started!: () => void; let oldHeadReads = 0;
    const hold = new Promise<void>(r => {finish = r;}); const waiting = new Promise<void>(r => {started = r;});
    const current = createCurrentErasureRead({scope: "canary", keys, recipientSha256: config.recipientSha256,
      now: () => clock, readBundle: () => context.getStore() === "old" ? old : bundle(), remote: {
        headVersions: reader.headVersions,
        read: async (name, id) => {
          if (context.getStore() !== "old") return reader.read(name, id);
          if (name === "head.json" && ++oldHeadReads === 2) {started(); await hold;}
          const bytes = oldObjects.get(name); return bytes ? {bytes, etag: wire.etag(bytes)} : null;
        },
      }});
    await current(); // qualified cold history and prefix0
    const pending = context.run("old", current); const refused = expect(pending).rejects.toThrow(/ERASURE_/);
    await waiting; await append(); expect((await current()).bundle.entries).toHaveLength(1);
    finish(); await refused; expect((await current()).bundle.entries).toHaveLength(1);
  });
  it("does not renew the proof freshness clock on the second attempt", async () => {
    const original = wire.handler.handle; let failed = false; const events: ErasureDiagnostic[] = [];
    wire.handler.handle = async r => {
      if (!failed) { failed = true; clock = new Date(clock.getTime() + 60_001); throw Object.assign(new Error("REFLECTED_SECRET"), {code: "ECONNRESET"}); }
      return original(r);
    };
    await expect(read(e => events.push(e))()).rejects.toThrow(/ERASURE_/);
    expect(events.at(-1)).toMatchObject({event: "ERASURE_READ_FAILURE", stage: "freshness", attempt: 2});
    expect(events.some(e => e.event === "ERASURE_READ_RECOVERED")).toBe(false);
  });
  it("qualifies again after overlapping cold-history failures on the same reader", async () => {
    const original = wire.handler.handle; let fail = true; let lists = 0;
    wire.handler.handle = async r => {
      if (Object.hasOwn(r.query, "versions")) { lists++; if (fail) throw Object.assign(new Error("REFLECTED_SECRET"), {code: "ECONNRESET"}); }
      return original(r);
    };
    const current = read(); const results = await Promise.allSettled(Array.from({length: 6}, () => current()));
    expect(results.every(r => r.status === "rejected")).toBe(true); expect(lists).toBeLessThanOrEqual(2);
    fail = false; await expect(current()).resolves.toBeDefined();
  });
  it("uses a real abort signal with the 10s SDK deadline and no hidden SDK retries", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal); const signals = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {expect(ms).toBe(10_000); return timeout(5);});
    let calls = 0;
    const hanging = createErasureCurrentObjects(config, {handle: async (_request: unknown, options?: {abortSignal?: AbortSignal}) => {
      calls++; await new Promise<void>((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("REFLECTED_SECRET"), {name: "AbortError"})), {once: true}));
      throw new Error("UNREACHABLE");
    }});
    try {
      const events: ErasureDiagnostic[] = [];
      const current = createCurrentErasureRead({scope: "canary", keys, remote: hanging, recipientSha256: config.recipientSha256, readBundle: bundle, now: () => clock, diagnostics: e => events.push(e)});
      await expect(current()).rejects.toThrow(/ERASURE_/);
      expect(calls).toBe(2); expect(signals).toHaveBeenCalledTimes(2);
      expect(events.map(e => [e.stage, e.reason])).toEqual([["head", "TIMEOUT"], ["head", "TIMEOUT"]]);
    } finally {hanging.close();}
  });
  it("bounds a stalled response stream and destroys it on the 10s body deadline", async () => {
    vi.useFakeTimers(); const body = new Readable({read() {}});
    const stalled = createErasureCurrentObjects(config, {handle: async () => ({response: {statusCode: 200, headers: {"content-length": "1", etag: '\"safe-etag\"'}, body}})});
    try {
      const result = stalled.read("head.json");
      const checked = expect(result).rejects.toMatchObject({stage: "head_body", reason: "TIMEOUT"});
      await vi.advanceTimersByTimeAsync(10_001); await checked; expect(body.destroyed).toBe(true);
    } finally {stalled.close();}
  });
  it.each([401, 403, 404, 400])("never retries HTTP %i or leaks reflected provider error fields", async status => {
    let calls = 0; const events: ErasureDiagnostic[] = [];
    const denied = createErasureCurrentObjects(config, {handle: async () => {calls++; return {response: {statusCode: status,
      headers: {}, body: Readable.from(['<Error><Code>Denied</Code><Message>REFLECTED_SECRET</Message></Error>'])}};}});
    try {
      await expect(createCurrentErasureRead({scope: "canary", keys, remote: denied, recipientSha256: config.recipientSha256, readBundle: bundle,
        diagnostics: e => events.push(e)})()).rejects.toThrow(/ERASURE_/);
      expect(calls).toBe(1); expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({httpStatus: status, reason: status === 401 || status === 403 ? "AUTHORIZATION" : "HTTP_4XX"});
      expect(JSON.stringify(events)).not.toContain("REFLECTED_SECRET");
    } finally {denied.close();}
  });
  it.each(["signature", "packet", "versioning"])("never retries a %s verification failure", async kind => {
    const events: ErasureDiagnostic[] = []; const current = read(e => events.push(e));
    if (kind === "signature") {
      const head = JSON.parse(wire.objects.get("head.json")!.toString()); head.signature = "A".repeat(86) + "==";
      wire.objects.set("head.json", Buffer.from(JSON.stringify(head)));
    } else if (kind === "packet") {
      const head = JSON.parse(wire.objects.get("head.json")!.toString()); wire.objects.set(head.body.objectRef, Buffer.from("REFLECTED_SECRET"));
    } else wire.state.enabled = false;
    await expect(current()).rejects.toThrow(/ERASURE_/);
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({event: "ERASURE_READ_FAILURE", reason: "VERIFICATION", attempt: 1});
    expect(wire.requests.filter(r => r.path.endsWith("head.json") && !r.query.versionId)).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("REFLECTED_SECRET");
  });
  it("cannot turn a diagnostic sink failure into permission or hide a reader failure", async () => {
    const sink = () => {throw new Error("DIAGNOSTIC_SECRET");};
    const current = read(sink); wire.state.unavailable = true; await expect(current()).rejects.toThrow(/ERASURE_/);
    wire.state.unavailable = false; await expect(current()).resolves.toBeDefined();
    expect(erasureReadFailure("head", {name: "REFLECTED_SECRET", code: "REFLECTED_SECRET", message: "REFLECTED_SECRET"})).toMatchObject({reason: "UNKNOWN", retryable: false});
  });
  it("tolerates one warm failure, latches an exhausted failure, and recovers only through drained startup on the same SQLite", async () => {
    const merchantPath = join(root, "merchant", "db.sqlite"); let db = new Database(merchantPath); migrateV2(db);
    db.exec(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('user','Owner','owner@example.test',1)`);
    const customerId = bindVerifiedAuthUser(db, {id: "user", email: "owner@example.test", name: "Owner"});
    // Synthetic business data must survive recovery (not a reset or old restore).
    db.exec(`INSERT INTO video_upload_sessions(id,lesson_ref,video_id,status,uploader_endpoint) VALUES
      ('upload-survives','lesson-survives','video-survives','PROCESSING','https://uploader.kinescope.io/synthetic')`);
    const current = read(); const options = {directory: join(root, "fence"), scope: "canary" as const, keys,
      forbiddenRoots: [join(root, "merchant")], readCurrent: current, now: () => clock};
    new ErasureRuntimeFence({...options, initialize: true}).close();
    const keyFile = join(root, "keys.json"); writeFileSync(keyFile, JSON.stringify({version: 1, scope: "canary",
      signing: {"signing-1": keys.signing["signing-1"].export({type: "spki", format: "pem"})},
      subject: {"subject-1": keys.subject["subject-1"].toString("base64")}}), {mode: 0o600});
    const environment = {DEPLOY_ENV: "staging", ERASURE_FENCING_ENABLED: "true", ERASURE_SCOPE: "canary", ERASURE_VERIFICATION_KEYS_FILE: keyFile, ERASURE_FENCE_DIRECTORY: options.directory};
    const installation = installationFixture("REQUIRED", options.directory, "canary", erasureReaderBinding(config)).read();
    const boot = () => prepareErasureRuntime({db, environment, installation, forbiddenRoots: options.forbiddenRoots, libraryRead: current, now: () => clock});
    const gate = await boot(); let closedGate = false;
    try {
      const original = wire.handler.handle; let failOnce = true;
      wire.handler.handle = async r => {
        if (failOnce) {failOnce = false; throw Object.assign(new Error("REFLECTED_SECRET"), {code: "ECONNRESET"});}
        return original(r);
      };
      expect(await gate!.ready()).toBe(true); expect(gate!.status()).toEqual({state: "OPEN", leases: 0, unknown: 0});
      // Three role probes plus ordinary protected requests, with full current checks.
      await Promise.all([gate!.ready(), gate!.ready(), gate!.ready(), gate!.run("REQUEST", async () => undefined)]);
      wire.state.unavailable = true; expect(await gate!.ready()).toBe(false);
      wire.state.unavailable = false; await current();
      expect(await gate!.ready()).toBe(false); // a successful reader is NOT an automatic OPEN
      await expect(gate!.run("REQUEST", async () => {throw Error("MUST_NOT_RUN");})).rejects.toThrow(/BOOT_UNQUALIFIED|CLOSED/);
      ledger.append({requestId: randomUUID(), kind: "ERASURE", subject: erasureSubject(keys, "subject-1", "canary", {
        email: "owner@example.test", userId: "user", customerId,
      })}, clock); await owner.publishPending(clock); // newest independent authority
      gate!.close(); closedGate = true; db.close(); db = new Database(merchantPath); db.pragma("foreign_keys=ON");
      const recovered = await boot(); gates.push(recovered!);
      expect(await recovered!.ready()).toBe(true); expect(recovered!.status()).toEqual({state: "OPEN", leases: 0, unknown: 0});
      expect(db.prepare('SELECT id FROM "user"').all()).toEqual([]);
      expect(db.prepare('SELECT id,status FROM video_upload_sessions').all()).toEqual([{id: "upload-survives", status: "PROCESSING"}]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({n: 27});
      // A fresh post-recovery backup of current data restores independently.
      const backupPath = join(root, "current-recovery.sqlite"); await db.backup(backupPath);
      const cipher = join(root, "current-recovery.sqlite.age"); const readback = join(root, "independent-get.sqlite.age");
      expect(spawnSync("age", ["-r", recipient, "-o", cipher, backupPath]).status).toBe(0);
      copyFileSync(cipher, readback); // isolated byte readback, not a real Cloud.ru GET
      const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(hash(readback)).toBe(hash(cipher));
      const identity = join(root, "owner-recovery-key"); writeFileSync(identity, ageIdentity, {mode: 0o600});
      const recoveredPath = join(root, "independent-current.sqlite");
      expect(spawnSync("age", ["-d", "-i", identity, "-o", recoveredPath, readback]).status).toBe(0);
      expect(hash(recoveredPath)).toBe(hash(backupPath));
      const restored = new Database(recoveredPath, {readonly: true});
      try {expect(restored.prepare("SELECT id,status FROM video_upload_sessions").all()).toEqual([{id: "upload-survives", status: "PROCESSING"}]);
        expect(restored.pragma("integrity_check", {simple: true})).toBe("ok");
        expect(restored.pragma("foreign_key_check")).toEqual([]);
        expect(restored.prepare('SELECT id FROM "user"').all()).toEqual([]);
      } finally {restored.close();}
    } finally {if (!closedGate) gate?.close(); db.close();}
  });
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
