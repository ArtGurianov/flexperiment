import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID, createHash, sign } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ageCustodyEncryption } from "../src/erasure-custody";
import { createCurrentErasureRead, createErasureCurrentObjects, erasureReaderBinding } from "../src/erasure-library-read";
import { applyIsolatedRestoreErasure } from "../src/erasure-restore";
import { readErasureVerificationKeys } from "../src/erasure-runtime";
import { erasurePseudonym, erasureSubject, readOwnerErasureBundle } from "../src/erasure-ledger";
import { reviewedApprovalBytes, reviewedErasurePlanHash, type ReviewedErasurePlan } from "../src/erasure-plan";
import { backupFoundation } from "../src/foundation-storage";
import { FakeFiscalAdapter, FakeNativeBank } from "./fixtures/native-fake-provider";
import { startTochkaHttpFixture } from "./fixtures/tochka-http";
import { receiveNativeCallback } from "../src/native-payment-callbacks";
import { nativePaymentsFromConfig } from "../src/native-payment-runtime";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { reconcileAutomaticNativeReceipts, reconcilePendingFiscalEvents, type FrozenFiscalEvent } from "../src/fiscal-port";
import { revokeEntitlementForOrderLine } from "../src/entitlements";
import { decideRefund, requestRefund } from "../src/refunds";
import { executeApprovedNativeRefund, reconcilePendingNativeRefunds } from "../src/native-payment-refunds";
import { nativeErasureAdmission, nativeOrderStatus, reconcileNativePaymentWithoutNewCharge, reconcilePendingNativePayments, startNativePayment } from "../src/native-payment-ledger";
import { readOwnerConfiguration, runErasureOwnerOperation, type ErasureOwnerConfiguration } from "../src/erasure-owner";
import { migrateV2 } from "../src/db";
import { createAuthRuntime } from "../src/auth";
import { bindVerifiedAuthUser } from "../src/customers";
import { installationFixture } from "./fixtures/erasure-installation";
import { erasureS3Fixture, type ErasureWireRequest } from "./fixtures/erasure-s3";
import type { ReviewedExecutionBoundary } from "../src/erasure-reviewed-owner";
import { type ErasureInstallationEvidence } from "../src/erasure-installation";

let root: string; let config: ErasureOwnerConfiguration; let wire: ReturnType<typeof erasureS3Fixture>;
let db: Database.Database; let installation: ErasureInstallationEvidence;
let installationOptions: ReturnType<typeof installationFixture>["options"];
let clientNumber = 0;
let reviewedClock: Date | undefined;
const now = () => reviewedClock ?? new Date();
const run = (operation: unknown, configuration: unknown = config) => runErasureOwnerOperation(configuration, operation, {installation, requestHandler: wire.handler, now});
const initialize = async () => {await run({operation: "initialize-fence"}); await run({operation: "initialize-custody"});};
function hasOwnerCancellationTable() {
  const journal = new Database(join(config.ledgerDirectory, "erasure-ledger.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return Boolean(journal.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='erasure_reviewed_cancellations'").get());
  } finally { journal.close(); }
}
beforeEach(() => {
  reviewedClock = undefined;
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
  const installationSetup = installationFixture("REQUIRED", config.fenceDirectory, "canary", erasureReaderBinding({...config.remote, scope: "canary", prefix: "flexperiment/erasure/canary/", recipientSha256: ageCustodyEncryption(recipient).recipientSha256}));
  installation = installationSetup.read();
  installationOptions = installationSetup.options;
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
    await initialize(); expect(hasOwnerCancellationTable()).toBe(false);
    expect(JSON.parse(readFileSync(config.mirrorFile, "utf8"))).toEqual({version: 1, scope: "canary", entries: []});
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
    expect(hasOwnerCancellationTable()).toBe(false);
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
  let fixture: Awaited<ReturnType<typeof startTochkaHttpFixture>> | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });

  async function paidProfile(rejectReceipt?: FrozenFiscalEvent["kind"], profile: "fake" | "tochka" | "historical" = "fake") {
    const cookie = await login();
    const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
    const bank = new FakeNativeBank();
    const keyring = { currentKeyId: "fake", keys: { fake: randomBytes(32) } };
    const fiscal = new FakeFiscalAdapter();
    const original = { provider: bank, keyring, fiscalizationMode: "MERCHANT" as const, mayInitiate: () => true };
    const direct = profile === "tochka" ? fixture : undefined;
    const runtime = fixture && nativePaymentsFromConfig(db, loadCommerceRuntimeConfig({
      DEPLOY_ENV: "test", PAYMENT_MODE: "native", KINESCOPE_DELIVERY_MODE: "protected",
      NATIVE_PROVIDER: "tochka", NATIVE_TOCHKA_FIXTURE_ORIGIN: fixture.origin,
    }), keyring, profile === "historical" ? { historicalFake: { provider: bank, fiscalAdapter: fiscal } } : undefined);
    const purchaseLedger = direct ? { ...runtime!.ledger, mayInitiate: () => true } : original;
    const ledger = profile === "historical" ? runtime!.ledger : purchaseLedger;
    const stamp = now().toISOString();
    db.exec(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('paid-legal','COURSES','test','{}','2026-01-01T00:00:00Z',1);
      INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES
      ('paid','paid-ref','ONLINE_COURSE','PAID','course-paid'),('free','free-ref','ONLINE_COURSE','FREE','course-free');`);
    async function purchase(order: string, status: "PAID" | "EXPIRED") {
      const snapshot = JSON.stringify({ paymentPurpose: "Synthetic course", ...(direct && {
        paymentObligations: [{ fiscal: { taxSystem: "USN_INCOME" } }],
      }) });
      db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
        VALUES (?,?,?,'PAYMENT_PENDING',1200,?,?,'paid-legal')`)
        .run(`order-${order}`, order, customerId, snapshot, createHash("sha256").update(snapshot).digest("hex"));
      db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,fiscal_item_json)
        VALUES (?,?,'paid','paid-ref','Synthetic course',1200,'test',?)`).run(`line-${order}`, `order-${order}`, JSON.stringify({
        name: "Synthetic course", quantity: 1, amountKopecks: 1200, vatCode: "NONE", paymentMethod: "FULL_PAYMENT", paymentObject: "SERVICE",
      }));
      if (direct) direct.faults.loseCreate = status === "PAID";
      await startNativePayment(db, purchaseLedger, order);
      const payment = direct && [...direct.payments.values()].at(-1);
      if (direct && payment) {
        if (status === "PAID") direct.pay(payment);
        else direct.expire(payment);
      } else if (status === "PAID") bank.buyerPays(order);
      else bank.expire(order);
      await reconcilePendingNativePayments(db, purchaseLedger);
      return payment;
    }
    const paid = await purchase("ORDER-TEST", "PAID");
    const submit = fiscal.submit.bind(fiscal);
    fiscal.submit = event => event.kind === rejectReceipt
      ? Promise.resolve({ outcome: "REJECTED", code: "SYNTHETIC_FISCAL_REJECTION" })
      : submit(event);
    const publishFixtureReceipt = (kind: "PAYMENT_RECEIPT" | "REFUND_RECEIPT") => {
      if (!direct || !paid) return;
      const row = db.prepare("SELECT event_ref FROM fiscal_events WHERE kind=?").get(kind) as { event_ref: string };
      direct.receipt(paid, row.event_ref, kind === "REFUND_RECEIPT");
    };
    const reconcileFiscal = async (database: Database.Database) => {
      if (direct) await reconcileAutomaticNativeReceipts(database, ledger);
      else if (profile === "historical") await reconcilePendingFiscalEvents(database, { keyring, adapterForExecutor: runtime!.merchantFiscalAdapterFor });
      else await reconcilePendingFiscalEvents(database, { keyring, adapter: fiscal });
    };
    const settleRefund = (requestPublicId: string) => {
      if (direct && paid) direct.completeRefund(paid);
      else bank.settleRefund(`refund:${requestPublicId}`);
    };
    const financialCounts = () => direct ? [direct.calls.create, direct.calls.refund, direct.calls.returned]
      : [bank.calls.create.length, bank.calls.submitRefund.length, bank.returns];
    const replayPaymentCallback = (database: Database.Database) => direct && paid
      ? receiveNativeCallback(database, ledger, { "content-type": "text/plain" }, Buffer.from(direct.callback(paid))) : undefined;
    publishFixtureReceipt("PAYMENT_RECEIPT");
    if (profile === "historical") await reconcilePendingFiscalEvents(db, { keyring, adapter: fiscal });
    else await reconcileFiscal(db);
    expect(db.prepare("SELECT state FROM fiscal_events").get()).toEqual({
      state: rejectReceipt === "PAYMENT_RECEIPT" ? "REJECTED" : "REGISTERED",
    });

    db.prepare("INSERT INTO free_course_enrollments VALUES (?, 'free', 1, ?)").run(customerId, stamp);
    db.prepare("INSERT INTO course_learning_starts VALUES (?, 'course-free', 'free', 'FREE_ENROLLMENT', ?)").run(customerId, stamp);
    db.prepare("INSERT INTO lesson_resume_positions VALUES (?, 'lesson', 31, 1, ?, ?)").run(customerId, stamp, stamp);
    db.prepare("INSERT INTO lesson_completions VALUES (?, 'lesson', ?)").run(customerId, stamp);
    db.prepare(`INSERT INTO course_playback_state VALUES (?, 'course-paid', 'lesson', 'fixture', 'lesson', 'fixture', 'PLAYING')`).run(customerId);
    db.prepare("INSERT INTO course_access_starts VALUES (?, 'course-paid', 'lesson', ?)").run(customerId, stamp);
    db.prepare(`INSERT INTO marketing_consents(id,customer_id,granted,document_version,document_sha256,recorded_at,source)
      VALUES ('old-marketing',?,1,'test',?,?,'MAGIC_LINK_INITIATION')`).run(customerId, "a".repeat(64), stamp);
    db.prepare(`INSERT INTO account_consents(id,customer_id,kind,document_version,document_sha256,recorded_at,source)
      VALUES ('old-consent',?,'ACCOUNT_TERMS','test',?,?,'MAGIC_LINK_INITIATION')`).run(customerId, "a".repeat(64), stamp);
    const { link, clientIp } = await issueMagicLink();
    const request = requestRefund(db, { customerId, orderPublicId: "ORDER-TEST", idempotencyKey: "profile-refund", reasonCode: "CUSTOMER_REQUEST" }, stamp);
    decideRefund(db, request.requestPublicId, { outcome: "APPROVE", amountKopecks: 1200, policyBasis: "synthetic",
      rationale: "Synthetic full refund", actor: "fixture" }, stamp);
    if (direct) direct.faults.loseRefund = true;
    await executeApprovedNativeRefund(db, ledger, request.requestPublicId);
    expect(nativeOrderStatus(db, "ORDER-TEST")).toMatchObject({ refund: "REFUND_PROCESSING" });
    return { customerId, cookie, link, clientIp, bank, ledger, reconcileFiscal, purchase, settleRefund, financialCounts,
      publishFixtureReceipt, replayPaymentCallback, requestPublicId: request.requestPublicId };
  }

  async function planFor(customerId: string) {
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
      categories: {
        account: { action: "CLOSE", basisRef, until },
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
    const policy = { version: 1, scope: "canary", packageE: plan.packageE, validUntil: retainedUntil,
      operators: { "operator-fixture": { publicKey: operator.publicKey.export({ type: "spki", format: "pem" }), authorizedUntil: retainedUntil } },
      cases: { [plan.requestId]: { customer, identityVerificationRef: plan.identityVerificationRef, latestExecuteAt: until } },
      rules: Object.entries(plan.categories).map(ruleFor),
      holds: [] as Array<{ keyId: string; customer: string }>,
    };
    const setPolicy = () => writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
    setPolicy();
    const dryRun = () => run({ operation: "review-dry-run", customerId, plan }) as Promise<{ planSha256: string }>;
    const approve = async (syntheticHash?: string) => {
      const planSha256 = syntheticHash ?? (await dryRun()).planSha256;
      const unsigned = { operatorId: "operator-fixture", approvedAt: now().toISOString(), planSha256 };
      return { operation: "review-execute", customerId, plan, approval: {
        ...unsigned, signature: sign(null, reviewedApprovalBytes(unsigned), operator.privateKey).toString("base64url"),
      } };
    };
    return { plan, policy, setPolicy, dryRun, approve, ruleFor };
  }

  it.each(["fake", "tochka", "historical"] as const)("closes after settlement and replays an older encrypted snapshot (%s)", async profile => {
    await initialize();
    if (profile !== "fake") fixture = await startTochkaHttpFixture();
    const { customerId, cookie, link, clientIp, ledger, reconcileFiscal, purchase, requestPublicId,
      settleRefund, financialCounts, publishFixtureReceipt, replayPaymentCallback } = await paidProfile(undefined, profile);
    const snapshot = await backupFoundation(db, { environment: "canary", sourceCommit: "e67f982161114560c91de28128baec0a51a2d1b1" }, join(root, "backup"), config.recipient);
    db.exec("INSERT INTO email_suppressions(email_normalized,reason) VALUES ('owner@example.test','TEST_WITHDRAWAL')");
    settleRefund(requestPublicId);
    await reconcilePendingNativeRefunds(db, ledger);
    expect(nativeOrderStatus(db, "ORDER-TEST")).toMatchObject({ refund: "REFUNDED" });
    expect(nativeErasureAdmission(db, customerId).admitted).toBe(false);
    await expect((await planFor(customerId)).dryRun()).rejects.toThrow("ERASURE_OPEN_OBLIGATIONS_HOLD");
    expect(count("user")).toBe(1);
    publishFixtureReceipt("REFUND_RECEIPT");
    await reconcileFiscal(db);
    expect(nativeErasureAdmission(db, customerId).admitted).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM fiscal_events WHERE state='REGISTERED'").get()).toEqual({ n: 2 });
    expect(financialCounts()).toEqual([1, 1, 1]);

    if (profile !== "historical") await purchase("ORDER-LATER", "EXPIRED");
    const orderCount = profile === "historical" ? 1 : 2;
    const before = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
    const finance = ["orders", "order_lines", "native_payments", "native_refunds", "refund_requests", "fiscal_events",
      "course_entitlements", "course_access_starts"].map(table => ({ table, rows: before(table) }));
    const { plan, dryRun, approve } = await planFor(customerId);
    wire.requests.length = 0;
    const priorChanges = db.pragma("data_version", { simple: true });
    expect(await dryRun()).toMatchObject({ state: "DRY_RUN", activeRights: 0, orderCount, openRefunds: 0 });
    expect(wire.requests).toHaveLength(0);
    expect(db.pragma("data_version", { simple: true })).toBe(priorChanges);
    const op = await approve();
    const receipt = await run(op);
    expect(hasOwnerCancellationTable()).toBe(false);
    expect(receipt).toMatchObject({
      state: "ERASURE_APPLIED", sequence: 1, requestId: plan.requestId,
      receipt: { applicationMode: "LIVE", counts: { user: 1, session: 1, verification: 1,
        free_course_enrollments: 1, course_learning_starts: 1, lesson_resume_positions: 1, lesson_completions: 1, course_playback_state: 1, account_consents: 1, marketing_consents: 1 } },
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
    expect(count("lesson_completions") + count("course_playback_state")).toBe(0);
    for (const { table, rows } of finance) expect(before(table)).toEqual(rows);
    expect((await run({ operation: "review-status", requestId: plan.requestId }))).toEqual(receipt);
    wire.requests.length = 0;
    expect(await run(op)).toEqual(receipt);
    expect(wire.requests.every(r => r.method === "GET")).toBe(true);
    expect(() => db.prepare("DELETE FROM reviewed_erasure_receipts").run()).toThrow("ERASURE_RECEIPT_IMMUTABLE");

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
      expect(count("orders", restored)).toBe(1);
      expect(nativeOrderStatus(restored, "ORDER-TEST").refund).toBe("REFUND_PROCESSING");
      await expect(run({ operation: "reconcile" }, { ...config, databasePath: oldPath })).rejects.toThrow("ERASURE_NATIVE_RESTORE_FINANCIAL_HOLD");
      expect(count("lesson_completions", restored)).toBe(1);
      expect(count("course_playback_state", restored)).toBe(1);
      applyIsolatedRestoreErasure(restored, proof, keys, "canary", now());
      const priorReceipt = restored.prepare("SELECT * FROM reviewed_erasure_receipts").get();
      applyIsolatedRestoreErasure(restored, proof, keys, "canary", now());
      expect(restored.prepare("SELECT * FROM reviewed_erasure_receipts").get()).toEqual(priorReceipt);
      for (const table of ["user", "session", "verification", "course_learning_starts", "free_course_enrollments", "lesson_resume_positions",
        "account_consents", "marketing_consents", "lesson_completions", "course_playback_state"]) expect(count(table, restored)).toBe(0);
      expect(restored.prepare("SELECT removed_at FROM email_suppressions").get()).toEqual({ removed_at: null });
      expect(restored.prepare("SELECT application_mode FROM reviewed_erasure_receipts").get()).toEqual({ application_mode: "RESTORE" });
      await reconcileNativePaymentWithoutNewCharge(restored, ledger, "ORDER-TEST");
      await reconcilePendingNativeRefunds(restored, ledger);
      if (profile === "tochka" && fixture) {
        fixture.faults.hideReceipts = true;
        await reconcileFiscal(restored);
        expect(restored.prepare("SELECT state,last_reason FROM fiscal_events WHERE kind='REFUND_RECEIPT'").get())
          .toEqual({ state: "PENDING", last_reason: "RECEIPT_NOT_YET_VISIBLE" });
        expect(nativeErasureAdmission(restored, customerId).admitted).toBe(false);
        const infoReads = fixture.calls.info;
        expect(await replayPaymentCallback(restored)).toEqual({ accepted: true, duplicate: false });
        expect(await replayPaymentCallback(restored)).toEqual({ accepted: true, duplicate: true });
        expect(fixture.calls.info).toBe(infoReads);
        fixture.faults.hideReceipts = false;
      }
      await reconcileFiscal(restored);
      const evidence = () => restored.prepare("SELECT state,provider_receipt_id,evidence_json FROM fiscal_events ORDER BY kind").all();
      expect(restored.prepare("SELECT count(*) AS n FROM fiscal_events WHERE state='REGISTERED'").get()).toEqual({ n: 2 });
      const settled = evidence();
      applyIsolatedRestoreErasure(restored, proof, keys, "canary", now());
      await reconcileFiscal(restored);
      expect(evidence()).toEqual(settled);
      expect(count("reviewed_erasure_receipts", restored)).toBe(1);
      expect(count("user", restored)).toBe(0);
      expect(count("free_course_enrollments", restored)).toBe(0);
      expect(count("lesson_resume_positions", restored)).toBe(0);
      expect(nativeOrderStatus(restored, "ORDER-TEST")).toMatchObject({ refund: "REFUNDED" });
      expect(restored.prepare("SELECT count(*) AS n FROM course_entitlements WHERE revoked_at IS NULL").get()).toEqual({ n: 0 });
      expect(financialCounts()).toEqual([orderCount, 1, 1]);
      if (profile === "historical") expect(fixture?.calls).toMatchObject({ create: 0, info: 0, refund: 0, receipt: 0 });
      expect(count("orders", restored)).toBe(1); // Replay does not reconstruct a missing financial tail.
      await expect(run({ operation: "reconcile" }, { ...config, databasePath: oldPath })).rejects.toThrow("ERASURE_NATIVE_RESTORE_FINANCIAL_HOLD");
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

  function readJournal() {
    const keys = readErasureVerificationKeys(config.keysFile, config.scope);
    return readOwnerErasureBundle({ directory: config.ledgerDirectory, scope: config.scope, keys,
      forbiddenRoots: [config.fenceDirectory, join(root, "merchant"), join(root, "mirror")] });
  }

  it.each(["EXPIRED", "LEGAL_HOLD"] as const)("cancels a never-confirmed plan after rejected PUT and %s", async reason => {
    await initialize();
    await login();
    const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
    const { approve, policy, setPolicy } = await planFor(customerId);
    const op = await approve();
    wire.state.failBefore = "head.json";
    await expect(run(op)).rejects.toThrow("UNCONFIRMED");
    const original = readJournal().entries[0];
    expect(original.body.kind).toBe("REVIEWED_ERASURE");
    expect(hasOwnerCancellationTable()).toBe(false);
    const requestId = op.plan.requestId;
    expect(await run({ operation: "review-attempt", requestId })).toMatchObject({ state: "LOCAL_ATTEMPT", entrySha256: original.hash });
    const originalPut = wire.requests.findLast(request => request.method === "PUT" && request.path.endsWith("/head.json"))!;
    if (reason === "EXPIRED") reviewedClock = new Date(Date.parse(op.plan.executeBy) + 1000);
    else {
      policy.holds.push({ keyId: config.subjectKeyId, customer: original.body.subject.customer });
      setPolicy();
    }
    wire.state.failBefore = "";
    await expect(run(op)).rejects.toThrow(reason === "EXPIRED" ? "ERASURE_PLAN_EXPIRED" : "ERASURE_LEGAL_HOLD");
    const cancel = { operation: "review-cancel-unpublished", requestId, entrySha256: original.hash, reason };
    wire.state.loseAck = "head.json";
    await expect(run(cancel)).rejects.toThrow("UNCONFIRMED");
    expect(readJournal().entries[0].hash).toBe(original.hash);
    expect(hasOwnerCancellationTable()).toBe(true);
    wire.requests.length = 0;
    expect(await run(cancel)).toMatchObject({ state: "CANCELED_UNPUBLISHED", sequence: 1, runtimeAdmission: "PENDING" });
    expect(wire.requests.every(request => request.method === "GET")).toBe(true);
    const canceled = readJournal().entries[0];
    expect(canceled.body).toMatchObject({ kind: "REVIEWED_CANCELLATION", canceled: { entrySha256: original.hash, reason } });
    expect((await wire.handler.handle(originalPut)).response.statusCode).toBe(412);
    expect(await run({ operation: "review-attempt", requestId })).toMatchObject({ state: "LOCAL_CANCELLATION_REF", entrySha256: original.hash });
    const local = new Database(join(config.ledgerDirectory, "erasure-ledger.sqlite"), { readonly: true });
    try {
      const immutable = local.prepare("SELECT entry_json FROM erasure_entries WHERE request_id=?").get(requestId) as { entry_json: string };
      expect(JSON.parse(immutable.entry_json).hash).toBe(original.hash);
    } finally { local.close(); }
    expect(await run({ operation: "review-status", requestId })).toMatchObject({ state: "CANCELED_UNPUBLISHED" });
    await expect(run(op)).rejects.toThrow("ERASURE_REVIEWED_ATTEMPT_CANCELED");
    await run({ operation: "reconcile" });
    expect([count("user"), count("email_suppressions"), count("reviewed_erasure_receipts")]).toEqual([1, 0, 0]);
    // A new case can proceed after separate approval and the hold is removed.
    const fresh = await planFor(customerId);
    expect(await run(await fresh.approve())).toMatchObject({ state: "ERASURE_APPLIED", sequence: 2 });
  });

  it("cannot cancel an already committed head even after an ambiguous response", async () => {
    await initialize();
    await login();
    const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
    const { approve } = await planFor(customerId);
    const op = await approve();
    wire.state.loseAck = "head.json";
    await expect(run(op)).rejects.toThrow("UNCONFIRMED");
    const entry = readJournal().entries[0];
    wire.requests.length = 0;
    await expect(run({ operation: "review-cancel-unpublished", requestId: op.plan.requestId,
      entrySha256: entry.hash, reason: "OWNER_WITHDRAWN" })).rejects.toThrow("ERASURE_");
    expect(wire.requests.every(request => request.method === "GET")).toBe(true);
    expect(await run(op)).toMatchObject({ state: "ERASURE_APPLIED", sequence: 1 });
  });

  it("retains whichever CAS actually won when the original write races the cancellation", async () => {
    await initialize();
    await login();
    const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
    const { approve } = await planFor(customerId);
    const op = await approve();
    wire.state.failBefore = "head.json";
    await expect(run(op)).rejects.toThrow("UNCONFIRMED");
    const entry = readJournal().entries[0];
    const originalPut = wire.requests.findLast(request => request.method === "PUT" && request.path.endsWith("/head.json"))!;
    wire.state.failBefore = "";
    const handle = wire.handler.handle;
    let racedStatus: number | undefined;
    wire.handler.handle = async request => {
      if (racedStatus === undefined && request.method === "PUT" && request.path.endsWith("/head.json")) {
        racedStatus = (await handle(originalPut)).response.statusCode;
      }
      return handle(request);
    };
    const cancel = { operation: "review-cancel-unpublished", requestId: op.plan.requestId,
      entrySha256: entry.hash, reason: "OWNER_WITHDRAWN" };
    await expect(run(cancel)).rejects.toThrow("UNCONFIRMED");
    expect(racedStatus).toBe(200);
    expect(readJournal().entries[0].hash).toBe(entry.hash);
    expect(await run(op)).toMatchObject({ state: "ERASURE_APPLIED", sequence: 1 });
    await expect(run(cancel)).rejects.toThrow("ERASURE_");
  });

  async function killReviewedExecute(operation: unknown, boundary: ReviewedExecutionBoundary) {
    const child = fork("commerce-v2/test/fixtures/erasure-review-process.ts", [], {
      execArgv: ["--import", "tsx"], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("message", async (value: { id: number; request: ErasureWireRequest }) => {
      try {
        const { response } = await wire.handler.handle(value.request);
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
        if (child.connected) child.send({ id: value.id, statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      } catch {
        if (child.connected) child.send({ id: value.id, failed: true });
      }
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
    try {
      child.send({ config, operation, boundary, installationOptions });
      return await exit;
    } finally { clearTimeout(timeout); }
  }

  it.each(["LOCAL_APPEND", "REMOTE_CONFIRMED", "MERCHANT_COMMITTED"] as const)(
    "recovers full review-execute after SIGKILL at %s", async boundary => {
      await initialize();
      await login();
      const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
      const { approve } = await planFor(customerId);
      const op = await approve();
      expect(await killReviewedExecute(op, boundary)).toEqual({ code: null, signal: "SIGKILL" });
      const control = new Database(join(config.fenceDirectory, "erasure-fence.sqlite"), { readonly: true });
      try { expect(control.prepare("SELECT state,owner FROM fence_state").get()).toEqual({ state: "CLOSED", owner: null }); }
      finally { control.close(); }
      expect(readJournal().entries).toHaveLength(1);
      expect(wire.versions.size).toBe(boundary === "LOCAL_APPEND" ? 1 : 2);
      expect(count("reviewed_erasure_receipts")).toBe(boundary === "MERCHANT_COMMITTED" ? 1 : 0);
      const recorded = db.prepare("SELECT recorded_at FROM reviewed_erasure_receipts").get();
      wire.requests.length = 0;
      expect(await run(op)).toMatchObject({ state: "ERASURE_APPLIED", sequence: 1 });
      expect(wire.requests.filter(request => request.method === "PUT")).toHaveLength(boundary === "LOCAL_APPEND" ? 2 : 0);
      expect(count("user")).toBe(0);
      if (recorded) expect(db.prepare("SELECT recorded_at FROM reviewed_erasure_receipts").get()).toEqual(recorded);
    },
  );

  it("refuses active access and in-flight refund, and rejects the experimental closure action", async () => {
    await initialize();
    const { customerId } = await paidProfile();
    const { plan, dryRun } = await planFor(customerId);
    await expect(dryRun()).rejects.toThrow("ERASURE_OPEN_OBLIGATIONS_HOLD");
    await expect(run({ operation: "review-dry-run", customerId, plan: {
      ...plan, continuityRef: "fixture-experimental-route",
      categories: { ...plan.categories, account: { ...plan.categories.account, action: "CLOSE_WITH_CONTINUITY" } },
    } })).rejects.toThrow("ERASURE_OWNER_CONFIGURATION_INVALID");
    expect(count("lesson_completions")).toBe(1);
    expect(count("course_playback_state")).toBe(1);
    expect([count("user"), count("reviewed_erasure_receipts")]).toEqual([1, 0]);
    expect(await run({ operation: "read" })).toMatchObject({ sequence: 0 });
  });

  it.each(["PAYMENT_RECEIPT", "REFUND_RECEIPT"] as const)("keeps closure on HOLD for rejected %s", async kind => {
    await initialize();
    const { customerId, bank, ledger, reconcileFiscal, requestPublicId } = await paidProfile(kind);
    bank.settleRefund(`refund:${requestPublicId}`);
    await reconcilePendingNativeRefunds(db, ledger);
    await reconcileFiscal(db);
    expect(db.prepare("SELECT kind FROM fiscal_events WHERE state='REJECTED'").all()).toEqual([{ kind }]);
    expect(nativeErasureAdmission(db, customerId)).toMatchObject({ admitted: true });
    expect(await run({ operation: "review-inventory", customerId })).toMatchObject({
      activeRights: 0, openRefunds: 0, pendingFinancial: true,
    });
    const { plan, approve, dryRun } = await planFor(customerId);
    await expect(dryRun()).rejects.toThrow("ERASURE_OPEN_OBLIGATIONS_HOLD");
    const keys = readErasureVerificationKeys(config.keysFile, config.scope);
    const subject = erasureSubject(keys, config.subjectKeyId, config.scope, {
      customerId, email: "owner@example.test", userId: "user",
    });
    const op = await approve(reviewedErasurePlanHash(plan, subject));
    wire.requests.length = 0;
    await expect(run(op)).rejects.toThrow("ERASURE_OPEN_OBLIGATIONS_HOLD");
    expect(wire.requests).toHaveLength(0);
    expect(hasOwnerCancellationTable()).toBe(false);
    expect([count("user"), count("reviewed_erasure_receipts")]).toEqual([1, 0]);
    expect(readJournal().entries).toHaveLength(0);
  });

  it("requires reapproval when a right changes without a change in order identities", async () => {
    await initialize();
    const { customerId, bank, ledger, reconcileFiscal, requestPublicId } = await paidProfile();
    bank.settleRefund(`refund:${requestPublicId}`);
    await reconcilePendingNativeRefunds(db, ledger);
    await reconcileFiscal(db);
    const { approve } = await planFor(customerId);
    const op = await approve();
    db.prepare("UPDATE course_entitlements SET revoked_at=NULL,revocation_reason=NULL").run();
    await expect(run(op)).rejects.toThrow("ERASURE_PLAN_OBLIGATIONS_CHANGED");
    expect(await run({ operation: "read" })).toMatchObject({ sequence: 0 });
  });

  it("requires reapproval when a refund is requested after authorization", async () => {
    await initialize();
    const { customerId, bank, ledger, reconcileFiscal, purchase, requestPublicId } = await paidProfile();
    bank.settleRefund(`refund:${requestPublicId}`);
    await reconcilePendingNativeRefunds(db, ledger);
    await reconcileFiscal(db);
    await purchase("RETURN-LATER", "PAID");
    await reconcileFiscal(db);
    revokeEntitlementForOrderLine(db, "line-RETURN-LATER", "FIXTURE_CLOSED", now().toISOString());
    const { approve } = await planFor(customerId);
    const op = await approve();
    requestRefund(db, { customerId, orderPublicId: "RETURN-LATER", idempotencyKey: "new-refund", reasonCode: "CUSTOMER_REQUEST" });
    await expect(run(op)).rejects.toThrow("ERASURE_PLAN_OBLIGATIONS_CHANGED");
    expect(await run({ operation: "read" })).toMatchObject({ sequence: 0 });
  });

  it("fails closed for missing E, forged signatures, changed scope and legal hold", async () => {
    await initialize();
    await login();
    const customerId = (db.prepare("SELECT id FROM customers").get() as { id: string }).id;
    const { approve, plan, policy, setPolicy, ruleFor, dryRun: activeDryRun } = await planFor(customerId);
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
    policy.cases[plan.requestId].identityVerificationRef = "other-case";
    setPolicy();
    await expect(activeDryRun()).rejects.toThrow("ERASURE_CASE_ADMISSION_REQUIRED");
    policy.cases[plan.requestId].identityVerificationRef = plan.identityVerificationRef;
    const key = readErasureVerificationKeys(config.keysFile, config.scope).subject[config.subjectKeyId];
    policy.holds.push({ keyId: config.subjectKeyId, customer: erasurePseudonym({ subject: { [config.subjectKeyId]: key },
      signing: {} }, config.subjectKeyId, config.scope, "customer", customerId) });
    setPolicy();
    await expect(run(op)).rejects.toThrow("ERASURE_LEGAL_HOLD");
    expect(wire.requests).toHaveLength(0);
    expect([count("user"), count("reviewed_erasure_receipts")]).toEqual([1, 0]);
  });
});
