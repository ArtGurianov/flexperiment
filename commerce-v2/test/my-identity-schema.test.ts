import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { verificationSubjectEmail } from "../src/my-session-storage";
import { cleanupOfflinePersonalData, type RetentionPolicy } from "../src/pd-retention";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";

// FLEX-120/121 (B) schema: audience default, cascades and the retention classification of OTP rows.
const now = new Date("2026-10-11T15:00:00.000Z");
const old = "2026-10-01T12:00:00.000Z";
const future = "2027-01-01T00:00:00.000Z";
const policy: RetentionPolicy = { version: 1, referenceSha256: "a".repeat(64), expiredCredentialsGraceSeconds: 600,
  authOutboxMaxAgeSeconds: 3600, playbackTelemetryMaxAgeSeconds: 7200, unboundIntentsMaxAgeSeconds: 86400, backupArchiveMaxAgeSeconds: 86400 };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const tx = (name: string) => name.padEnd(22, "0").slice(0, 22);
let db: Database.Database;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
const session = (id: string, expiresAt = future, audience: string | null = "MY") =>
  db.prepare('INSERT INTO "session"(id,expires_at,token,user_id,audience) VALUES (?,?,?,?,?)').run(id, expiresAt, `token-${id}`, "synthetic-user-buyer", audience);
const issued = (id: string, sessionId: string, expiresAt = future) =>
  db.prepare(`INSERT INTO session_exchanges(id,audience,return_path,state_sha256,status,my_session_id,customer_id,code_sha256,
    code_expires_at,created_at,expires_at,issued_at) VALUES (?,'LMS','/courses/x',?,'ISSUED',?,'buyer',?,?,?,?,?)`)
    .run(tx(id), sha(`state-${id}`), sessionId, sha(`code-${id}`), expiresAt, old, expiresAt, old);
const lms = (id: string, sessionId: string, exchange: string, expiresAt = future) => {
  db.prepare("UPDATE session_exchanges SET status='REDEEMED',closed_at=? WHERE id=?").run(old, tx(exchange));
  db.prepare("INSERT INTO lms_sessions(id,token_sha256,parent_session_id,customer_id,exchange_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, sha(id), sessionId, "buyer", tx(exchange), old, expiresAt);
};

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  db.exec("INSERT INTO customers(id,email_normalized) VALUES ('buyer','buyer@example.test')");
  confirmSyntheticAccount(db, "buyer");
});
afterEach(() => db.close());

describe("MY identity schema", () => {
  it("keeps existing sessions LEGACY and refuses any audience other than MY", () => {
    db.prepare('INSERT INTO "session"(id,expires_at,token,user_id) VALUES (?,?,?,?)').run("legacy", future, "token-legacy", "synthetic-user-buyer");
    expect(db.prepare('SELECT audience FROM "session" WHERE id=?').get("legacy")).toEqual({ audience: null });
    expect(() => session("lms-audience", future, "LMS")).toThrow(/CHECK/);
  });

  it("signing out of MY removes its exchanges and derived LMS sessions", () => {
    session("my"); issued("a", "my"); lms("lms-a", "my", "a"); issued("b", "my");
    session("other"); issued("c", "other"); lms("lms-c", "other", "c");
    db.prepare('DELETE FROM "session" WHERE id=?').run("my");
    expect(db.prepare("SELECT id FROM lms_sessions").all()).toEqual([{ id: "lms-c" }]);
    expect(db.prepare("SELECT id FROM session_exchanges").all()).toEqual([{ id: tx("c") }]);
  });

  it("refuses an issued exchange without binding and an LMS session without an exchange", () => {
    expect(() => db.prepare(`INSERT INTO session_exchanges(id,audience,return_path,state_sha256,status,created_at,expires_at)
      VALUES (?,'LMS','/x',?,'ISSUED',?,?)`).run(tx("bad"), sha("s"), old, future)).toThrow(/CHECK/);
    session("my");
    expect(() => db.prepare("INSERT INTO lms_sessions(id,token_sha256,parent_session_id,customer_id,exchange_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
      .run("orphan", sha("orphan"), "my", "buyer", tx("missing"), old, future)).toThrow(/FOREIGN KEY/);
  });

  it("classifies only exact OTP and magic-link verification shapes", () => {
    expect(verificationSubjectEmail({ identifier: "sign-in-otp-Buyer@Example.test", value: `${"A".repeat(43)}:3` })).toBe("buyer@example.test");
    expect(verificationSubjectEmail({ identifier: "hash", value: JSON.stringify({ email: "buyer@example.test" }) })).toBe("buyer@example.test");
    for (const row of [{ identifier: "sign-in-otp-buyer@example.test", value: "123456:0" },
      { identifier: "one-time-token:abc", value: "raw-session-token" },
      { identifier: "email-verification-otp-buyer@example.test", value: `${"A".repeat(43)}:0` }]) expect(verificationSubjectEmail(row)).toBeNull();
  });

  it("retention removes expired OTP rows, deliveries, exchanges and LMS sessions but still refuses unknown rows", () => {
    db.prepare("INSERT INTO verification(id,identifier,value,expires_at) VALUES (?,?,?,?)").run("otp", "sign-in-otp-buyer@example.test", `${"A".repeat(43)}:0`, old);
    db.prepare("INSERT INTO my_otp_outbox(id,recipient_normalized,state,created_at,updated_at) VALUES ('delivery','buyer@example.test','SENT',?,?)").run(old, old);
    session("expired", old); issued("old", "expired", old); lms("lms-old", "expired", "old", old);
    session("live"); issued("live", "live"); lms("lms-live", "live", "live");
    const result = cleanupOfflinePersonalData(db, { mode: "STOPPED_OFFLINE", policy, holds: [] }, now);
    expect(result).toMatchObject({ authOutbox: 1 });
    expect([count("verification"), count("my_otp_outbox"), count("lms_sessions"), count("session_exchanges")]).toEqual([0, 0, 1, 1]);
    db.prepare("INSERT INTO verification(id,identifier,value,expires_at) VALUES (?,?,?,?)").run("ott", "one-time-token:abc", "raw-session-token", old);
    expect(() => cleanupOfflinePersonalData(db, { mode: "STOPPED_OFFLINE", policy, holds: [] }, now)).toThrow("RETENTION_VERIFICATION_CLASSIFICATION_REQUIRED");
  });
});
