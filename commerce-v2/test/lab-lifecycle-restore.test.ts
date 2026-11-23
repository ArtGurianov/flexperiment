import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkout, MockPaymentRail } from "../src/checkout";
import { applyV2Migration, migrateV2 } from "../src/db";
import { readFileSync, readdirSync } from "node:fs";
import { ErasureLedgerStore, VerifiedErasureLedger, erasureSubject, issueErasureCheckpoint, type ErasureKeys } from "../src/erasure-ledger";
import { applyIsolatedRestoreErasure, assertReviewedRestoreSchema } from "../src/erasure-restore";
import { checkInLabTicket, readOwnedLabTicket, reissueOwnedLabQr } from "../src/lab-tickets";
import { recordCheckedInServiceRendered } from "../src/service-rendered";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { confirmLabBuyer, labAcceptanceFor } from "./fixtures/lab-purchase";
import { openTestStorefront, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";

// FLEX-60/85 classification (E, 21.11.2026 req. 5): the new LAB evidence is part of the reviewed schema,
// and an erasure of a subject with a LAB order stops at financial review with every row intact.
const now = new Date("2026-11-02T10:00:00.000Z");
let root: string, db: Database.Database, ledger: ErasureLedgerStore, keys: ErasureKeys;
let signer: { keyId: string; privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] };
const count = (database: Database.Database, table: string) => (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flex-lab-restore-"));
  mkdirSync(join(root, "merchant"), { mode: 0o700 }); mkdirSync(join(root, "ledger"), { mode: 0o700 });
  db = new Database(join(root, "merchant", "commerce.sqlite")); db.pragma("foreign_keys=ON"); migrateV2(db);
  const signing = generateKeyPairSync("ed25519"); signer = { keyId: "signing-1", privateKey: signing.privateKey };
  keys = { signing: { "signing-1": signing.publicKey }, subject: { "subject-1": randomBytes(32) } };
  ledger = new ErasureLedgerStore({ directory: join(root, "ledger"), scope: "canary", keys, signer, forbiddenRoots: [join(root, "merchant")] });
});
afterEach(() => { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });

describe("LAB lifecycle evidence across restore and erasure", () => {
  it("restores qr_generation: the reissued QR stays valid and the revoked one stays revoked (synthetic key only)", async () => {
    db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lab-legal','LAB','lab-b',?,?,1)")
      .run(stageBLegalManifestJson, "2026-10-19T09:00:00.000Z");
    db.exec(`INSERT INTO cities(id,slug,title) VALUES ('city','nsk','City');
      INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
        VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Studio','Address');
      INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product','lab:one','LAB','PAID','lab:one');
      INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','lab:one','product',10000,'PUBLIC');
      INSERT INTO customers(id,email_normalized) VALUES ('buyer','buyer@example.test');`);
    qualifyTestFiscalPolicies(db); openTestStorefront(db, "LAB"); confirmLabBuyer(db, "buyer");
    const paid = await checkout(db, new MockPaymentRail(), testCheckoutConfig, { customerId: "buyer", customerEmail: "buyer@example.test",
      offerRef: "lab:one", idempotencyKey: "pay", labAcceptance: labAcceptanceFor(db) }, "2026-10-19T10:00:00.000Z");
    const key = randomBytes(32); // Synthetic; no persistent labTicketQrSecret exists (owner decision Q-QR pending).
    const first = readOwnedLabTicket(db, key, "buyer", paid.orderPublicId);
    const second = reissueOwnedLabQr(db, key, "buyer", paid.orderPublicId, "2026-10-20T10:00:00.000Z");
    const restored = new Database(db.serialize()); restored.pragma("foreign_keys=ON");
    try {
      assertReviewedRestoreSchema(restored);
      expect(restored.prepare("SELECT qr_generation FROM lab_tickets").get()).toEqual({ qr_generation: 1 });
      expect(readOwnedLabTicket(restored, key, "buyer", paid.orderPublicId)).toEqual(second);
      expect(() => checkInLabTicket(restored, { qrToken: "qrToken" in first ? first.qrToken! : "", occurrenceRef: "lab:one", actor: "door" },
        "2026-11-01T09:00:00.000Z")).toThrow("LAB_QR_INVALID");
      expect(checkInLabTicket(restored, { qrToken: "qrToken" in second ? second.qrToken! : "", occurrenceRef: "lab:one", actor: "door" },
        "2026-11-01T09:00:00.000Z")).toMatchObject({ status: "USED" });
    } finally { restored.close(); }
  });
  it("is in the reviewed restore schema and keeps acceptance, ticket use and SERVICE_RENDERED under financial review", async () => {
    assertReviewedRestoreSchema(db);
    db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lab-legal','LAB','lab-b',?,?,1)")
      .run(stageBLegalManifestJson, "2026-10-19T09:00:00.000Z");
    db.exec(`INSERT INTO cities(id,slug,title) VALUES ('city','nsk','City');
      INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
        VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Studio','Address');
      INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product','lab:one','LAB','PAID','lab:one');
      INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','lab:one','product',10000,'PUBLIC');
      INSERT INTO customers(id,email_normalized) VALUES ('buyer','buyer@example.test');`);
    qualifyTestFiscalPolicies(db); openTestStorefront(db, "LAB");
    const userId = confirmLabBuyer(db, "buyer");
    const paid = await checkout(db, new MockPaymentRail(), testCheckoutConfig, { customerId: "buyer", customerEmail: "buyer@example.test",
      offerRef: "lab:one", idempotencyKey: "pay", labAcceptance: labAcceptanceFor(db) }, "2026-10-19T10:00:00.000Z");
    const ticket = readOwnedLabTicket(db, Buffer.alloc(32, 3), "buyer", paid.orderPublicId);
    checkInLabTicket(db, { qrToken: "qrToken" in ticket ? ticket.qrToken! : "", occurrenceRef: "lab:one", actor: "door" }, "2026-11-01T09:10:00.000Z");
    recordCheckedInServiceRendered(db, { occurrenceRef: "lab:one", recordedBy: "owner" }, "2026-11-01T18:00:00.000Z");
    assertReviewedRestoreSchema(db);

    const restored = new Database(db.serialize()); restored.pragma("foreign_keys=ON");
    try {
      ledger.append({ requestId: randomUUID(), kind: "ERASURE", subject: erasureSubject(keys, "subject-1", "canary",
        { email: "buyer@example.test", customerId: "buyer", userId }) }, now);
      const verified = await VerifiedErasureLedger.read({ scope: "canary", bundle: ledger.export(), keys,
        readCurrentCheckpoint: async nonce => issueErasureCheckpoint(ledger.export(), nonce, signer, keys, now), now: () => now });
      expect(() => applyIsolatedRestoreErasure(restored, verified, keys, "canary", now)).toThrow("ERASURE_FINANCIAL_REVIEW_REQUIRED");
      for (const table of ["lab_purchase_acceptances", "lab_service_renditions", "lab_tickets", "orders", "customers"]) expect(count(restored, table)).toBe(1);
      expect(restored.prepare("SELECT used_by FROM lab_tickets").get()).toEqual({ used_by: "door" });
      const acceptance = JSON.stringify(restored.prepare("SELECT * FROM lab_purchase_acceptances").get());
      expect(acceptance).not.toContain("buyer@example.test");
    } finally { restored.close(); }
  });
});

describe("migration 0040 rebuilds SERVICE_RENDERED without losing or inventing a fact", () => {
  const directory = join(process.cwd(), "commerce-v2/migrations");
  const upTo0039 = () => {
    const legacy = new Database(":memory:"); legacy.pragma("foreign_keys=ON");
    for (const version of readdirSync(directory).filter(name => name.endsWith(".sql") && name < "0040").sort()) {
      applyV2Migration(legacy, version, readFileSync(join(directory, version), "utf8"));
    }
    legacy.exec(`INSERT INTO cities(id,slug,title) VALUES ('city','nsk','City');
      INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
        VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Studio','Address');
      INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product','lab:one','LAB','PAID','lab:one');`);
    legacy.pragma("foreign_keys=OFF"); // The 0039-era fact under test; its order line is not.
    return legacy;
  };
  const v0040 = "0040_lab_service_rendered_semantics.sql";
  it("moves a 0039 check-in time to checked_in_at and records rendering at recorded_at", () => {
    const legacy = upTo0039();
    try {
      legacy.prepare(`INSERT INTO lab_service_renditions(order_line_id,occurrence_ref,basis,attestation_reason,rendered_at,evidence_ref,recorded_by,recorded_at)
        VALUES ('line','lab:one','CHECKED_IN',NULL,'2026-11-01T09:05:00Z','lab-ticket:t:used','owner','2026-11-01T18:00:00Z')`).run();
      applyV2Migration(legacy, v0040, readFileSync(join(directory, v0040), "utf8"));
      expect(legacy.prepare("SELECT basis,checked_in_at,rendered_at,recorded_at FROM lab_service_renditions").get())
        .toEqual({ basis: "CHECKED_IN", checked_in_at: "2026-11-01T09:05:00Z", rendered_at: "2026-11-01T18:00:00Z", recorded_at: "2026-11-01T18:00:00Z" });
      expect(() => legacy.prepare("DELETE FROM lab_service_renditions").run()).toThrow("LAB_SERVICE_RENDERED_IMMUTABLE");
    } finally { legacy.close(); }
  });
  it("aborts on a 0039 attendance-list fact without a protected document reference", () => {
    const legacy = upTo0039();
    try {
      legacy.prepare(`INSERT INTO lab_service_renditions(order_line_id,occurrence_ref,basis,attestation_reason,rendered_at,evidence_ref,recorded_by,recorded_at)
        VALUES ('line','lab:one','ATTENDED_ATTESTED','ATTENDANCE_LIST_CONFIRMED','2026-11-01T17:00:00Z','control-room:owner','owner','2026-11-01T18:00:00Z')`).run();
      expect(() => applyV2Migration(legacy, v0040, readFileSync(join(directory, v0040), "utf8"))).toThrow(/CHECK constraint/);
      expect(legacy.prepare("SELECT COUNT(*) AS n FROM lab_service_renditions").get()).toEqual({ n: 1 });
    } finally { legacy.close(); }
  });
});

describe("isolated restore never re-admits a revoked owned QR (E review blocker 1)", () => {
  it("snapshot → two reissues live → restore: every earlier QR stays refused, a fresh view gives a new QR", async () => {
    db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lab-legal','LAB','lab-b',?,?,1)")
      .run(stageBLegalManifestJson, "2026-10-19T09:00:00.000Z");
    db.exec(`INSERT INTO cities(id,slug,title) VALUES ('city','nsk','City');
      INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
        VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Studio','Address');
      INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product','lab:one','LAB','PAID','lab:one');
      INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','lab:one','product',10000,'PUBLIC');
      INSERT INTO customers(id,email_normalized) VALUES ('buyer','buyer@example.test');`);
    qualifyTestFiscalPolicies(db); openTestStorefront(db, "LAB"); confirmLabBuyer(db, "buyer");
    const paid = await checkout(db, new MockPaymentRail(), testCheckoutConfig, { customerId: "buyer", customerEmail: "buyer@example.test",
      offerRef: "lab:one", idempotencyKey: "pay", labAcceptance: labAcceptanceFor(db) }, "2026-10-19T10:00:00.000Z");
    const key = randomBytes(32); // Synthetic only.
    const qr = (ticket: ReturnType<typeof readOwnedLabTicket>) => "qrToken" in ticket ? ticket.qrToken! : "";
    const q0 = qr(readOwnedLabTicket(db, key, "buyer", paid.orderPublicId));
    const snapshot = db.serialize();
    const q1 = qr(reissueOwnedLabQr(db, key, "buyer", paid.orderPublicId, "2026-10-20T10:00:00.000Z"));
    const q2 = qr(reissueOwnedLabQr(db, key, "buyer", paid.orderPublicId, "2026-10-21T10:00:00.000Z"));
    const restored = new Database(snapshot); restored.pragma("foreign_keys=ON");
    try {
      ledger.append({ requestId: randomUUID(), kind: "MARKETING_SUPPRESSION", subject: erasureSubject(keys, "subject-1", "canary",
        { email: "nobody@example.test", customerId: "nobody", userId: "nobody" }) }, now);
      const verified = await VerifiedErasureLedger.read({ scope: "canary", bundle: ledger.export(), keys,
        readCurrentCheckpoint: async nonce => issueErasureCheckpoint(ledger.export(), nonce, signer, keys, now), now: () => now });
      applyIsolatedRestoreErasure(restored, verified, keys, "canary", now);
      const fresh = qr(readOwnedLabTicket(restored, key, "buyer", paid.orderPublicId));
      expect([q0, q1, q2]).not.toContain(fresh);
      for (const revoked of [q0, q1, q2]) {
        expect(() => checkInLabTicket(restored, { qrToken: revoked, occurrenceRef: "lab:one", actor: "door" }, "2026-11-01T09:00:00.000Z")).toThrow("LAB_QR_INVALID");
      }
      expect(checkInLabTicket(restored, { qrToken: fresh, occurrenceRef: "lab:one", actor: "door" }, "2026-11-01T09:00:00.000Z")).toMatchObject({ status: "USED" });
    } finally { restored.close(); }
  });
});

describe("erasure sees a subject embedded in an audit actor (E review blocker 2)", () => {
  it("stops at ERASURE_AUDIT_REVIEW_REQUIRED for actor customer:<id>, as written by an owned QR reissue", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('subject','subject@example.test')").run();
    const userId = confirmLabBuyer(db, "subject");
    // The exact row reissueOwnedLabQr writes; the subject has no order, so only the audit check can stop it.
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?, 'customer:subject','LAB_TICKET_QR_REISSUED','LAB_TICKET','ticket-x','{"generation":1}',?)`).run(randomUUID(), now.toISOString());
    ledger.append({ requestId: randomUUID(), kind: "ERASURE", subject: erasureSubject(keys, "subject-1", "canary",
      { email: "subject@example.test", customerId: "subject", userId }) }, now);
    const verified = await VerifiedErasureLedger.read({ scope: "canary", bundle: ledger.export(), keys,
      readCurrentCheckpoint: async nonce => issueErasureCheckpoint(ledger.export(), nonce, signer, keys, now), now: () => now });
    expect(() => applyIsolatedRestoreErasure(db, verified, keys, "canary", now)).toThrow("ERASURE_AUDIT_REVIEW_REQUIRED");
    expect(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE id='subject'").get()).toEqual({ n: 1 });
  });
});
