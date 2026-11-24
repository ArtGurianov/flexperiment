import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID, createHash, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ageCustodyEncryption } from "../src/erasure-custody";
import { createCurrentErasureRead, createErasureCurrentObjects, erasureReaderBinding } from "../src/erasure-library-read";
import { applyIsolatedRestoreErasure } from "../src/erasure-restore";
import { readErasureVerificationKeys } from "../src/erasure-runtime";
import { erasurePseudonym } from "../src/erasure-ledger";
import { reviewedApprovalBytes, type ReviewedErasurePlan } from "../src/erasure-plan";
import { backupFoundation } from "../src/foundation-storage";
import { FakeFiscalAdapter, FakeNativeBank } from "./fixtures/native-fake-provider";
import { reconcilePendingFiscalEvents } from "../src/fiscal-port";
import { decideRefund, requestRefund } from "../src/refunds";
import { executeApprovedNativeRefund, reconcilePendingNativeRefunds } from "../src/native-payment-refunds";
import { nativeOrderStatus, reconcileNativePaymentWithoutNewCharge, reconcilePendingNativePayments, startNativePayment } from "../src/native-payment-ledger";
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
  privateFile("backup-identity", generated.stdout);
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
const issueMagicLink = async () => {
  const clientIp = `192.0.2.${++clientNumber}`; // Distinct isolated clients; do not disable real auth rate limiting.
  let link = "";
  const auth = createAuthRuntime({db, environment: JSON.parse(readFileSync(config.authEnvironmentFile!, "utf8")), sendMagicLinkEmail: async message => {link = message.url;}});
  const response = await auth.auth.handler(new Request("https://canary-api.flexperiment.ru/v1/auth/sign-in/magic-link", {
    method: "POST", headers: {"content-type": "application/json", origin: "https://canary-platform.flexperiment.ru", "x-forwarded-for": clientIp},
    body: JSON.stringify({email: "owner@example.test", callbackURL: "https://canary-platform.flexperiment.ru/account", metadata: {storefront: "COURSES"}}),
  })); expect(response.status).toBe(200);
  return { auth, link, clientIp };
};
const login = async () => {
  db.exec(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('user','Owner','owner@example.test',1)`);
  bindVerifiedAuthUser(db, {id: "user", email: "owner@example.test", name: "Owner"});
  const { auth, link, clientIp } = await issueMagicLink();
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

describe("FLEX-131 reviewed closure on synthetic data", () => {
  const count = (table: string, handle = db) => (handle.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
  async function paidProfile() {
    const cookie = await login();
    const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
    const bank = new FakeNativeBank();
    const keyring = { currentKeyId: "fake", keys: { fake: randomBytes(32) } };
    const ledger = { provider: bank, keyring, fiscalizationMode: "MERCHANT" as const, mayInitiate: () => true };
    const fiscal = new FakeFiscalAdapter();
    const stamp = now().toISOString();
    db.exec(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('paid-legal','COURSES','test','{}','2026-01-01T00:00:00Z',1);
      INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES
      ('paid','paid-ref','ONLINE_COURSE','PAID','course-paid'),('free','free-ref','ONLINE_COURSE','FREE','course-free');`);
    const snapshot = JSON.stringify({ paymentPurpose: "Synthetic course" });
    db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
      VALUES ('paid-order','ORDER-TEST',?,'PAYMENT_PENDING',1200,?,?,'paid-legal')`)
      .run(customerId, snapshot, createHash("sha256").update(snapshot).digest("hex"));
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,fiscal_item_json)
      VALUES ('paid-line','paid-order','paid','paid-ref','Synthetic course',1200,'test',?)`).run(JSON.stringify({
      name: "Synthetic course", quantity: 1, amountKopecks: 1200, vatCode: "NONE", paymentMethod: "FULL_PAYMENT", paymentObject: "SERVICE",
    }));
    await startNativePayment(db, ledger, "ORDER-TEST");
    bank.buyerPays("ORDER-TEST");
    await reconcilePendingNativePayments(db, ledger);
    const reconcileFiscal = (database: Database.Database) => reconcilePendingFiscalEvents(database, { keyring, adapter: fiscal });
    await reconcileFiscal(db);
    expect(db.prepare("SELECT state FROM fiscal_events").get()).toEqual({ state: "REGISTERED" });

    db.prepare("INSERT INTO free_course_enrollments VALUES (?, 'free', 1, ?)").run(customerId, stamp);
    db.prepare("INSERT INTO course_learning_starts VALUES (?, 'course-free', 'free', 'FREE_ENROLLMENT', ?)").run(customerId, stamp);
    db.prepare("INSERT INTO lesson_resume_positions VALUES (?, 'lesson', 31, 1, ?, ?)").run(customerId, stamp, stamp);
    db.prepare("INSERT INTO course_access_starts VALUES (?, 'course-paid', 'lesson', ?)").run(customerId, stamp);
    db.prepare(`INSERT INTO marketing_consents(id,customer_id,granted,document_version,document_sha256,recorded_at,source)
      VALUES ('old-marketing',?,1,'test',?,?,'MAGIC_LINK_INITIATION')`).run(customerId, "a".repeat(64), stamp);
    db.prepare(`INSERT INTO account_consents(id,customer_id,kind,document_version,document_sha256,recorded_at,source)
      VALUES ('old-consent',?,'ACCOUNT_TERMS','test',?,?,'MAGIC_LINK_INITIATION')`).run(customerId, "a".repeat(64), stamp);
    const { link, clientIp } = await issueMagicLink();
    const request = requestRefund(db, { customerId, orderPublicId: "ORDER-TEST", idempotencyKey: "profile-refund", reasonCode: "CUSTOMER_REQUEST" }, stamp);
    decideRefund(db, request.requestPublicId, { outcome: "APPROVE", amountKopecks: 1200, policyBasis: "synthetic",
      rationale: "Synthetic full refund", actor: "fixture" }, stamp);
    await executeApprovedNativeRefund(db, ledger, request.requestPublicId);
    expect(nativeOrderStatus(db, "ORDER-TEST")).toMatchObject({ refund: "REFUND_PROCESSING" });
    return { customerId, cookie, link, clientIp, bank, ledger, reconcileFiscal, requestPublicId: request.requestPublicId };
  }

  async function planFor(customerId: string, active = false) {
    const operator = generateKeyPairSync("ed25519");
    const policyFile = join(root, "custody", "reviewed-policy.json");
    config.reviewedPolicyFile = policyFile;
    const until = new Date(now().getTime() + 86_400_000).toISOString();
    const retainedUntil = new Date(now().getTime() + 2 * 86_400_000).toISOString();
    const retention = { action: "RETAIN", basisRef: "fixture-retention", until: retainedUntil } as const;
    const basisRef = "fixture-delete";
    const inventory = await run({ operation: "review-inventory", customerId }) as { obligationsSha256: string };
    const plan: ReviewedErasurePlan = {
      version: 1, scope: "canary", requestId: randomUUID(), packageE: { commit: "1".repeat(40), sha256: "2".repeat(64) },
      identityVerificationRef: "fixture-verified", executeBy: until, obligationsSha256: inventory.obligationsSha256,
      ...(active ? { continuityRef: "fixture-agreed-continuity" } : {}),
      categories: {
        account: { action: active ? "CLOSE_WITH_CONTINUITY" : "CLOSE", basisRef, until },
        credentials: { action: "REVOKE", basisRef, until },
        consents: { action: "DELETE", basisRef, until },
        marketing: { action: "SUPPRESS_AND_DELETE", basisRef, until },
        freeLearning: { action: "DELETE", basisRef, until },
        progress: { action: "DELETE", basisRef, until },
        customerContact: retention, financeAndFiscal: retention, paidRightsAndPerformance: retention, legalAndAuditEvidence: retention,
      },
    };
    const keys = readErasureVerificationKeys(config.keysFile, config.scope);
    const customer = erasurePseudonym(keys, config.subjectKeyId, config.scope, "customer", customerId);
    const ruleFor = ([category, step]: [string, { action: string; basisRef: string; until: string }]) =>
      ({ category, basisRef: step.basisRef, action: step.action, earliestUntil: step.until, latestUntil: step.until });
    const policy = { version: 1, scope: "canary", packageE: plan.packageE, validUntil: until,
      operators: { "operator-fixture": { publicKey: operator.publicKey.export({ type: "spki", format: "pem" }), authorizedUntil: until } },
      cases: { [plan.requestId]: { customer, identityVerificationRef: plan.identityVerificationRef,
        continuityRef: plan.continuityRef, latestExecuteAt: until } },
      rules: Object.entries(plan.categories).map(ruleFor),
      holds: [] as Array<{ keyId: string; customer: string }>,
    };
    const setPolicy = () => writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
    setPolicy();
    const dryRun = () => run({ operation: "review-dry-run", customerId, plan }) as Promise<{ planSha256: string }>;
    const approve = async () => {
      const { planSha256 } = await dryRun();
      const unsigned = { operatorId: "operator-fixture", approvedAt: now().toISOString(), planSha256 };
      return { operation: "review-execute", customerId, plan, approval: {
        ...unsigned, signature: sign(null, reviewedApprovalBytes(unsigned), operator.privateKey).toString("base64url"),
      } };
    };
    return { plan, policy, setPolicy, dryRun, approve, ruleFor };
  }

  it("closes the account, preserves the pending full refund and replays an encrypted pre-erasure snapshot", async () => {
    await initialize();
    const { customerId, cookie, link, clientIp, bank, ledger, reconcileFiscal, requestPublicId } = await paidProfile();
    const snapshot = await backupFoundation(db, { environment: "canary", sourceCommit: "e67f982161114560c91de28128baec0a51a2d1b1" }, join(root, "backup"), config.recipient);
    db.exec("INSERT INTO email_suppressions(email_normalized,reason) VALUES ('owner@example.test','TEST_WITHDRAWAL')");
    const before = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
    const finance = ["orders", "order_lines", "native_payments", "native_refunds", "refund_requests", "fiscal_events",
      "course_entitlements", "course_access_starts"].map(table => ({ table, rows: before(table) }));
    const { plan, dryRun, approve } = await planFor(customerId, true);
    wire.requests.length = 0;
    const priorChanges = db.pragma("data_version", { simple: true });
    expect(await dryRun()).toMatchObject({ state: "DRY_RUN", activeRights: 1, orderCount: 1, openRefunds: 1 });
    expect(wire.requests).toHaveLength(0);
    expect(db.pragma("data_version", { simple: true })).toBe(priorChanges);
    const op = await approve();
    const receipt = await run(op);
    expect(receipt).toMatchObject({
      state: "ERASURE_APPLIED", sequence: 1, requestId: plan.requestId,
      receipt: { applicationMode: "LIVE", counts: { user: 1, session: 1, verification: 1,
        free_course_enrollments: 1, course_learning_starts: 1, lesson_resume_positions: 1, account_consents: 1, marketing_consents: 1 } },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/owner@example|session_token|synthetic-link|TEST_READ|cookie/i);
    expect(db.prepare("SELECT auth_user_id, display_name FROM customers WHERE id=?").get(customerId)).toEqual({ auth_user_id: null, display_name: null });
    expect(db.prepare("SELECT reason,removed_at FROM email_suppressions").get()).toEqual({ reason: "TEST_WITHDRAWAL", removed_at: null });
    const auth = createAuthRuntime({ db, environment: JSON.parse(readFileSync(config.authEnvironmentFile!, "utf8")), sendMagicLinkEmail: async () => { throw new Error("unexpected send"); } });
    expect(Boolean(await auth.auth.api.getSession({ headers: new Headers({ cookie }) }))).toBe(false);
    const oldLinkResponse = await auth.auth.handler(new Request(link, { headers: {
      origin: "https://canary-platform.flexperiment.ru", "x-forwarded-for": clientIp,
    } }));
    expect([302, 400, 401]).toContain(oldLinkResponse.status);
    expect(oldLinkResponse.headers.getSetCookie().length).toBe(0);
    expect(count("user")).toBe(0);
    for (const { table, rows } of finance) expect(before(table)).toEqual(rows);
    expect((await run({ operation: "review-status", requestId: plan.requestId }))).toEqual(receipt);
    wire.requests.length = 0;
    expect(await run(op)).toEqual(receipt);
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
    expect(() => db.prepare("DELETE FROM reviewed_erasure_receipts").run()).toThrow("ERASURE_RECEIPT_IMMUTABLE");

    bank.settleRefund(`refund:${requestPublicId}`);
    await reconcilePendingNativeRefunds(db, ledger);
    await reconcileFiscal(db);
    expect(nativeOrderStatus(db, "ORDER-TEST")).toMatchObject({ refund: "REFUNDED" });
    expect(db.prepare("SELECT count(*) AS n FROM fiscal_events WHERE state='REGISTERED'").get()).toEqual({ n: 2 });
    expect(bank.returns).toBe(1);

    const oldPath = join(root, "backup", "restore.sqlite");
    expect(spawnSync("age", ["-d", "-i", join(root, "custody", "backup-identity"), "-o", oldPath, join(root, "backup", snapshot.filename)]).status).toBe(0);
    const restored = new Database(oldPath, { fileMustExist: true });
    const { endpoint, region, bucket, expectedBucketOwner } = config.remote;
    const readerConfig = { version: 1 as const, endpoint, region, bucket, expectedBucketOwner, scope: config.scope, prefix: "flexperiment/erasure/canary/",
      bundleFile: config.mirrorFile, recipientSha256: ageCustodyEncryption(config.recipient).recipientSha256,
      accessKeyId: "TEST_READ_ID", secretAccessKey: "TEST_READ_SECRET" };
    const remote = createErasureCurrentObjects(readerConfig, wire.handler);
    try {
      restored.pragma("foreign_keys=ON");
      expect([count("user", restored), count("free_course_enrollments", restored), count("email_suppressions", restored)])
        .toEqual([1, 1, 0]);
      const keys = readErasureVerificationKeys(config.keysFile, config.scope);
      const readCurrent = createCurrentErasureRead({ scope: config.scope, keys, remote, recipientSha256: readerConfig.recipientSha256,
        readBundle: () => JSON.parse(readFileSync(config.mirrorFile, "utf8")), now });
      const proof = await readCurrent();
      applyIsolatedRestoreErasure(restored, proof, keys, "canary", now());
      for (const table of ["user", "session", "verification", "course_learning_starts", "free_course_enrollments", "lesson_resume_positions",
        "account_consents", "marketing_consents"]) expect(count(table, restored)).toBe(0);
      expect(restored.prepare("SELECT removed_at FROM email_suppressions").get()).toEqual({ removed_at: null });
      expect(restored.prepare("SELECT application_mode FROM reviewed_erasure_receipts").get()).toEqual({ application_mode: "RESTORE" });
      await reconcileNativePaymentWithoutNewCharge(restored, ledger, "ORDER-TEST");
      await reconcilePendingNativeRefunds(restored, ledger);
      await reconcileFiscal(restored);
      expect(nativeOrderStatus(restored, "ORDER-TEST")).toMatchObject({ refund: "REFUNDED" });
      expect(restored.prepare("SELECT count(*) AS n FROM course_entitlements WHERE revoked_at IS NULL").get()).toEqual({ n: 0 });
      expect([bank.calls.create.length, bank.calls.submitRefund.length, bank.returns]).toEqual([1, 1, 1]);
    } finally { remote.close(); restored.close(); }
  });

  it.each(["lost-ack", "write-rejected"])("recovers the same plan after %s from custody", async failure => {
    await initialize();
    await login();
    const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
    const { approve } = await planFor(customerId);
    const op = await approve();
    if (failure === "lost-ack") wire.state.loseAck = "head.json";
    else wire.state.failBefore = "head.json";
    await expect(run(op)).rejects.toThrow("UNCONFIRMED");
    expect(count("user")).toBe(1);
    expect(count("reviewed_erasure_receipts")).toBe(0);
    wire.state.failBefore = "";
    if (failure === "write-rejected") await expect(run({ operation: "publish-pending" })).rejects.toThrow("ERASURE_REVIEWED_RESUME_REQUIRED");
    wire.requests.length = 0;
    expect(await run(op)).toMatchObject({ state: "ERASURE_APPLIED", sequence: 1 });
    expect(count("user")).toBe(0);
    expect(wire.requests.filter(r => r.method === "PUT")).toHaveLength(failure === "lost-ack" ? 0 : 1);
    await expect(run({ ...op, plan: { ...op.plan, identityVerificationRef: "changed" } })).rejects.toThrow("ERASURE_REQUEST_CONFLICT");
  });

  it("recovers a SIGKILL under the reviewed drain with the committed custody head intact", async () => {
    await initialize();
    await login();
    const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
    const { approve } = await planFor(customerId);
    const op = await approve();
    // Commit the custody head and lose the response before merchant apply.
    wire.state.loseAck = "head.json";
    await expect(run(op)).rejects.toThrow("UNCONFIRMED");
    const script = `
      const Database = require("better-sqlite3");
      const { ErasureRuntimeFence } = require("./commerce-v2/src/erasure-fence");
      const { readErasureVerificationKeys } = require("./commerce-v2/src/erasure-runtime");
      const c = JSON.parse(process.argv[1]);
      const db = new Database(c.databasePath);
      const fence = new ErasureRuntimeFence({ directory: c.fenceDirectory, scope: c.scope,
        keys: readErasureVerificationKeys(c.keysFile, c.scope), forbiddenRoots: [c.ledgerDirectory],
        readCurrent: async () => { throw new Error("unexpected read"); } });
      void fence.withReviewedDrain(db, async () => { process.kill(process.pid, "SIGKILL"); });
    `;
    const halted = spawnSync(process.execPath, ["--import", "tsx", "-e", script, JSON.stringify({
      scope: config.scope, databasePath: config.databasePath, fenceDirectory: config.fenceDirectory,
      keysFile: config.keysFile, ledgerDirectory: config.ledgerDirectory,
    })], { encoding: "utf8", timeout: 15_000 });
    expect(halted.signal).toBe("SIGKILL");
    const control = new Database(join(config.fenceDirectory, "erasure-fence.sqlite"), { readonly: true });
    try { expect(control.prepare("SELECT state,owner FROM fence_state").get()).toEqual({ state: "CLOSED", owner: null }); }
    finally { control.close(); }
    expect(count("user")).toBe(1);
    wire.requests.length = 0;
    expect(await run(op)).toMatchObject({ state: "ERASURE_APPLIED", sequence: 1 });
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
  });

  it("fails closed for missing E, forged signatures, changed scope, active rights without continuity and legal hold", async () => {
    await initialize();
    const { customerId } = await paidProfile();
    const { dryRun } = await planFor(customerId);
    await expect(dryRun()).rejects.toThrow("ERASURE_ACCESS_CONTINUITY_REQUIRED");
    const { approve, plan, policy, setPolicy, ruleFor, dryRun: activeDryRun } = await planFor(customerId, true);
    const op = await approve();
    wire.requests.length = 0;
    await expect(run({ ...op, approval: { ...op.approval, signature: "a".repeat(86) } })).rejects.toThrow("ERASURE_OPERATOR_APPROVAL_INVALID");
    await expect(run({ ...op, plan: { ...op.plan, scope: "production" } })).rejects.toThrow("ERASURE_SCOPE_MISMATCH");
    await expect(run(op, { ...config, reviewedPolicyFile: undefined })).rejects.toThrow("ERASURE_AWAITING_E_POLICY");
    policy.rules = policy.rules.filter(rule => rule.category !== "progress");
    setPolicy();
    await expect(activeDryRun()).rejects.toThrow("ERASURE_PLAN_CATEGORY_NOT_AUTHORIZED");
    policy.rules.push(ruleFor(["progress", plan.categories.progress]));
    policy.cases[plan.requestId].latestExecuteAt = now().toISOString();
    setPolicy();
    await expect(activeDryRun()).rejects.toThrow("ERASURE_PLAN_PERIOD_INVALID");
    policy.cases[plan.requestId].latestExecuteAt = plan.executeBy;
    policy.cases[plan.requestId].continuityRef = "other-case";
    setPolicy();
    await expect(activeDryRun()).rejects.toThrow("ERASURE_CASE_ADMISSION_REQUIRED");
    policy.cases[plan.requestId].continuityRef = plan.continuityRef;
    const key = readErasureVerificationKeys(config.keysFile, config.scope).subject[config.subjectKeyId];
    policy.holds.push({ keyId: config.subjectKeyId, customer: erasurePseudonym({ subject: { [config.subjectKeyId]: key },
      signing: {} }, config.subjectKeyId, config.scope, "customer", customerId) });
    setPolicy();
    await expect(run(op)).rejects.toThrow("ERASURE_LEGAL_HOLD");
    expect(wire.requests).toHaveLength(0);
    expect([count("user"), count("reviewed_erasure_receipts")]).toEqual([1, 0]);
  });
});
