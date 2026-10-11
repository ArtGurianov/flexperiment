import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { createCommerceV2App } from "../src/app";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { applyCourseManifest, withManifestHash } from "../src/manifest";
import { hasRequiredAccountConsents } from "../src/authenticated-consents";
import { activateLegalRelease } from "../src/legal-control";
import { resolvePlaybackAccess } from "../src/playback-access";
import { listCustomerLibrary } from "../src/library";
import { grantManualEntitlement } from "../src/entitlements";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";
import { stageALegalManifest } from "./fixtures/legal";

let db: Database.Database;
const now = new Date("2026-10-11T10:00:00Z");
const headers = { authorization: "synthetic-session", "content-type": "application/json" };
const access = { customerId: "c", lessonRef: "lesson", now, leaseMs: 60_000, recordFreeEnrollment: true };
const server = () => createCommerceV2App({ db, sourceCommit: "a".repeat(40), serviceToken: "synthetic-service",
  config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "open" }),
  authenticateCustomer: async h => h.get("authorization") === "synthetic-session" ? "c" : null, now: () => now });
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  db.exec("INSERT INTO customers(id,email_normalized) VALUES ('c','synthetic@example.test');");
  confirmSyntheticAccount(db, "c");
  db.exec("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:arbitrary','ONLINE_COURSE','FREE','course');");
  applyCourseManifest(db, withManifestHash({ courseRef: "course", version: 1, visibility: "LISTED", operations: [],
    sections: [{ sectionRef: "section", visibility: "LISTED" }],
    lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false }] }), now.toISOString());
  db.exec("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES ('lesson','synthetic-video','now','now');");
});
afterEach(() => db.close());
const denied = async () => {
  expect(hasRequiredAccountConsents(db, "c")).toBe(false);
  const before = db.prepare("SELECT COUNT(*) n FROM free_course_enrollments").get();
  expect(resolvePlaybackAccess(db, access)).toEqual({ decision: "CONSENT_REQUIRED", paidEntitled: false, resumeAt: 0 });
  expect(listCustomerLibrary(db, "c", now)).toEqual({ courses: [] });
  const app = server();
  for (const [path, method] of [["/v1/library", "GET"], ["/v1/lessons/lesson/playback", "POST"],
    ["/v1/lessons/lesson/resume", "POST"], ["/v1/lessons/lesson/resume", "PUT"]]) {
    const response = await app.request(path, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify({ seconds: 10, clientSeq: 1, clientTs: now.toISOString() }) }) });
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-video");
  }
  expect(db.prepare("SELECT COUNT(*) n FROM free_course_enrollments").get()).toEqual(before);
  for (const table of ["lesson_resume_positions", "playback_grant_rate_limits", "course_access_starts", "playback_access_events"]) {
    expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect((await app.request("/v1/me", { headers })).status).toBe(200);
  expect((await app.request("/v1/me/orders", { headers })).status).toBe(200);
  expect((await app.request("/v1/checkout", { method: "POST", headers })).status).toBe(503);
};
describe("required consent is a server access gate, not an entitlement or React check", () => {
  it.each(["intent only", "missing release", "malformed release", "new release", "unverified", "changed email", "unbound"])("fails closed for %s", async state => {
    if (state === "intent only") db.exec("DELETE FROM authenticated_consent_actions;");
    if (state === "missing release") db.exec("UPDATE legal_releases SET active=0;");
    if (state === "malformed release") db.exec("UPDATE legal_releases SET manifest_json='{}';");
    if (state === "new release") activateLegalRelease(db, { storefront: "COURSES", version: "synthetic-new-release", manifest: stageALegalManifest, actor: "isolated-test" });
    if (state === "unverified") db.exec('UPDATE "user" SET email_verified=0;');
    if (state === "changed email") db.exec('UPDATE "user" SET email=\'other@example.test\';');
    if (state === "unbound") db.exec("UPDATE customers SET auth_user_id=NULL;");
    await denied();
  });
  it.each(["manual entitlement", "retained FREE enrollment"])("does not let %s bypass the gate", async grant => {
    if (grant === "manual entitlement") grantManualEntitlement(db, { customerId: "c", scope: "COURSE", courseRef: "course",
      reason: "Synthetic", evidenceRef: "synthetic", legalTermsRef: "synthetic", actor: "isolated-test", idempotencyKey: "synthetic-manual-grant" });
    else expect(resolvePlaybackAccess(db, access).decision).toBe("ALLOW");
    db.exec("DELETE FROM authenticated_consent_actions;");
    await denied();
  });
  it("allows required-only confirmation and FREE enrollment without marketing or financial effects", async () => {
    expect(hasRequiredAccountConsents(db, "c")).toBe(true);
    expect(resolvePlaybackAccess(db, access)).toMatchObject({ decision: "ALLOW", binding: { videoId: "synthetic-video" } });
    expect((await server().request("/v1/library", { headers })).status).toBe(200);
    expect(db.prepare("SELECT granted FROM authenticated_consent_events WHERE kind='marketing_consent'").get()).toEqual({ granted: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM free_course_enrollments").get()).toEqual({ n: 1 });
    for (const table of ["orders", "checkout_attempts", "refund_requests", "course_entitlements"]) expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  });
});
