import Database from "better-sqlite3";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV2 } from "../src/db";
import { checkout, confirmCheckout, MockPaymentRail, prepareCheckout } from "../src/checkout";
import { stageALegalManifestJson, stageBLegalManifestJson } from "./fixtures/legal";
import { openTestStorefront, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";
import { grantManualEntitlement, customerCanAccessCourse } from "../src/entitlements";
import { decideRefund, executeApprovedRefund, requestRefund } from "../src/refunds";
import { saveEditorialDraft } from "../src/course-editorial";
import { ErasureLedgerStore, VerifiedErasureLedger, erasureSubject, issueErasureCheckpoint, type ErasureKeys } from "../src/erasure-ledger";
import { reconcileIsolatedRestore, restoredDatabaseDigest, type RestoreInventory } from "../src/restore-reconciliation";
import { RefrefRestoreReader, type RecoveryObservation } from "../src/restore-refref-reader";
import type { SharedCheckoutSnapshot } from "../src/checkout-snapshot";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";
import { recordAuthenticatedConsents } from "../src/authenticated-consents";
import { currentLegalRelease, legalManifestHash } from "../src/legal-control";
import { checkInLabTicket, labLegalReview, readLabTicket, startLabGuest } from "../src/lab-tickets";

const now = new Date("2026-10-20T10:00:00.000Z");
const paymentAt = "2026-10-19T12:00:00.000Z", refundAt = "2026-10-19T13:00:00.000Z";
let root: string, source: Database.Database, db: Database.Database, ledger: ErasureLedgerStore;
let keys: ErasureKeys, signer: { keyId: string; privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] };
let inventory: RestoreInventory, observation: RecoveryObservation;
let rail: MockPaymentRail;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "art-313-")); mkdirSync(join(root, "ledger"), { mode: 0o700 });
  source = new Database(join(root, "source.sqlite")); source.pragma("foreign_keys=ON"); source.pragma("journal_mode=WAL"); migrateV2(source);
  source.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.test')").run();
  source.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  source.exec(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one');
    INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','course:one','product',10000,'PUBLIC');`);
  qualifyTestFiscalPolicies(source); openTestStorefront(source); rail = new MockPaymentRail();
  const signing = generateKeyPairSync("ed25519"); signer = { keyId: "signer", privateKey: signing.privateKey };
  keys = { signing: { signer: signing.publicKey }, subject: { subject: randomBytes(32) } };
  ledger = new ErasureLedgerStore({ directory: join(root, "ledger"), scope: "canary", keys, signer, forbiddenRoots: [join(root, "source.sqlite")] });
});
afterEach(() => { db?.close(); source.close(); ledger?.close(); rmSync(root, { recursive: true, force: true }); });
const readErasure = () => VerifiedErasureLedger.read({ scope: "canary", bundle: ledger.export(), keys,
  readCurrentCheckpoint: async nonce => issueErasureCheckpoint(ledger.export(), nonce, signer, keys, now), now: () => now });
async function restore(scenario = "late_payment") {
  await checkout(source, rail, testCheckoutConfig, { customerId: "customer", customerEmail: "student@example.test",
    offerRef: "course:one", idempotencyKey: "checkout-recovery", scenario }, "2026-10-19T10:00:00.000Z");
  await snapshot();
}
async function snapshot() {
  const filename = join(root, `backup-${randomUUID()}.sqlite`); await source.backup(filename);
  db = new Database(filename); db.pragma("foreign_keys=ON");
  const row = db.prepare(`SELECT orders.public_id,orders.checkout_snapshot_json,orders.snapshot_hash,attempt.refref_attempt_id
    FROM orders JOIN checkout_attempts attempt ON attempt.order_id=orders.id`).get() as
    { public_id: string; checkout_snapshot_json: string; snapshot_hash: string; refref_attempt_id: string };
  const frozen = JSON.parse(row.checkout_snapshot_json) as SharedCheckoutSnapshot;
  const attempt = { id: row.refref_attempt_id, merchantOrderId: row.public_id, snapshotHash: `refref-jcs-1:${row.snapshot_hash}`,
    referralResolutionId: frozen.referralResolutionId, termsVersionId: frozen.termsVersionId, currency: "RUB" as const,
    totalContractAmountKopecks: 10000, status: "SETTLED" as const,
    lineItems: [{ ...frozen.lines[0], refundableAmountKopecks: 10000 }],
    obligations: [{ obligationRef: "full", kind: "FULL" as const, executionMode: "ORCHESTRATED" as const,
      amountKopecks: 10000, status: "SATISFIED" as const,
      payment: { id: "accepted-payment", status: "SUCCEEDED" as const, amountKopecks: 10000,
        remainingRefundableAmountKopecks: 10000, succeededAt: paymentAt } }],
  };
  observation = { order: { merchantOrderId: row.public_id, checkoutAttempts: [attempt] },
    fulfillment: { checkoutAttemptId: attempt.id, status: "READY", externalFulfillmentId: null, acknowledgedAt: null }, refunds: [] };
  inventory = { version: 1, scope: "canary", merchantId: frozen.merchantId,
    backupSha256: createHash("sha256").update(readFileSync(filename)).digest("hex"), sourceEvidenceSha256: "e".repeat(64),
    completeThrough: now.toISOString(), orders: [{ orderPublicId: row.public_id, snapshotHash: attempt.snapshotHash, refundIds: [] }] };
}
function refunded() {
  const attempt = observation.order.checkoutAttempts[0];
  attempt.obligations[0].payment!.remainingRefundableAmountKopecks = 0; attempt.lineItems[0].refundableAmountKopecks = 0;
  observation.refunds = [{ id: "accepted-refund", paymentId: "accepted-payment", checkoutAttemptId: attempt.id,
    amountKopecks: 10000, status: "SUCCEEDED", succeededAt: refundAt,
    lineAllocations: [{ checkoutLineItemId: "refref-internal-line-id", amountKopecks: 10000, commissionableReversalKopecks: 0 }] }];
  inventory.orders[0].refundIds = ["accepted-refund"];
}
const reconcile = (read = vi.fn(async () => structuredClone(observation)), erasure = readErasure) =>
  reconcileIsolatedRestore({ db, inventory, reader: { read }, keys, readErasure: erasure, now: () => now });
const financial = () => ({ orders: db.prepare("SELECT public_id,state FROM orders ORDER BY public_id").all(),
  entitlements: db.prepare("SELECT * FROM course_entitlements ORDER BY id").all(),
  events: db.prepare("SELECT * FROM audit_log WHERE actor='ISOLATED_RESTORE' ORDER BY id").all() });
function unpaidOutcome(state: "CANCELLED" | "EXPIRED") {
  const attempt = observation.order.checkoutAttempts[0]; attempt.status = state;
  attempt.obligations[0].status = "CANCELLED"; attempt.obligations[0].payment = null;
  attempt.lineItems[0].refundableAmountKopecks = 0; observation.fulfillment.status = "NOT_READY";
}

describe("isolated SQLite backup + fresh Refref money tail", () => {
  it.each([
    ["CANCELLED", "PENDING", "FULFILLED"], ["EXPIRED", "PENDING", "FULFILLED"],
    ["CANCELLED", "PENDING", "REFUNDED"], ["EXPIRED", "PENDING", "REFUNDED"],
    ["PAYMENT_PENDING", "DECLINED", "FULFILLED"], ["PAYMENT_PENDING", "EXPIRED", "FULFILLED"],
    ["PAYMENT_PENDING", "DECLINED", "REFUNDED"], ["PAYMENT_PENDING", "EXPIRED", "REFUNDED"],
    ["FULFILLED", "PENDING", "CANCELLED"], ["FULFILLED", "PENDING", "EXPIRED"],
    ["PAYMENT_PENDING", "PAID", "CANCELLED"], ["PAYMENT_PENDING", "PAID", "EXPIRED"],
    ["PAYMENT_PENDING", "REFUNDED", "FULFILLED"], ["PAYMENT_PENDING", "REFUNDED", "CANCELLED"],
    ["REFUNDED", "PENDING", "FULFILLED"], ["REFUNDED", "PENDING", "EXPIRED"],
    ["CANCELLED", "PENDING", "EXPIRED"], ["EXPIRED", "PENDING", "CANCELLED"],
    ["PAYMENT_PENDING", "DECLINED", "EXPIRED"], ["PAYMENT_PENDING", "EXPIRED", "CANCELLED"],
    ["CANCELLED", "PAID", "CANCELLED"], ["FULFILLED", "DECLINED", "FULFILLED"],
  ])("holds conflicting local order %s / attempt %s against remote %s before money or access changes", async (order, attempt, target) => {
    await restore();
    db.prepare("UPDATE orders SET state=?").run(order); db.prepare("UPDATE checkout_attempts SET state=?").run(attempt);
    if (target === "REFUNDED") refunded();
    if (target === "CANCELLED" || target === "EXPIRED") unpaidOutcome(target);
    const before = financial(), attempts = db.prepare("SELECT * FROM checkout_attempts").all();
    await expect(reconcile()).rejects.toThrow("RESTORE_LOCAL_MONEY_AHEAD");
    expect(financial()).toEqual(before); expect(db.prepare("SELECT * FROM checkout_attempts").all()).toEqual(attempts);
    expect(customerCanAccessCourse(db, "customer", "course-one")).toBe(false);
    expect(db.prepare("SELECT sale_mode FROM offers").get()).toEqual({ sale_mode: "CLOSED" });
  });
  it.each([
    ["CANCELLED", "DECLINED", "CANCELLED"], ["EXPIRED", "EXPIRED", "EXPIRED"],
    ["FULFILLED", "PAID", "FULFILLED"], ["REFUNDED", "REFUNDED", "REFUNDED"],
  ])("replays matching terminal order %s / attempt %s against remote %s", async (order, attempt, target) => {
    await restore();
    db.prepare("UPDATE orders SET state=?").run(order); db.prepare("UPDATE checkout_attempts SET state=?").run(attempt);
    if (target === "REFUNDED") refunded();
    if (target === "CANCELLED" || target === "EXPIRED") unpaidOutcome(target);
    await reconcile(); const once = financial(); await reconcile(); expect(financial()).toEqual(once);
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: target });
    expect(customerCanAccessCourse(db, "customer", "course-one")).toBe(target === "FULFILLED");
  });
  it("recovers a post-backup payment once, repairs access, freezes checkout, preserves merchant-owned records and reads back", async () => {
    await restore();
    grantManualEntitlement(db, { customerId: "customer", scope: "COURSE", courseRef: "course-one", reason: "manual",
      evidenceRef: "owner-record", legalTermsRef: "terms", actor: "owner", idempotencyKey: "manual-recovery" });
    saveEditorialDraft(db, { expectedRevision: 0, actor: "editor", document: { courseRef: "course-one", slug: "one",
      title: "Local editorial", summary: "Keep", visibility: "LISTED",
      sections: [{ sectionRef: "section-one", title: "Section", position: 0, visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson-one", sectionRef: "section-one", title: "Lesson", slug: "lesson", position: 0, visibility: "LISTED", freePreview: false }] } });
    confirmSyntheticAccount(db, "customer"); const release = currentLegalRelease(db, "COURSES")!;
    recordAuthenticatedConsents(db, "customer", { storefront: "COURSES", releaseVersion: release.version,
      manifestSha256: legalManifestHash(release.manifest), actionKey: "restore-preserved-consents", personalDataConsent: true,
      accountTermsAccepted: true, marketingConsent: true });
    const retainedTables = ["account_consents", "marketing_consents", "authenticated_consent_actions", "authenticated_consent_events", "course_editorial_drafts", "control_room_audit_log"];
    const retained = retainedTables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const read = vi.fn(async () => structuredClone(observation));
    const report = await reconcile(read);
    expect(report).toMatchObject({ state: "RECONCILED_CLOSED", ownerGo: "REQUIRED", runtimeAdmission: "PENDING" });
    expect(report.databaseSha256).toBe(restoredDatabaseDigest(db)); expect(read).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) n FROM course_entitlements").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT fulfillment_acknowledged_at FROM checkout_attempts").get()).toEqual({ fulfillment_acknowledged_at: null });
    expect(retainedTables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(retained);
    await expect(prepareCheckout(db, rail, testCheckoutConfig, { customerId: "customer", customerEmail: "student@example.test",
      offerRef: "course:one", previewIdempotencyKey: "after-restore" }, now.toISOString())).rejects.toThrow();
    const once = financial(); await reconcile(); expect(financial()).toEqual(once);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='RESTORE_ACCEPTED_PAYMENT'").get()).toEqual({ n: 1 });
  });
  it("revokes refunded purchase access from the accepted canonical refund while preserving a separate manual grant", async () => {
    await restore("success"); refunded();
    grantManualEntitlement(db, { customerId: "customer", scope: "COURSE", courseRef: "course-one", reason: "manual",
      evidenceRef: "owner-record", legalTermsRef: "terms", actor: "owner", idempotencyKey: "manual-recovery" });
    await reconcile();
    expect(db.prepare("SELECT state FROM orders WHERE total_kopecks>0").get()).toEqual({ state: "REFUNDED" });
    expect(db.prepare("SELECT revocation_reason FROM course_entitlements WHERE source_order_line_id=?")
      .get(observation.order.checkoutAttempts[0].lineItems[0].lineRef)).toEqual({ revocation_reason: "REFUNDED" });
    expect(customerCanAccessCourse(db, "customer", "course-one")).toBe(true);
    const once = financial(); await reconcile(); expect(financial()).toEqual(once);
  });
  it.each(["matching", "contradictory-decision"])("recovers only a matching lost refund execution (%s)", async decision => {
    await checkout(source, rail, testCheckoutConfig, { customerId: "customer", customerEmail: "student@example.test",
      offerRef: "course:one", idempotencyKey: "checkout-recovery" }, "2026-10-19T10:00:00.000Z");
    const order = source.prepare("SELECT public_id FROM orders").get() as { public_id: string };
    const request = requestRefund(source, { customerId: "customer", orderPublicId: order.public_id,
      idempotencyKey: "request", reasonCode: "CUSTOMER_REQUEST" });
    decideRefund(source, request.requestPublicId, { outcome: "APPROVE", amountKopecks: 10000,
      policyBasis: "terms", rationale: "owner", actor: "owner" });
    vi.spyOn(rail, "submitRefund").mockResolvedValue({ status: "UNKNOWN" });
    await executeApprovedRefund(source, rail, { currentKeyId: "k", keys: { k: randomBytes(32) } }, request.requestPublicId);
    await snapshot(); refunded();
    const payment = db.prepare("SELECT refref_payment_id FROM refund_executions").get() as { refref_payment_id: string };
    observation.order.checkoutAttempts[0].obligations[0].payment!.id = payment.refref_payment_id;
    observation.refunds[0].paymentId = payment.refref_payment_id;
    if (decision === "contradictory-decision") {
      db.exec("UPDATE refund_decisions SET outcome='REJECT',amount_kopecks=NULL; UPDATE refund_requests SET state='REJECTED'");
      const before = financial(), execution = db.prepare("SELECT * FROM refund_executions").get();
      await expect(reconcile()).rejects.toThrow("RESTORE_LOCAL_REFUND_REVIEW_REQUIRED");
      expect(financial()).toEqual(before); expect(db.prepare("SELECT * FROM refund_executions").get()).toEqual(execution); return;
    }
    await reconcile();
    expect(db.prepare("SELECT state,canonical_refund_id,request_envelope FROM refund_executions").get())
      .toEqual({ state: "SUCCEEDED", canonical_refund_id: "accepted-refund", request_envelope: null });
    expect(customerCanAccessCourse(db, "customer", "course-one")).toBe(false);
    await reconcile(); expect(db.prepare("SELECT state FROM refund_requests").get()).toEqual({ state: "REFUNDED" });
  });
  it("replays post-backup marketing suppression before any Refref read and never synthesizes consent", async () => {
    await restore();
    ledger.append({ requestId: randomUUID(), kind: "MARKETING_SUPPRESSION", subject: erasureSubject(keys, "subject", "canary",
      { email: "student@example.test", customerId: "customer", userId: "unbound-user" }) }, now);
    const read = vi.fn(async () => {
      expect(db.prepare("SELECT removed_at FROM email_suppressions WHERE email_normalized='student@example.test'").get()).toEqual({ removed_at: null });
      return structuredClone(observation);
    });
    await reconcile(read); expect(db.prepare("SELECT COUNT(*) n FROM account_consents").get()).toEqual({ n: 0 });
  });
  it("refuses a financially retained erased subject before reading Refref", async () => {
    await restore();
    ledger.append({ requestId: randomUUID(), kind: "ERASURE", subject: erasureSubject(keys, "subject", "canary",
      { email: "student@example.test", customerId: "customer", userId: "unbound-user" }) }, now);
    const read = vi.fn(async () => observation);
    await expect(reconcile(read)).rejects.toThrow("ERASURE_FINANCIAL_REVIEW_REQUIRED"); expect(read).not.toHaveBeenCalled();
    expect(db.prepare("SELECT sale_mode FROM offers").get()).toEqual({ sale_mode: "CLOSED" });
  });
  it("preserves irreversible LAB attendance and invalidates old QR/access tokens across payment/refund repair", async () => {
    source.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lab-legal','LAB','lab-b',?,?,1)")
      .run(stageBLegalManifestJson, "2026-10-19T09:00:00.000Z");
    source.exec(`INSERT INTO cities(id,slug,title) VALUES ('city','nsk','City');
      INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
        VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Studio','Address');
      INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('lab-product','lab:one','LAB','PAID','lab:one');
      INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('lab-offer','lab:one','lab-product',10000,'PUBLIC');`);
    qualifyTestFiscalPolicies(source); openTestStorefront(source, "LAB");
    const token = randomBytes(32).toString("base64url");
    const guest = startLabGuest(source, { email: "student@example.test", accessToken: token }, "2026-10-19T10:00:00.000Z");
    const quote = await prepareCheckout(source, rail, testCheckoutConfig, { customerId: "customer", customerEmail: "student@example.test",
      offerRef: "lab:one", previewIdempotencyKey: "lab-preview", orderPublicId: guest.orderPublicId }, "2026-10-19T10:00:00.000Z");
    if (quote.state !== "PRICE_REVIEW_REQUIRED") throw new Error("quote required");
    const review = labLegalReview(source);
    await confirmCheckout(source, rail, testCheckoutConfig, { customerId: "customer", customerEmail: "student@example.test",
      quoteId: quote.quoteId, idempotencyKey: "lab-checkout", labAcceptance: { personalDataConsent: true, termsAccepted: true,
        receiptContactAccepted: true, releaseVersion: review.releaseVersion, manifestSha256: review.manifestSha256 } }, "2026-10-19T10:00:00.000Z");
    const ticket = readLabTicket(source, token);
    if (!("qrToken" in ticket) || !ticket.qrToken) throw new Error("ticket QR required");
    checkInLabTicket(source, { qrToken: ticket.qrToken, occurrenceRef: "lab:one", actor: "owner" }, "2026-10-19T11:00:00.000Z");
    await snapshot(); await reconcile();
    expect(db.prepare("SELECT used_at,used_by,qr_sha256 FROM lab_tickets").get())
      .toEqual({ used_at: "2026-10-19T11:00:00.000Z", used_by: "owner", qr_sha256: null });
    expect(() => readLabTicket(db, token)).toThrow("LAB_ACCESS_INVALID");
    refunded(); await reconcile();
    expect(db.prepare("SELECT used_at,used_by FROM lab_tickets").get()).toEqual({ used_at: "2026-10-19T11:00:00.000Z", used_by: "owner" });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "REFUNDED" });
  });
  it("rejects an unreviewed trigger before even the sales-freeze write", async () => {
    await restore();
    db.exec("CREATE TRIGGER unreviewed AFTER UPDATE ON offers BEGIN UPDATE orders SET state='FULFILLED'; END");
    const before = restoredDatabaseDigest(db);
    await expect(reconcile()).rejects.toThrow("ERASURE_RESTORE_UNCLASSIFIED_SCHEMA");
    expect(restoredDatabaseDigest(db)).toBe(before);
  });
  it("holds a restore when independent erasure custody changes during reconciliation", async () => {
    await restore(); const before = financial(); let reads = 0;
    await expect(reconcile(undefined, async () => {
      if (++reads === 2) ledger.append({ requestId: randomUUID(), kind: "MARKETING_SUPPRESSION", subject: erasureSubject(keys, "subject", "canary",
        { email: "student@example.test", customerId: "customer", userId: "unbound-user" }) }, now);
      return readErasure();
    })).rejects.toThrow("RESTORE_ERASURE_CHANGED"); expect(financial()).toEqual(before);
  });
  it.each(["snapshot", "amount", "multiple", "parent", "cutoff", "refund-omitted", "refund-payment", "partial", "fulfillment", "entitlement", "unclassified", "inventory", "missing-order"])
    ("keeps money/access unchanged and sales closed on %s uncertainty", async reason => {
      await restore(); const attempt = observation.order.checkoutAttempts[0];
      if (reason === "snapshot") attempt.snapshotHash = `refref-jcs-1:${"f".repeat(64)}`;
      if (reason === "amount") attempt.obligations[0].payment!.amountKopecks--;
      if (reason === "multiple") observation.order.checkoutAttempts.push(structuredClone(attempt));
      if (reason === "parent") attempt.merchantOrderId = "other";
      if (reason === "cutoff") inventory.completeThrough = "2026-10-19T11:00:00.000Z";
      if (reason === "refund-omitted") { attempt.lineItems[0].refundableAmountKopecks = 0; attempt.obligations[0].payment!.remainingRefundableAmountKopecks = 0; }
      if (reason === "refund-payment") { refunded(); observation.refunds[0].paymentId = "other-payment"; }
      if (reason === "partial") { refunded(); observation.refunds[0].amountKopecks = 5000; }
      if (reason === "fulfillment") observation.fulfillment.status = "ACTION_REQUIRED";
      if (reason === "entitlement") db.prepare(`INSERT INTO course_entitlements(id,customer_id,scope,course_ref,source_order_line_id,granted_at)
        VALUES ('wrong','customer','COURSE','wrong-course',?,?)`).run(attempt.lineItems[0].lineRef, paymentAt);
      if (reason === "unclassified") db.exec("ALTER TABLE customers ADD COLUMN unreviewed TEXT");
      if (reason === "inventory") inventory.orders = [];
      if (reason === "missing-order") inventory.orders.push({ orderPublicId: "lost-tail", snapshotHash: `refref-jcs-1:${"b".repeat(64)}`, refundIds: [] });
      const before = financial(); await expect(reconcile()).rejects.toThrow(/RESTORE_|ERASURE_/);
      expect(financial()).toEqual(before);
      expect(db.prepare("SELECT sale_mode FROM offers").get()).toEqual({ sale_mode: reason === "unclassified" ? "PUBLIC" : "CLOSED" });
      if (reason !== "unclassified") expect(db.prepare("SELECT 1 FROM sales_activation WHERE revoked_at IS NULL").get()).toBeUndefined();
    });
  it("refuses changing Refref facts, concurrent local writes and unavailable/stale erasure authority", async () => {
    await restore(); const before = financial(); let reads = 0;
    await expect(reconcile(vi.fn(async () => { reads++; const result = structuredClone(observation);
      if (reads === 2) result.fulfillment.status = "DELIVERED"; return result; }))).rejects.toThrow("RESTORE_REFREF_CHANGED");
    expect(financial()).toEqual(before);
    await expect(reconcile(vi.fn(async () => { db.exec("UPDATE customers SET email_normalized='changed@example.test'"); return observation; })))
      .rejects.toThrow("RESTORE_DATABASE_CHANGED");
    await expect(reconcile(undefined, async () => { throw new Error("ERASURE_CURRENT_CUSTODY_UNAVAILABLE"); })).rejects.toThrow("ERASURE_CURRENT_CUSTODY_UNAVAILABLE");
    const proof = await readErasure();
    await expect(reconcileIsolatedRestore({ db, inventory, reader: { read: async () => observation }, keys,
      readErasure: async () => proof, now: () => new Date(now.getTime() + 60_001) })).rejects.toThrow("ERASURE_ADMISSION_EXPIRED");
    expect(financial()).toEqual(before);
  });
  it("does not let a second bad order partially commit the first paid repair", async () => {
    await restore();
    source.exec("INSERT INTO customers(id,email_normalized) VALUES ('other','other@example.test')");
    await checkout(source, rail, testCheckoutConfig, { customerId: "other", customerEmail: "other@example.test",
      offerRef: "course:one", idempotencyKey: "other-order", scenario: "late_payment" }, "2026-10-19T10:00:00.000Z");
    db.close(); await snapshot();
    const other = db.prepare("SELECT public_id,snapshot_hash FROM orders WHERE customer_id='other'").get() as { public_id: string; snapshot_hash: string };
    inventory.orders.push({ orderPublicId: other.public_id, snapshotHash: `refref-jcs-1:${other.snapshot_hash}`, refundIds: [] });
    const before = financial(); await expect(reconcile()).rejects.toThrow("RESTORE_ATTEMPT_AMBIGUOUS"); expect(financial()).toEqual(before);
  });
});

describe("Refref restore reader", () => {
  it("uses only authenticated uncached GETs, including the separate fulfillment read", async () => {
    await restore(); refunded();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(observation.order)))
      .mockResolvedValueOnce(new Response(JSON.stringify(observation.fulfillment)))
      .mockResolvedValueOnce(new Response(JSON.stringify(observation.refunds[0])));
    const reader = new RefrefRestoreReader({ apiBaseUrl: "https://api.example.test/v1-rc/", apiKey: "synthetic-key", fetch: fetcher });
    expect(await reader.read(inventory.orders[0].orderPublicId, ["accepted-refund"])).toEqual(observation);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ method: "GET", cache: "no-store", redirect: "error",
      headers: { authorization: "Bearer synthetic-key", "cache-control": "no-cache" } });
    expect(String(fetcher.mock.calls[1][0])).toContain("/fulfillment");
  });
  it.each([404, 401, 500])("refuses HTTP %s without leaking a response body", async status => {
    const reader = new RefrefRestoreReader({ apiBaseUrl: "https://api.example.test/v1-rc", apiKey: "synthetic-key",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("private-provider-body", { status })) });
    await expect(reader.read("order", [])).rejects.toThrow("RESTORE_REFREF_READ_REFUSED");
  });
});
