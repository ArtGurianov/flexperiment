import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkout, MockPaymentRail } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { ErasureLedgerStore, VerifiedErasureLedger, erasureSubject, issueErasureCheckpoint, type ErasureKeys } from "../src/erasure-ledger";
import { applyIsolatedRestoreErasure, assertReviewedRestoreSchema } from "../src/erasure-restore";
import { checkInLabTicket, readOwnedLabTicket } from "../src/lab-tickets";
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
