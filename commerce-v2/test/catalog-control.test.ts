import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { activateSales, assertLiveOfferSaleMode, configureProduct, withdrawProduct } from "../src/catalog-control";
import { migrateV2 } from "../src/db";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db); });

describe("catalog control room commands", () => {
  const seedOccurrence = () => {
    db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','moscow','Moscow')").run();
    db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity)
      VALUES ('occurrence','lab:2026-11-01','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Europe/Moscow',12)`).run();
  };

  it("permits a free Stage A product while paid sales stay closed", () => {
    const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", MERCHANT_PROMOTION_PREFIX: "FX-" });
    configureProduct(db, config, {
      productRef: "course:free", offerRef: "course:free", kind: "ONLINE_COURSE", courseRef: "free",
      accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED", actor: "author", expectedVersion: 0,
    });
    expect(() => configureProduct(db, config, {
      productRef: "course:paid", offerRef: "course:paid", kind: "ONLINE_COURSE", courseRef: "paid",
      accessModel: "PAID", priceKopecks: 100, saleMode: "PUBLIC", actor: "author", expectedVersion: 0,
    })).toThrow("PAYMENTS_DISABLED");
  });

  it("requires evidence before public activation and writes an audited withdrawal", () => {
    const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "mock" });
    expect(() => configureProduct(db, config, {
      productRef: "course:paid", offerRef: "course:paid", kind: "ONLINE_COURSE", courseRef: "paid",
      accessModel: "PAID", priceKopecks: 100, saleMode: "PUBLIC", actor: "author", expectedVersion: 0,
    })).toThrow("SALES_ACTIVATION_REQUIRED");
    activateSales(db, { kind: "ONLINE_COURSE", evidenceIssue: "ART-240", evidenceSha256: "a".repeat(64), actor: "owner" });
    configureProduct(db, config, {
      paymentPurpose: "Synthetic merchant course purpose",
      productRef: "course:paid", offerRef: "course:paid", kind: "ONLINE_COURSE", courseRef: "paid",
      accessModel: "PAID", priceKopecks: 100, saleMode: "PUBLIC", actor: "author", expectedVersion: 0,
    });
    withdrawProduct(db, { productRef: "course:paid", reason: "Rights expired", termsRef: "offer-v1#withdrawal", actor: "owner", expectedVersion: 1 });
    expect(db.prepare("SELECT withdrawn_at IS NOT NULL AS withdrawn FROM products").get()).toEqual({ withdrawn: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get()).toEqual({ count: 2 });
  });

  it("accepts public sales activation only with the acceptance evidence named for its kind", () => {
    const evidence = { evidenceSha256: "b".repeat(64), actor: "owner" };
    for (const [kind, evidenceIssue] of [
      ["ONLINE_COURSE", "ART-243"], ["LAB", "ART-240"],
      ["ONLINE_COURSE", "ART-999"], ["LAB", "ART-2430"],
    ] as const) {
      expect(() => activateSales(db, { kind, evidenceIssue, ...evidence })).toThrow("SALES_ACTIVATION_EVIDENCE_INVALID");
    }
    expect(() => activateSales(db, { kind: "ONLINE_COURSE", evidenceIssue: "ART-240", evidenceSha256: "short", actor: "owner" }))
      .toThrow("SALES_ACTIVATION_EVIDENCE_INVALID");
    expect(db.prepare("SELECT COUNT(*) AS count FROM sales_activation").get()).toEqual({ count: 0 });

    activateSales(db, { kind: "ONLINE_COURSE", evidenceIssue: "ART-240", ...evidence });
    activateSales(db, { kind: "LAB", evidenceIssue: "ART-243", ...evidence });
    expect(db.prepare("SELECT product_kind,evidence_issue FROM sales_activation ORDER BY product_kind").all()).toEqual([
      { product_kind: "LAB", evidence_issue: "ART-243" },
      { product_kind: "ONLINE_COURSE", evidence_issue: "ART-240" },
    ]);

    // Checkout trusts the row, so the schema refuses wrong or rewritten evidence even outside the command.
    db.prepare("UPDATE sales_activation SET revoked_at='2026-09-30T00:00:00Z',revocation_reason='test' WHERE product_kind='LAB'").run();
    expect(() => db.prepare(`INSERT INTO sales_activation(id,product_kind,evidence_issue,evidence_sha256,activated_by,activated_at)
      VALUES ('direct','LAB','ART-240',?,'owner','2026-09-30T00:00:00Z')`).run("c".repeat(64))).toThrow("SALES_ACTIVATION_EVIDENCE_INVALID");
    expect(() => db.prepare("UPDATE sales_activation SET evidence_issue='ART-243' WHERE product_kind='ONLINE_COURSE'").run())
      .toThrow("SALES_ACTIVATION_EVIDENCE_IMMUTABLE");
  });

  it("rejects stale catalogue edits and withdrawals", () => {
    const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "mock" });
    configureProduct(db, config, { productRef: "course:one", offerRef: "course:one", kind: "ONLINE_COURSE", courseRef: "one",
      accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED", actor: "author", expectedVersion: 0 });
    expect(() => configureProduct(db, config, { productRef: "course:one", offerRef: "course:one", kind: "ONLINE_COURSE", courseRef: "one",
      accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED", actor: "author", expectedVersion: 0 })).toThrow("CATALOG_VERSION_CONFLICT");
    expect(() => withdrawProduct(db, { productRef: "course:one", reason: "reason", termsRef: "terms", actor: "owner", expectedVersion: 0 }))
      .toThrow("CATALOG_VERSION_CONFLICT");
  });

  it("keeps product identity fixed while terms stay editable under the version check", () => {
    const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "mock" });
    seedOccurrence();
    const course = { productRef: "course:one", offerRef: "course:one", kind: "ONLINE_COURSE" as const, courseRef: "one",
      accessModel: "PAID" as const, priceKopecks: 100, saleMode: "CLOSED" as const, actor: "author" };
    configureProduct(db, config, { ...course, expectedVersion: 0 });

    for (const change of [
      { courseRef: "two" },
      { offerRef: "course:two" },
      { kind: "LAB" as const, courseRef: undefined, occurrenceRef: "lab:2026-11-01" },
    ]) {
      expect(() => configureProduct(db, config, { ...course, ...change, expectedVersion: 1 })).toThrow("PRODUCT_IDENTITY_IMMUTABLE");
    }
    expect(db.prepare(`SELECT product.kind,product.course_ref,product.occurrence_ref,product.version,offer.offer_ref
      FROM products product JOIN offers offer ON offer.product_id=product.id`).get())
      .toEqual({ kind: "ONLINE_COURSE", course_ref: "one", occurrence_ref: null, version: 1, offer_ref: "course:one" });

    const edited = configureProduct(db, config, { ...course, accessModel: "FREE", priceKopecks: 0,
      saleMode: "ACCEPTANCE_ONLY", acceptanceAllowlist: ["Tester@Example.com"], expectedVersion: 1 });
    expect(edited.version).toBe(2);
    expect(db.prepare("SELECT price_kopecks,sale_mode,acceptance_allowlist_json FROM offers").get())
      .toEqual({ price_kopecks: 0, sale_mode: "ACCEPTANCE_ONLY", acceptance_allowlist_json: '["tester@example.com"]' });
    expect(() => configureProduct(db, config, { ...course, priceKopecks: 200, expectedVersion: 1 })).toThrow("CATALOG_VERSION_CONFLICT");

    // The schema refuses an identity change even from a write that bypasses the command.
    expect(() => db.prepare("UPDATE products SET course_ref='two'").run()).toThrow("PRODUCT_IDENTITY_IMMUTABLE");
    expect(() => db.prepare("UPDATE offers SET offer_ref='course:two'").run()).toThrow("PRODUCT_IDENTITY_IMMUTABLE");
  });

  it("binds each LAB product and offer to exactly one existing occurrence", () => {
    const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", MERCHANT_PROMOTION_PREFIX: "FX-" });
    seedOccurrence();
    expect(() => configureProduct(db, config, {
      productRef: "lab:missing", offerRef: "lab:missing", kind: "LAB",
      accessModel: "PAID", priceKopecks: 100, saleMode: "CLOSED", actor: "author", expectedVersion: 0,
    })).toThrow("OCCURRENCE_REF_REQUIRED");
    expect(() => configureProduct(db, config, {
      productRef: "lab:unknown", offerRef: "lab:unknown", kind: "LAB", occurrenceRef: "lab:unknown",
      accessModel: "PAID", priceKopecks: 100, saleMode: "CLOSED", actor: "author", expectedVersion: 0,
    })).toThrow("LAB_OCCURRENCE_NOT_FOUND");

    configureProduct(db, config, {
      productRef: "lab:2026-11-01", offerRef: "lab:2026-11-01", kind: "LAB", occurrenceRef: "lab:2026-11-01",
      accessModel: "PAID", priceKopecks: 100, saleMode: "CLOSED", actor: "author", expectedVersion: 0,
    });
    expect(db.prepare(`SELECT product.occurrence_ref,offer.offer_ref FROM products product
      JOIN offers offer ON offer.product_id=product.id`).get()).toEqual({
      occurrence_ref: "lab:2026-11-01", offer_ref: "lab:2026-11-01",
    });
    expect(() => configureProduct(db, config, {
      productRef: "lab:duplicate", offerRef: "lab:duplicate", kind: "LAB", occurrenceRef: "lab:2026-11-01",
      accessModel: "PAID", priceKopecks: 200, saleMode: "CLOSED", actor: "author", expectedVersion: 0,
    })).toThrow(/UNIQUE/);
  });
});

describe("ONLINE_COURSE activation fence (migration 0016)", () => {
  const evidence = { evidenceSha256: "d".repeat(64), actor: "owner" };
  const mock = loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "mock" });
  const bundle = { kind: "COURSE_BUNDLE", accessModel: "PAID", saleMode: "PUBLIC" } as const;
  const course = { kind: "ONLINE_COURSE", accessModel: "PAID", saleMode: "PUBLIC" } as const;
  const directBundle = (id: string) => db.prepare(`INSERT INTO sales_activation(id,product_kind,evidence_issue,evidence_sha256,activated_by,activated_at)
    VALUES (?,'COURSE_BUNDLE','ART-240',?,'owner','2026-10-01T00:00:00Z')`).run(id, "e".repeat(64));

  /** A database as it was before 0016: every migration up to it, from a copy of the directory. */
  const before0016 = () => {
    const source = join(__dirname, "..", "migrations");
    const dir = mkdtempSync(join(tmpdir(), "fx-0016-"));
    for (const name of readdirSync(source)) if (name.endsWith(".sql") && name < "0016") copyFileSync(join(source, name), join(dir, name));
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    migrateV2(old, dir);
    rmSync(dir, { recursive: true });
    return old;
  };

  it("ART-240 evidence opens ONLINE_COURSE sales and never COURSE_BUNDLE, through the command or direct SQL", () => {
    expect(() => activateSales(db, { kind: "COURSE_BUNDLE", evidenceIssue: "ART-240", ...evidence })).toThrow("SALES_ACTIVATION_NOT_QUALIFIED");
    expect(() => directBundle("direct")).toThrow("SALES_ACTIVATION_EVIDENCE_INVALID");
    activateSales(db, { kind: "ONLINE_COURSE", evidenceIssue: "ART-240", ...evidence });
    expect(() => assertLiveOfferSaleMode(db, mock, course)).not.toThrow();
    expect(() => assertLiveOfferSaleMode(db, mock, bundle)).toThrow("SALES_ACTIVATION_REQUIRED");
    // Acceptance-only selling of a bundle needs no activation, as before; it never becomes PUBLIC.
    expect(() => assertLiveOfferSaleMode(db, mock, { ...bundle, saleMode: "ACCEPTANCE_ONLY" })).not.toThrow();
  });

  it("LAB activation is independent of the course fence", () => {
    activateSales(db, { kind: "LAB", evidenceIssue: "ART-243", ...evidence });
    expect(() => assertLiveOfferSaleMode(db, mock, { kind: "LAB", accessModel: "PAID", saleMode: "PUBLIC" })).not.toThrow();
    expect(() => assertLiveOfferSaleMode(db, mock, course)).toThrow("SALES_ACTIVATION_REQUIRED");
  });

  it("a revoked activation stays revoked, whatever its kind", () => {
    activateSales(db, { kind: "ONLINE_COURSE", evidenceIssue: "ART-240", ...evidence });
    db.prepare("UPDATE sales_activation SET revoked_at='2026-10-02T00:00:00Z',revocation_reason='evidence withdrawn'").run();
    expect(() => db.prepare("UPDATE sales_activation SET revoked_at=NULL,revocation_reason=NULL").run()).toThrow("SALES_ACTIVATION_REVOCATION_FINAL");
    expect(() => db.prepare("UPDATE sales_activation SET revocation_reason='rewritten'").run()).toThrow("SALES_ACTIVATION_REVOCATION_FINAL");
    expect(() => assertLiveOfferSaleMode(db, mock, course)).toThrow("SALES_ACTIVATION_REQUIRED");
    // Re-opening is a new activation, under the evidence rule.
    activateSales(db, { kind: "ONLINE_COURSE", evidenceIssue: "ART-240", ...evidence });
    expect(() => assertLiveOfferSaleMode(db, mock, course)).not.toThrow();
  });

  it("a bundle activation from before 0016 authorizes nothing, is revoked with its reason, and entitlements are untouched", () => {
    const old = before0016();
    try {
      db = old;
      directBundle("historical");
      activateSales(db, { kind: "ONLINE_COURSE", evidenceIssue: "ART-240", ...evidence });
      // Already granted access, seeded without its order (foreign keys off only for the seed): 0016 must not touch it.
      db.pragma("foreign_keys = OFF");
      db.prepare(`INSERT INTO course_entitlements(id,customer_id,scope,course_ref,source_order_line_id,granted_at)
        VALUES ('grant','customer','ALL_COURSES',NULL,'line','2026-10-01T00:00:00Z')`).run();
      db.pragma("foreign_keys = ON");
      const grants = db.prepare("SELECT * FROM course_entitlements").all();

      // The application ignores the row even before the migration runs: its evidence no longer qualifies.
      expect(() => assertLiveOfferSaleMode(db, mock, bundle)).toThrow("SALES_ACTIVATION_REQUIRED");

      migrateV2(db);
      expect(db.prepare("SELECT id,product_kind,revoked_at IS NOT NULL AS revoked,revocation_reason FROM sales_activation ORDER BY product_kind").all()).toEqual([
        { id: "historical", product_kind: "COURSE_BUNDLE", revoked: 1,
          revocation_reason: "ONLINE_COURSE_FENCE: ART-240 evidence does not qualify COURSE_BUNDLE (migration 0016)" },
        expect.objectContaining({ product_kind: "ONLINE_COURSE", revoked: 0, revocation_reason: null }),
      ]);
      expect(db.prepare("SELECT * FROM course_entitlements").all()).toEqual(grants);
      expect(() => db.prepare("UPDATE sales_activation SET revoked_at=NULL,revocation_reason=NULL WHERE id='historical'").run())
        .toThrow("SALES_ACTIVATION_REVOCATION_FINAL");
      expect(() => assertLiveOfferSaleMode(db, mock, bundle)).toThrow("SALES_ACTIVATION_REQUIRED");
      expect(() => assertLiveOfferSaleMode(db, mock, course)).not.toThrow();
    } finally {
      old.close();
    }
  });
});
