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
});
