import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthRuntime } from "../src/auth";
import { migrateV2 } from "../src/db";
import { activateLegalRelease } from "../src/legal-control";
import { applyCourseManifest, withManifestHash } from "../src/manifest";
import { resolvePlaybackAccess } from "../src/playback-access";
import { stageALegalManifest } from "./fixtures/legal";

// Disposable fixture ONLY. Neither these refs nor this synthetic legal release are approved
// launch material. Better Auth/session/SQLite/access are real; external mail/video remain untested.
let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db); });
afterEach(() => db.close());
const origins = {
  NODE_ENV: "test", BETTER_AUTH_SECRET: "isolated-stage-a-auth-secret-32-characters",
  PLATFORM_ORIGIN: "https://canary-platform.flexperiment.ru",
  LAB_ORIGIN: "https://canary-lab.flexperiment.ru",
  ADMIN_ORIGIN: "https://canary-admin.flexperiment.ru",
  API_ORIGIN: "https://canary-api.flexperiment.ru",
};
const consent = {
  email: "stage-a-student@example.test", storefront: "COURSES" as const, personalDataConsent: true,
  personalDataVersion: "personal_data-v1", personalDataSha256: "a".repeat(64),
  accountTermsVersion: "account_terms-v1", accountTermsSha256: "a".repeat(64),
  // No marketing opt-in: default false must not block free access.
  marketingDocumentVersion: "marketing_consent-v1", marketingDocumentSha256: "a".repeat(64),
};

describe("Stage A auth → FREE access isolated preparation", () => {
  it("blocks absent legal admission before customer/outbox creation", async () => {
    const send = vi.fn();
    const runtime = createAuthRuntime({ db, environment: origins, sendMagicLinkEmail: send });
    await runtime.auth.$context;
    expect(() => runtime.prepareMagicLinkInitiation(consent)).toThrow("LEGAL_RELEASE_NOT_FOUND");
    expect(db.prepare("SELECT COUNT(*) AS n FROM customers").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_email_outbox").get()).toEqual({ n: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("verifies email, keeps host-only secure session, permits FREE without paid grant and revokes on logout", async () => {
    activateLegalRelease(db, { storefront: "COURSES", version: "isolated-fixture-only", manifest: stageALegalManifest, actor: "isolated-test" });
    let link = "";
    const send = vi.fn(async ({ url }: { url: string }) => { link = url; });
    const runtime = createAuthRuntime({ db, environment: origins, sendMagicLinkEmail: send });
    expect(await runtime.authenticateCustomer(new Headers())).toBeNull();
    runtime.prepareMagicLinkInitiation(consent);
    const requested = await runtime.auth.handler(new Request(`${origins.API_ORIGIN}/v1/auth/sign-in/magic-link`, {
      method: "POST", headers: { "content-type": "application/json", origin: origins.PLATFORM_ORIGIN },
      body: JSON.stringify({ email: consent.email, callbackURL: `${origins.PLATFORM_ORIGIN}/courses`, metadata: { storefront: "COURSES" } }),
    }));
    expect(requested.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(new URL(link).origin).toBe(origins.PLATFORM_ORIGIN);
    expect(db.prepare("SELECT auth_user_id FROM customers").get()).toEqual({ auth_user_id: null });
    expect(db.prepare("SELECT granted FROM marketing_consents").get()).toEqual({ granted: 0 });

    const verified = await runtime.auth.handler(new Request(link, { headers: { origin: origins.PLATFORM_ORIGIN }, redirect: "manual" }));
    expect(verified.status).toBe(302);
    const cookies = verified.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith("__Secure-better-auth.session_token="));
    expect(session).toBeDefined();
    expect(session).toMatch(/; Secure/i);
    expect(session).toMatch(/; HttpOnly/i);
    expect(session).toMatch(/; SameSite=Lax/i);
    expect(cookies.some((cookie) => /;\s*Domain=/i.test(cookie))).toBe(false);
    const headers = new Headers({ cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "), origin: origins.PLATFORM_ORIGIN });
    const customerId = await runtime.authenticateCustomer(headers);
    expect(customerId).toBeTruthy();
    expect(db.prepare('SELECT email_verified FROM "user"').get()).toEqual({ email_verified: 1 });
    expect(await runtime.authenticateCustomer(headers)).toBe(customerId);

    const now = new Date();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('isolated-free','isolated-free','ONLINE_COURSE','FREE','isolated-course')`).run();
    applyCourseManifest(db, withManifestHash({
      courseRef: "isolated-course", version: 1, visibility: "LISTED", operations: [],
      sections: [{ sectionRef: "isolated-section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "isolated-lesson", sectionRef: "isolated-section", everPublished: true, visibility: "LISTED", freePreview: false }],
    }), now.toISOString());
    const access = { customerId: customerId!, lessonRef: "isolated-lesson", now, leaseMs: 60_000 };
    expect(resolvePlaybackAccess(db, access).decision).toBe("ALLOW");
    expect(resolvePlaybackAccess(db, { ...access, lessonRef: "unknown" }).decision).toBe("DENY");
    expect(resolvePlaybackAccess(db, { ...access, now: new Date(now.getTime() + 60_001) }).decision).toBe("DENY");
    db.prepare("UPDATE catalog_lesson_projection SET visibility='UNLISTED'").run();
    expect(resolvePlaybackAccess(db, access).decision).toBe("DENY");
    for (const table of ["orders", "checkout_attempts", "course_entitlements", "refund_requests"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }

    const logout = await runtime.auth.handler(new Request(`${origins.API_ORIGIN}/v1/auth/sign-out`, { method: "POST", headers }));
    expect(logout.status).toBe(200);
    expect(await runtime.authenticateCustomer(headers)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 0 });
  });
});
