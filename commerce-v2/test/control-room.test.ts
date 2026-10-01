import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { controlRoomAudit, controlRoomEmailOperations, controlRoomIncidents, controlRoomIntegrationSummary } from "../src/control-room";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";

let db: Database.Database;
const now = "2026-09-30T12:00:00.000Z";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
});

describe("Control Room operational projections", () => {
  it("exposes auth-email delivery metadata without the encrypted payload", () => {
    db.prepare(`INSERT INTO auth_email_outbox
      (id,recipient_normalized,kind,encrypted_payload,payload_sha256,state,attempt_count,last_error,created_at,updated_at)
      VALUES ('mail','student@example.test','MAGIC_LINK','ciphertext','${"a".repeat(64)}','FAILED',2,'SMTP_DOWN',?,?)`).run(now, now);

    const result = controlRoomEmailOperations(db, now);
    expect(result.authEmails[0]).toEqual({ id: "mail", recipient: "student@example.test", state: "FAILED", attemptCount: 2,
      lastError: "SMTP_DOWN", createdAt: now, updatedAt: now });
    expect(JSON.stringify(result)).not.toContain("ciphertext");
  });

  it("derives actionable incidents and merges typed audit evidence", () => {
    db.prepare(`INSERT INTO auth_email_outbox
      (id,recipient_normalized,kind,encrypted_payload,payload_sha256,state,attempt_count,last_error,created_at,updated_at)
      VALUES ('mail','student@example.test','MAGIC_LINK','ciphertext','${"a".repeat(64)}','FAILED',1,'SMTP_DOWN',?,?)`).run(now, now);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES ('merchant','operator','PRODUCT_CONFIGURED','PRODUCT','course:one','{"version":2}',?)`).run(now);
    db.prepare(`INSERT INTO control_room_audit_log(id,admin_id,action,entity_type,entity_id,details_json,created_at)
      VALUES ('session','singleton-admin','SESSION_CREATED','admin_session','sid','{}',?)`).run(now);

    expect(controlRoomIncidents(db, now).incidents).toEqual([expect.objectContaining({
      kind: "AUTH_EMAIL", severity: "FAILED", subjectRef: "student@example.test", code: "SMTP_DOWN",
    })]);
    expect(controlRoomAudit(db, now).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "MERCHANT", actor: "operator", details: { version: 2 } }),
      expect.objectContaining({ source: "CONTROL_ROOM", actor: "singleton-admin", details: {} }),
    ]));
  });

  it("summarizes recent abnormal playback access without exposing tokens", () => {
    db.prepare(`INSERT INTO playback_access_events(customer_id,lesson_ref,video_id,event_type,reason,occurred_at)
      VALUES ('customer','lesson','video','GRANT_ALLOWED','PROTECTED',?),
      ('customer','lesson','video','GRANT_DENIED','DENY',?),
      ('customer','lesson','video','GRANT_RATE_LIMITED','PER_CUSTOMER_MINUTE_LIMIT',?),
      (NULL,NULL,'video','DRM_TOKEN_INVALID','PLAYBACK_TOKEN_EXPIRED',?),
      ('customer','lesson','video','GRANT_DENIED','OLD',?)`)
      .run(now, now, now, now, "2026-09-28T12:00:00.000Z");

    const summary = controlRoomIntegrationSummary(
      db,
      loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "disabled", MERCHANT_PROMOTION_PREFIX: "FX-" }),
      new Date(now),
    );
    expect(summary.playbackAccess24h).toEqual({ allowed: 1, denied: 1, rateLimited: 1, invalidToken: 1 });
    expect(JSON.stringify(summary)).not.toContain("playback-secret");
  });
});
