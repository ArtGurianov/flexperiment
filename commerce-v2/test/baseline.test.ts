import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { classifyV2Database, migrateV2, V2SchemaLineageError } from "../src/db";
import { applyV2Seed, readV2Catalogue, V2SeedError } from "../src/seed";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const database = () => { const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); open.push(db); return db; };

describe("v2 lineage", () => {
  it("bootstraps an empty database and records the new identity", () => {
    const db = database();
    migrateV2(db);
    expect(classifyV2Database(db)).toBe("SUPPORTED");
    expect(db.prepare("SELECT lineage, baseline_version FROM schema_identity").get()).toEqual({
      lineage: "flexperiment-v2", baseline_version: "0001_v2_baseline",
    });
  });

  it("refuses the frozen v1 lineage without applying anything", () => {
    const db = database();
    db.exec("CREATE TABLE schema_identity(singleton INTEGER PRIMARY KEY, lineage TEXT NOT NULL); INSERT INTO schema_identity VALUES (1, 'flexperiment-launch')");
    expect(() => migrateV2(db)).toThrow(new V2SchemaLineageError("V1_DATABASE_REFUSED"));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'products'").get()).toBeUndefined();
  });

  it("rolls back the ledger together with a broken first migration", () => {
    const db = database();
    const dir = mkdtempSync(join(tmpdir(), "v2-migrations-"));
    writeFileSync(join(dir, "0001_bad.sql"), "CREATE TABLE partial(id TEXT); THIS IS INVALID SQL;");
    expect(() => migrateV2(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  });
});

describe("v2 baseline invariants", () => {
  it("has every approved LMS table", () => {
    const db = database(); migrateV2(db);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name));
    for (const name of ["user", "session", "account", "verification", "customers", "products", "offers", "sales_activation",
      "course_entitlements", "catalog_course_projection", "catalog_section_projection", "catalog_lesson_projection",
      "access_overrides", "lesson_video_bindings", "video_upload_sessions", "kinescope_webhook_events", "playback_grant_rate_limits",
      "playback_access_events",
      "lesson_resume_positions", "marketing_consents", "email_suppressions", "notification_campaigns",
      "notification_campaign_recipients", "merchant_promotion", "checkout_quotes", "course_access_starts",
      "refund_requests", "refund_decisions", "refund_executions", "control_room_admin_sessions",
      "control_room_login_rate_limits", "control_room_audit_log"]) expect(tables.has(name), name).toBe(true);
  });

  it("allows guest customers and binds at most one customer to an auth user", () => {
    const db = database(); migrateV2(db);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run("guest", "guest@example.test");
    db.prepare('INSERT INTO "user"(id,name,email) VALUES (?,?,?)').run("u", "U", "u@example.test");
    db.prepare("UPDATE customers SET auth_user_id = ? WHERE id = ?").run("u", "guest");
    expect(() => db.prepare("INSERT INTO customers(id,email_normalized,auth_user_id) VALUES (?,?,?)").run("other", "other@example.test", "u")).toThrow(/UNIQUE/);
  });

  it("requires withdrawal reason and terms evidence", () => {
    const db = database(); migrateV2(db);
    expect(() => db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref,withdrawn_at) VALUES ('p','course:x','ONLINE_COURSE','PAID','x','now')").run()).toThrow(/CHECK/);
  });

  it("requires LAB products to identify one existing occurrence", () => {
    const db = database(); migrateV2(db);
    db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','city','City')").run();
    db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity)
      VALUES ('occurrence','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','UTC',1)`).run();
    expect(() => db.prepare("INSERT INTO products(id,product_ref,kind,access_model) VALUES ('bad','lab:bad','LAB','PAID')").run())
      .toThrow(/PRODUCT_OCCURRENCE_CONTRACT_INVALID/);
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref)
      VALUES ('good','lab:one','LAB','PAID','lab:one')`).run();
    expect(() => db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref)
      VALUES ('duplicate','lab:duplicate','LAB','PAID','lab:one')`).run()).toThrow(/UNIQUE/);
  });

  it("enforces one offer per product and one canonical all-courses bundle", () => {
    const db = database(); migrateV2(db);
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('course','course:one','ONLINE_COURSE','PAID','one')").run();
    db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks) VALUES ('offer','course:one','course',100)").run();
    expect(() => db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks) VALUES ('duplicate','course:other','course',200)").run())
      .toThrow(/UNIQUE/);
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model) VALUES ('bundle','bundle:all-courses','COURSE_BUNDLE','PAID')").run();
    expect(() => db.prepare("INSERT INTO products(id,product_ref,kind,access_model) VALUES ('bad-bundle','bundle:other','COURSE_BUNDLE','PAID')").run())
      .toThrow(/ALL_COURSES_BUNDLE_REF_INVALID|UNIQUE/);
  });

  it("keeps terminal override evidence complete", () => {
    const db = database(); migrateV2(db);
    expect(() => db.prepare(`INSERT INTO access_overrides
      (operation_id,course_ref,scope_level,scope_ref,expected_kind,expected_value,deadline_at,platform_epoch,state,resolved_at)
      VALUES ('op','c','COURSE','c','EFFECTIVE_VISIBILITY','UNLISTED','later','epoch','FINALIZED','now')`).run()).toThrow(/CHECK/);
  });
});

describe("v2 launch seed", () => {
  it("is deterministic and refuses a changed second catalogue", () => {
    const db = database(); migrateV2(db);
    const catalogue = readV2Catalogue();
    expect(applyV2Seed(db, catalogue).kind).toBe("APPLIED");
    expect(applyV2Seed(db, catalogue).kind).toBe("ALREADY_APPLIED");
    expect(() => applyV2Seed(db, { ...catalogue, cities: [...catalogue.cities, { slug: "kazan", title: "Казань" }] })).toThrow(new V2SeedError("V2_SEED_CATALOGUE_MISMATCH"));
  });

  it("seeds LAB occurrences before their targetable products and offers", () => {
    const db = database(); migrateV2(db);
    const catalogue = readV2Catalogue();
    const labCatalogue = {
      ...catalogue,
      products: [...catalogue.products, {
        productRef: "lab:one", kind: "LAB" as const, accessModel: "PAID" as const,
        occurrenceRef: "lab:one", offerRef: "lab:one", priceKopecks: 50_000, saleMode: "CLOSED" as const,
      }],
      labOccurrences: [{
        occurrenceRef: "lab:one", citySlug: "moscow", title: "LAB One",
        startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T17:00:00Z", timezone: "Europe/Moscow", capacity: 12,
      }],
    };
    expect(applyV2Seed(db, labCatalogue).kind).toBe("APPLIED");
    expect(db.prepare(`SELECT product.occurrence_ref,offer.offer_ref FROM products product
      JOIN offers offer ON offer.product_id=product.id WHERE product.kind='LAB'`).get()).toEqual({
      occurrence_ref: "lab:one", offer_ref: "lab:one",
    });
  });
});
