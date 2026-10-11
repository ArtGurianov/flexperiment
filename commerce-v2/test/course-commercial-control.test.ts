import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { configureCourseCommercial } from "../src/course-commercial-control";
import { configureProduct, withdrawProduct } from "../src/catalog-control";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { resolvePlaybackAccess } from "../src/playback-access";
import { listCustomerLibrary } from "../src/library";
import { createCommerceV2App } from "../src/app";

let db: Database.Database;
const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" });
const now = new Date("2026-10-11T10:00:00Z");
const command = { courseRef: "one", accessModel: "FREE" as "FREE" | "PAID", priceKopecks: 0,
  expectedVersion: 0, actor: "payload:7", commandKey: "synthetic-command-0001" };
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db); });
afterEach(() => db.close());
const configure = (overrides = {}) => configureCourseCommercial(db, config, { ...command, ...overrides }, now.toISOString());
const playable = () => {
  configure();
  db.exec(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('u','Student','student@example.com',1);
    INSERT INTO customers(id,email_normalized,auth_user_id) VALUES ('c','student@example.com','u');
    INSERT INTO customers(id,email_normalized) VALUES ('new','new@example.com');
    INSERT INTO catalog_course_projection(course_ref,version,content_hash,visibility,last_reconciled_at)
      VALUES ('one',1,'${"a".repeat(64)}','LISTED','2026-10-11T10:00:00Z');
    INSERT INTO catalog_section_projection(section_ref,course_ref,visibility,position) VALUES ('section','one','LISTED',0);
    INSERT INTO catalog_lesson_projection(lesson_ref,course_ref,section_ref,ever_published,visibility,free_preview,position)
      VALUES ('lesson','one','section',1,'LISTED',0,0);
    INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES ('lesson','synthetic-video','now','now');`);
};
const access = (overrides = {}) => resolvePlaybackAccess(db, { customerId: "c", lessonRef: "lesson", now, leaseMs: 60_000, ...overrides });
describe("CMS canonical course commercial commands", () => {
  it("creates a closed FREE offer without financial rows and atomically deduplicates commands", () => {
    const first = configure(); expect(configure()).toEqual(first);
    expect(first).toMatchObject({ version: 1, accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED" });
    expect(db.prepare("SELECT count(*) n FROM audit_log").get()).toEqual({ n: 1 });
    for (const table of ["orders", "order_lines", "checkout_attempts"]) expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(() => configure({ accessModel: "PAID", priceKopecks: 100 })).toThrow("COURSE_COMMAND_KEY_CONFLICT");
  });
  it.each([["FREE", 1], ["PAID", 0], ["PAID", -1], ["PAID", 1.5], ["PAID", Number.MAX_SAFE_INTEGER + 1]])("rejects invalid %s price %s", (accessModel, priceKopecks) => {
    expect(() => configure({ accessModel, priceKopecks })).toThrow("COURSE_PRICE_INVALID");
    expect(db.prepare("SELECT count(*) n FROM products").get()).toEqual({ n: 0 });
  });
  it("rejects stale versions and keeps product/offer identity and explicit purpose", () => {
    const first = configure();
    db.prepare("UPDATE offers SET payment_purpose='Explicit merchant purpose'").run();
    expect(() => configure({ commandKey: "different-command-01" })).toThrow("CATALOG_VERSION_CONFLICT");
    const second = configure({ accessModel: "PAID", priceKopecks: 100, expectedVersion: 1, commandKey: "different-command-02" });
    expect(second).toMatchObject({ ...first, version: 2, accessModel: "PAID", priceKopecks: 100 });
    expect(db.prepare("SELECT payment_purpose FROM offers").get()).toEqual({ payment_purpose: "Explicit merchant purpose" });
  });
  it("does not modify withdrawn products or allow command keys to be reused for different facts", () => {
    const first = configure();
    withdrawProduct(db, { productRef: first.productRef, expectedVersion: 1, actor: "owner", reason: "test", termsRef: "terms" });
    expect(() => configure({ expectedVersion: 2, commandKey: "different-command-01" })).toThrow("WITHDRAWN_PRODUCT_IMMUTABLE");
  });
  it("preserves verified free enrollment across FREE→PAID, but not access for new users", () => {
    playable(); expect(access({ recordFreeEnrollment: true }).decision).toBe("ALLOW");
    expect(access({ recordFreeEnrollment: true }).decision).toBe("ALLOW");
    expect(db.prepare("SELECT count(*) n FROM free_course_enrollments").get()).toEqual({ n: 1 });
    configure({ accessModel: "PAID", priceKopecks: 100, expectedVersion: 1, commandKey: "different-command-01" });
    expect(access().decision).toBe("ALLOW"); expect(access().paidEntitled).toBe(false);
    expect(access({ customerId: "new" }).decision).toBe("NOT_FOR_SALE");
    expect(listCustomerLibrary(db, "c", now).courses[0].access).toBe("FREE");
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: 0 });
  });
  it.each(["stale", "unlisted", "withdrawn"])("retained free enrollment does not bypass %s", condition => {
    playable(); access({ recordFreeEnrollment: true });
    configure({ accessModel: "PAID", priceKopecks: 100, expectedVersion: 1, commandKey: "different-command-01" });
    if (condition === "stale") db.exec("UPDATE catalog_course_projection SET last_reconciled_at='2020-01-01'");
    if (condition === "unlisted") db.exec("UPDATE catalog_lesson_projection SET visibility='UNLISTED'");
    if (condition === "withdrawn") withdrawProduct(db, { productRef: "course:one", expectedVersion: 2, actor: "owner", reason: "test", termsRef: "terms" });
    expect(access().decision).toBe("DENY"); expect(listCustomerLibrary(db, "c", now).courses).toEqual([]);
  });
  it("does not enroll guests, missing videos, denied lessons, paid previews or read-only library visits", () => {
    playable(); listCustomerLibrary(db, "c", now); access({ customerId: "new", recordFreeEnrollment: true });
    db.exec("DELETE FROM lesson_video_bindings"); access({ recordFreeEnrollment: true });
    expect(db.prepare("SELECT count(*) n FROM free_course_enrollments").get()).toEqual({ n: 0 });
    expect(() => db.prepare(`INSERT INTO free_course_enrollments VALUES ('new',(SELECT id FROM products),1,'now')`).run()).toThrow("FREE_ENROLLMENT_AUTHORITY_INVALID");
  });
  it("blocks ambiguous historical free access through every commercial writer rather than inventing a grant", () => {
    playable(); db.exec("INSERT INTO playback_access_events(customer_id,lesson_ref,event_type,reason,occurred_at) VALUES ('c','lesson','GRANT_ALLOWED','OPEN','now')");
    expect(() => configure({ accessModel: "PAID", priceKopecks: 100, expectedVersion: 1, commandKey: "different-command-01" })).toThrow("FREE_ACCESS_HISTORY_REQUIRES_RECONCILIATION");
    expect(() => configureProduct(db, config, { productRef: "course:one", offerRef: "course:one", kind: "ONLINE_COURSE", courseRef: "one",
      accessModel: "PAID", priceKopecks: 100, saleMode: "CLOSED", actor: "control-room", expectedVersion: 1 })).toThrow("FREE_ACCESS_HISTORY_REQUIRES_RECONCILIATION");
    expect(db.prepare("SELECT access_model,version FROM products").get()).toEqual({ access_model: "FREE", version: 1 });
  });
  it("enrollment does not bypass restrictive overrides and cannot be rewritten", () => {
    playable(); access({ recordFreeEnrollment: true });
    expect(() => db.exec("UPDATE free_course_enrollments SET product_version=999")).toThrow("FREE_ENROLLMENT_IMMUTABLE");
    db.exec(`INSERT INTO access_overrides(operation_id,course_ref,scope_level,scope_ref,expected_kind,expected_value,deadline_at,platform_epoch)
      VALUES ('operation','one','COURSE','one','EFFECTIVE_VISIBILITY','UNLISTED','2026-10-12','synthetic-epoch')`);
    expect(access().decision).toBe("DENY");
  });
  it("never converts paid preview eligibility into retained free enrollment", () => {
    playable(); configure({ accessModel: "PAID", priceKopecks: 100, expectedVersion: 1, commandKey: "different-command-01" });
    db.exec("UPDATE catalog_lesson_projection SET free_preview=1");
    expect(access({ recordFreeEnrollment: true }).decision).toBe("ALLOW");
    expect(db.prepare("SELECT count(*) n FROM free_course_enrollments").get()).toEqual({ n: 0 });
  });
  it("does not claim cache refresh when no invalidator is configured", async () => {
    const server = createCommerceV2App({ db, config, sourceCommit: "a".repeat(40), serviceToken: "synthetic-service-token" });
    const result = await server.request("/v1/internal/catalog/courses/one/commercial", { method: "POST",
      headers: { authorization: "Bearer synthetic-service-token", "content-type": "application/json" }, body: JSON.stringify(command) });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ version: 1, cacheRefresh: "PENDING", saleMode: "CLOSED" });
  });
  it("requires service authority and reports committed state despite cache failure", async () => {
    const server = createCommerceV2App({ db, config, sourceCommit: "a".repeat(40), serviceToken: "synthetic-service-token",
      invalidatePlatformCache: async () => { throw new Error("secret exception"); } });
    const path = "/v1/internal/catalog/courses/one/commercial";
    expect((await server.request(path, { method: "POST", body: JSON.stringify(command) })).status).toBe(401);
    const result = await server.request(path, { method: "POST", headers: { authorization: "Bearer synthetic-service-token", "content-type": "application/json" }, body: JSON.stringify({ ...command, courseRef: "foreign", saleMode: "PUBLIC" }) });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ version: 1, cacheRefresh: "PENDING", saleMode: "CLOSED" });
    expect(db.prepare("SELECT course_ref FROM products").get()).toEqual({ course_ref: "one" });
  });
});
