import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ageCustodyEncryption } from "../src/erasure-custody";
import { erasureReaderBinding } from "../src/erasure-library-read";
import { readOwnerConfiguration, runErasureOwnerOperation, type ErasureOwnerConfiguration } from "../src/erasure-owner";
import { migrateV2 } from "../src/db";
import { createAuthRuntime } from "../src/auth";
import { bindVerifiedAuthUser } from "../src/customers";
import { installationFixture } from "./fixtures/erasure-installation";
import { erasureS3Fixture } from "./fixtures/erasure-s3";
import { type ErasureInstallationEvidence } from "../src/erasure-installation";

let root: string; let config: ErasureOwnerConfiguration; let wire: ReturnType<typeof erasureS3Fixture>;
let db: Database.Database; let installation: ErasureInstallationEvidence;
let clientNumber = 0;
const now = () => new Date();
const run = (operation: unknown, configuration: unknown = config) => runErasureOwnerOperation(configuration, operation, {installation, requestHandler: wire.handler, now});
const initialize = async () => {await run({operation: "initialize-fence"}); await run({operation: "initialize-custody"});};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flex-erasure-owner-"));
  for (const dir of ["merchant", "ledger", "fence", "mirror", "custody"]) mkdirSync(join(root, dir), {mode: 0o700});
  const privateFile = (name: string, value: string) => {const path = join(root, "custody", name); writeFileSync(path, value, {mode: 0o600}); return path;};
  const pair = generateKeyPairSync("ed25519");
  const generated = spawnSync("age-keygen", [], {encoding: "utf8"}); expect(generated.status).toBe(0);
  const recipient = generated.stderr.match(/age1[0-9a-z]{58}/)![0];
  const keysFile = privateFile("verification.json", JSON.stringify({version: 1, scope: "canary", signing: {"signing-1": pair.publicKey.export({type: "spki", format: "pem"})}, subject: {"subject-1": randomBytes(32).toString("base64")}}));
  config = {version: 1, scope: "canary", databasePath: join(root, "merchant", "db.sqlite"), ledgerDirectory: join(root, "ledger"), fenceDirectory: join(root, "fence"),
    mirrorFile: join(root, "mirror", "bundle.json"), keysFile, signer: {keyId: "signing-1", privateKeyFile: privateFile("signer.pem", pair.privateKey.export({type: "pkcs8", format: "pem"}).toString())},
    subjectKeyId: "subject-1", recipient, remote: {endpoint: "https://s3.cloud.ru", region: "ru-central-1", bucket: "erasure-canary", expectedBucketOwner: "qualification-owner",
      readAccessKeyFile: privateFile("read-id", "TEST_READ_ID"), readSecretKeyFile: privateFile("read-secret", "TEST_READ_SECRET"),
      writeAccessKeyFile: privateFile("write-id", "TEST_WRITE_ID"), writeSecretKeyFile: privateFile("write-secret", "TEST_WRITE_SECRET")},
    authEnvironmentFile: privateFile("auth.json", JSON.stringify({NODE_ENV: "production", DEPLOY_ENV: "staging", BETTER_AUTH_SECRET: "synthetic-secret-long-enough-for-auth-tests", AUTH_EMAIL_OUTBOX_KEY: randomBytes(32).toString("base64"),
      API_ORIGIN: "https://canary-api.flexperiment.ru", PLATFORM_ORIGIN: "https://canary-platform.flexperiment.ru", LAB_ORIGIN: "https://canary-lab.flexperiment.ru", ADMIN_ORIGIN: "https://canary-admin.flexperiment.ru"})),
  };
  installation = installationFixture("REQUIRED", config.fenceDirectory, "canary", erasureReaderBinding({...config.remote, scope: "canary", prefix: "flexperiment/erasure/canary/", recipientSha256: ageCustodyEncryption(recipient).recipientSha256})).read();
  db = new Database(config.databasePath); db.pragma("foreign_keys=ON"); migrateV2(db); wire = erasureS3Fixture();
});
afterEach(() => {db.close(); rmSync(root, {recursive: true, force: true});});
const login = async () => {
  const clientIp = `192.0.2.${++clientNumber}`; // Distinct isolated clients; do not disable real auth rate limiting.
  db.exec(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('user','Owner','owner@example.test',1)`);
  bindVerifiedAuthUser(db, {id: "user", email: "owner@example.test", name: "Owner"});
  let link = "";
  const auth = createAuthRuntime({db, environment: JSON.parse(readFileSync(config.authEnvironmentFile!, "utf8")), sendMagicLinkEmail: async message => {link = message.url;}});
  const response = await auth.auth.handler(new Request("https://canary-api.flexperiment.ru/v1/auth/sign-in/magic-link", {
    method: "POST", headers: {"content-type": "application/json", origin: "https://canary-platform.flexperiment.ru", "x-forwarded-for": clientIp},
    body: JSON.stringify({email: "owner@example.test", callbackURL: "https://canary-platform.flexperiment.ru/account", metadata: {storefront: "COURSES"}}),
  })); expect(response.status).toBe(200);
  const verification = await auth.auth.handler(new Request(link, {headers: {origin: "https://canary-platform.flexperiment.ru", "x-forwarded-for": clientIp}})); expect([200, 302]).toContain(verification.status);
  return verification.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
};
describe("owner-only one-shot operations with isolated real SDK/SQLite/auth, no live credentials", () => {
  it("inspect is nonmutating, not an initialization or remote admission", async () => {
    const result = await run({operation: "inspect"}); expect(result).toMatchObject({policy: "REQUIRED", fencePresent: false, ledgerPresent: false});
    expect(wire.requests).toHaveLength(0); expect(existsSync(join(config.fenceDirectory, "erasure-fence.sqlite"))).toBe(false);
  });
  it("the actual CLI bounds/redacts invalid stdin and does not initialize a missing installation", () => {
    const file = join(root, "owner.json"); writeFileSync(file, JSON.stringify(config), {mode: 0o600});
    for (const input of ['{"operation":"admit","cookie":"REFLECTED_SECRET"}', "REFLECTED_SECRET".repeat(5000)]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "commerce-v2/src/erasure-owner-cli.ts", "--config", file], {input, encoding: "utf8", timeout: 15_000});
      expect(child.status).toBe(1); expect(child.stdout).toBe(""); expect(child.stderr.trim()).toMatch(/^ERASURE_[A-Z_]+$/);
      expect(child.stderr).not.toMatch(/REFLECTED_SECRET|TEST_READ|TEST_WRITE/); expect(existsSync(join(config.fenceDirectory, "erasure-fence.sqlite"))).toBe(false);
    }
  });
  it("initializes once explicitly and publishes only the EXISTING encrypted bundle format", async () => {
    await initialize(); expect(JSON.parse(readFileSync(config.mirrorFile, "utf8"))).toEqual({version: 1, scope: "canary", entries: []});
    expect((await run({operation: "inspect"}))).toMatchObject({fencePresent: true, ledgerPresent: true, mirrorPresent: true});
    await expect(run({operation: "initialize-fence"})).rejects.toThrow("ALREADY_INITIALIZED");
    await expect(run({operation: "initialize-custody"})).rejects.toThrow("ALREADY_INITIALIZED");
  });
  it("read uses no signer/private write credential and performs GET only", async () => {
    await initialize(); rmSync(config.signer.privateKeyFile); rmSync(config.remote.writeSecretKeyFile); wire.requests.length = 0;
    expect(await run({operation: "read"})).toMatchObject({state: "REMOTE_VERIFIED", sequence: 0});
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
  });
  it.each(["head.json", "packet"])("resumes explicit initialization after committed %s lost ACK, without overwriting", async location => {
    await run({operation: "initialize-fence"});
    if (location === "head.json") wire.state.loseAck = "head.json";
    else {
      const original = wire.handler.handle; let first = true;
      wire.handler.handle = async r => {const response = await original(r); if (first && r.method === "PUT") {first = false; throw new Error("REFLECTED_SECRET");} return response;};
    }
    await expect(run({operation: "initialize-custody"})).rejects.toThrow("UNCONFIRMED");
    const oldPacket = [...wire.objects.entries()].find(([key]) => key.startsWith("bundles/"))!; wire.requests.length = 0;
    expect(await run({operation: "resume-initialization"})).toMatchObject({state: "CLOSED", remote: "CONFIRMED"});
    expect(wire.objects.get(oldPacket[0])).toEqual(oldPacket[1]);
    expect(wire.requests.filter(r => r.method === "PUT")).toHaveLength(location === "head.json" ? 0 : 1);
  });
  it("admits only a genuine Better Auth session, exports AFTER ACK, purges and returns safe output", async () => {
    await initialize(); const cookie = await login();
    const result = await run({operation: "admit", requestId: randomUUID(), headers: {origin: "https://canary-platform.flexperiment.ru", cookie}});
    expect(result).toMatchObject({state: "ERASURE_APPLIED", sequence: 1, processorDeletion: "PENDING", archiveDisposition: "PENDING"});
    expect(db.prepare('SELECT id FROM "user"').all()).toEqual([]); expect(db.prepare('SELECT id FROM "session"').all()).toEqual([]);
    expect(JSON.parse(readFileSync(config.mirrorFile, "utf8")).entries).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/owner@example|session_token|TEST_|cookie/i);
    wire.requests.length = 0; expect(await run({operation: "reconcile"})).toMatchObject({state: "ERASURE_APPLIED"});
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
  });
  it.each(["cookie", "origin", "raw-email"])("refuses unverified %s without a remote append or account erasure", async mode => {
    await initialize(); const cookie = await login(); wire.requests.length = 0;
    const input = {operation: "admit", requestId: randomUUID(), headers: {origin: mode === "origin" ? "https://foreign.test" : "https://canary-platform.flexperiment.ru", cookie: mode === "cookie" ? "invalid" : cookie},
      ...(mode === "raw-email" ? {email: "owner@example.test"} : {})};
    await expect(run(input)).rejects.toThrow(/ERASURE_/);
    expect(db.prepare('SELECT id FROM "user"').all()).toEqual([{id: "user"}]); expect(wire.requests.every(r => r.method === "GET")).toBe(true);
    expect(JSON.parse(readFileSync(config.mirrorFile, "utf8")).entries).toHaveLength(0);
  });
  it("keeps CLOSED on failed mirror export after remote commit; reconciles GET-only without re-admission", async () => {
    await initialize(); const cookie = await login(); chmodSync(config.mirrorFile, 0o644);
    await expect(run({operation: "admit", requestId: randomUUID(), headers: {origin: "https://canary-platform.flexperiment.ru", cookie}})).rejects.toThrow(/ERASURE_/);
    expect(db.prepare('SELECT id FROM "user"').all()).toEqual([{id: "user"}]);
    const fence = new Database(join(config.fenceDirectory, "erasure-fence.sqlite"), {readonly: true});
    try {expect(fence.prepare("SELECT state FROM fence_state").get()).toEqual({state: "CLOSED"});} finally {fence.close();}
    chmodSync(config.mirrorFile, 0o600); wire.requests.length = 0;
    await run({operation: "reconcile"}); expect(db.prepare('SELECT id FROM "user"').all()).toEqual([]);
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
  });
  it("recovers the exact signed journal after local loss using retained keys and current custody, GET only", async () => {
    await initialize(); const cookie = await login();
    await run({operation: "admit", requestId: randomUUID(), headers: {origin: "https://canary-platform.flexperiment.ru", cookie}});
    const original = readFileSync(config.mirrorFile); rmSync(join(config.ledgerDirectory, "erasure-ledger.sqlite")); wire.requests.length = 0;
    expect(await run({operation: "recover-ledger"})).toMatchObject({state: "CLOSED", runtimeAdmission: "PENDING"});
    expect(await run({operation: "read"})).toMatchObject({sequence: 1}); expect(readFileSync(config.mirrorFile)).toEqual(original);
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
    await expect(run({operation: "recover-ledger"})).rejects.toThrow("ALREADY_INITIALIZED");
  });
  it("never recreates a missing journal from stale offline data when remote state is unavailable", async () => {
    await initialize(); rmSync(join(config.ledgerDirectory, "erasure-ledger.sqlite")); wire.state.unavailable = true;
    await expect(run({operation: "recover-ledger"})).rejects.toThrow(/ERASURE_/);
    expect(existsSync(join(config.ledgerDirectory, "erasure-ledger.sqlite"))).toBe(false);
  });
  it("leaves UNKNOWN sends and crash-owner claims CLOSED rather than clearing leases by TTL", async () => {
    await initialize();
    const control = new Database(join(config.fenceDirectory, "erasure-fence.sqlite"));
    try {control.prepare("UPDATE fence_state SET owner=? WHERE id=1").run(randomUUID());} finally {control.close();}
    wire.requests.length = 0;
    await expect(run({operation: "reconcile"})).rejects.toThrow("OWNER_RECONCILIATION_REQUIRED");
    expect(wire.requests).toHaveLength(0);
  });
  it("refuses changed namespace, production scope and unprotected config before remote requests", async () => {
    await expect(run({operation: "read"}, {...config, remote: {...config.remote, bucket: "old-bucket"}})).rejects.toThrow("READ_BINDING_MISMATCH");
    await expect(run({operation: "read"}, {...config, scope: "production"})).rejects.toThrow("CONFIGURATION_INVALID");
    const file = join(root, "owner.json"); writeFileSync(file, JSON.stringify(config), {mode: 0o600}); expect(readOwnerConfiguration(file)).toEqual(config);
    chmodSync(file, 0o644); expect(() => readOwnerConfiguration(file)).toThrow("CONFIGURATION_INVALID"); expect(wire.requests).toHaveLength(0);
  });
});
