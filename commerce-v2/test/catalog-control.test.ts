import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { assertLiveOfferSaleMode, configureProduct, withdrawProduct } from "../src/catalog-control";
import { migrateV2 } from "../src/db";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { setTestStorefronts, testCheckoutConfig } from "./fixtures/sales";
import { readV2Migrations } from "../src/migration-integrity";
import { writeMigrationBundle } from "./fixtures/migrations";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db); });

describe("catalog control room commands", () => {
  const seedOccurrence = () => {
    db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','moscow','Moscow')").run();
    db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
      VALUES ('occurrence','lab:2026-11-01','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Europe/Moscow',12,'CONFIRMED','Студия','ул. Фикстурная, 1')`).run();
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

  it("configures a PUBLIC offer only while its storefront is open and writes an audited withdrawal", () => {
    const config = testCheckoutConfig;
    const paid = { paymentPurpose: "Synthetic merchant course purpose", productRef: "course:paid", offerRef: "course:paid",
      kind: "ONLINE_COURSE" as const, courseRef: "paid", accessModel: "PAID" as const, priceKopecks: 100, saleMode: "PUBLIC" as const,
      actor: "author", expectedVersion: 0 };
    setTestStorefronts(db, { COURSES: "CLOSED" });
    expect(() => configureProduct(db, config, paid)).toThrow("SALES_STOPPED");
    // Without a switch at all (no host mount) nothing is PUBLIC either.
    expect(() => configureProduct(db, loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "mock" }), paid)).toThrow("SALES_STOPPED");
    // The LAB switch does not open courses; closing an offer never needs the switch.
    setTestStorefronts(db, { LAB: "OPEN" });
    expect(() => configureProduct(db, config, paid)).toThrow("SALES_STOPPED");
    setTestStorefronts(db, { COURSES: "OPEN" });
    configureProduct(db, config, paid);
    setTestStorefronts(db, { COURSES: "CLOSED" });
    configureProduct(db, config, { ...paid, saleMode: "CLOSED", expectedVersion: 1 });
    withdrawProduct(db, { productRef: "course:paid", reason: "Rights expired", termsRef: "offer-v1#withdrawal", actor: "owner", expectedVersion: 2 });
    expect(db.prepare("SELECT withdrawn_at IS NOT NULL AS withdrawn FROM products").get()).toEqual({ withdrawn: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get()).toEqual({ count: 3 });
  });

  it("keeps sales_activation as read-only history that authorizes nothing", () => {
    expect(() => db.prepare(`INSERT INTO sales_activation(id,product_kind,evidence_issue,evidence_sha256,activated_by,activated_at)
      VALUES ('direct','ONLINE_COURSE','ART-240',?,'owner','2026-09-30T00:00:00Z')`).run("c".repeat(64))).toThrow("SALES_ACTIVATION_RETIRED");
    setTestStorefronts(db, { COURSES: "CLOSED" });
    expect(() => assertLiveOfferSaleMode(db, testCheckoutConfig, { kind: "ONLINE_COURSE", accessModel: "PAID", saleMode: "PUBLIC" }))
      .toThrow("SALES_STOPPED");
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
    })).toThrow("LAB_OCCURRENCE_OFFER_EXISTS");
  });
});

describe("ONLINE_COURSE fence (migration 0016) after sales_activation (migration 0032)", () => {
  const bundle = { kind: "COURSE_BUNDLE", accessModel: "PAID", saleMode: "PUBLIC" } as const;
  const course = { kind: "ONLINE_COURSE", accessModel: "PAID", saleMode: "PUBLIC" } as const;
  const directBundle = (id: string) => db.prepare(`INSERT INTO sales_activation(id,product_kind,evidence_issue,evidence_sha256,activated_by,activated_at)
    VALUES (?,'COURSE_BUNDLE','ART-240',?,'owner','2026-10-01T00:00:00Z')`).run(id, "e".repeat(64));
  const directCourse = (id: string) => db.prepare(`INSERT INTO sales_activation(id,product_kind,evidence_issue,evidence_sha256,activated_by,activated_at)
    VALUES (?,'ONLINE_COURSE','ART-240',?,'owner','2026-10-01T00:00:00Z')`).run(id, "f".repeat(64));

  /** A database as it was before `version`: every migration up to it, from a copy of the directory. */
  const before = (version: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fx-0016-"));
    writeMigrationBundle(dir, Object.fromEntries(readV2Migrations().filter((migration) => migration.version < version).map(({ version: name, sql }) => [name, sql])));
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    migrateV2(old, dir);
    rmSync(dir, { recursive: true });
    return old;
  };

  it("an open COURSES switch opens ONLINE_COURSE sales and never COURSE_BUNDLE", () => {
    expect(() => assertLiveOfferSaleMode(db, testCheckoutConfig, course)).not.toThrow();
    expect(() => assertLiveOfferSaleMode(db, testCheckoutConfig, bundle)).toThrow("COURSE_BUNDLE_NOT_QUALIFIED");
    // Acceptance-only selling of a bundle stays possible, as before; it never becomes PUBLIC.
    expect(() => assertLiveOfferSaleMode(db, testCheckoutConfig, { ...bundle, saleMode: "ACCEPTANCE_ONLY" })).not.toThrow();
  });

  it("the LAB switch is independent of the COURSES switch", () => {
    setTestStorefronts(db, { COURSES: "CLOSED" });
    expect(() => assertLiveOfferSaleMode(db, testCheckoutConfig, { kind: "LAB", accessModel: "PAID", saleMode: "PUBLIC" })).not.toThrow();
    expect(() => assertLiveOfferSaleMode(db, testCheckoutConfig, course)).toThrow("SALES_STOPPED");
  });

  it("history from before 0016 and 0032 survives both migrations, authorizes nothing and stays frozen", () => {
    const old = before("0016");
    try {
      db = old;
      directBundle("historical");
      directCourse("course");
      // Already granted access, seeded without its order (foreign keys off only for the seed): neither migration touches it.
      db.pragma("foreign_keys = OFF");
      db.prepare(`INSERT INTO course_entitlements(id,customer_id,scope,course_ref,source_order_line_id,granted_at)
        VALUES ('grant','customer','ALL_COURSES',NULL,'line','2026-10-01T00:00:00Z')`).run();
      db.pragma("foreign_keys = ON");
      const grants = db.prepare("SELECT * FROM course_entitlements").all();

      migrateV2(db);
      expect(db.prepare("SELECT id,product_kind,revoked_at IS NOT NULL AS revoked,revocation_reason FROM sales_activation ORDER BY product_kind").all()).toEqual([
        { id: "historical", product_kind: "COURSE_BUNDLE", revoked: 1,
          revocation_reason: "ONLINE_COURSE_FENCE: ART-240 evidence does not qualify COURSE_BUNDLE (migration 0016)" },
        { id: "course", product_kind: "ONLINE_COURSE", revoked: 0, revocation_reason: null },
      ]);
      expect(db.prepare("SELECT * FROM course_entitlements").all()).toEqual(grants);
      expect(() => db.prepare("UPDATE sales_activation SET revoked_at=NULL,revocation_reason=NULL WHERE id='historical'").run()).toThrow();
      expect(() => db.prepare("UPDATE sales_activation SET revoked_at='2026-10-19T00:00:00Z',revocation_reason='x' WHERE id='course'").run())
        .toThrow("SALES_ACTIVATION_RETIRED");
      // Immutable history: it cannot be emptied either (review P2).
      expect(() => db.prepare("DELETE FROM sales_activation").run()).toThrow("SALES_ACTIVATION_RETIRED");
      expect(db.prepare("SELECT COUNT(*) AS n FROM sales_activation").get()).toEqual({ n: 2 });
      // An unrevoked historical activation opens nothing: only the owner's switch does.
      setTestStorefronts(db, { COURSES: "CLOSED" });
      expect(() => assertLiveOfferSaleMode(db, testCheckoutConfig, course)).toThrow("SALES_STOPPED");
      expect(() => assertLiveOfferSaleMode(db, testCheckoutConfig, bundle)).toThrow("COURSE_BUNDLE_NOT_QUALIFIED");
    } finally {
      old.close();
    }
  });
});
