import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { activateSales, configureProduct, withdrawProduct } from "../src/catalog-control";
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
      productRef: "course:paid", offerRef: "course:paid", kind: "ONLINE_COURSE", courseRef: "paid",
      accessModel: "PAID", priceKopecks: 100, saleMode: "PUBLIC", actor: "author", expectedVersion: 0,
    });
    withdrawProduct(db, { productRef: "course:paid", reason: "Rights expired", termsRef: "offer-v1#withdrawal", actor: "owner", expectedVersion: 1 });
    expect(db.prepare("SELECT withdrawn_at IS NOT NULL AS withdrawn FROM products").get()).toEqual({ withdrawn: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get()).toEqual({ count: 2 });
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
