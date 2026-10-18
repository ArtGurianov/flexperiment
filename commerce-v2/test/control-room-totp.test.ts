import Database from "better-sqlite3";
import { scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import {
  acceptControlRoomTotp, base32Encode, controlRoomTotpKey, enrollControlRoomTotp, hotp, resetControlRoomTotp, totp, totpStep,
} from "../src/control-room-totp";
import { migrateV2 } from "../src/db";
import { runOwnerCommand } from "../src/owner-cli";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { base32Decode, testTotpKey } from "./fixtures/control-room-totp";

let db: Database.Database;
const at = new Date("2026-10-18T12:00:10.000Z");
const later = (steps: number) => new Date(at.getTime() + steps * 30_000);

beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db); });
afterEach(() => db.close());

const enrolled = () => {
  const seed = base32Decode(enrollControlRoomTotp(db, testTotpKey, at).secret);
  expect(acceptControlRoomTotp(db, testTotpKey, totp(seed, at), at, { confirming: true })).toBe(true);
  return seed;
};

describe("RFC 6238 / RFC 4648", () => {
  // RFC 6238 Appendix B, SHA-1, 8 digits; the seed is the ASCII "12345678901234567890".
  it.each([
    [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
  ])("matches the published vector at T=%i", (seconds, code) => {
    expect(totp(Buffer.from("12345678901234567890"), new Date(seconds * 1000), 8)).toBe(code);
  });

  it("matches the RFC 4226 HOTP vectors at six digits", () => {
    expect(Array.from({ length: 10 }, (_, counter) => hotp(Buffer.from("12345678901234567890"), counter))).toEqual(
      ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]);
  });

  it("encodes base32 as RFC 4648 without padding", () => {
    expect(["", "f", "fo", "foo", "foob", "fooba", "foobar"].map((text) => base32Encode(Buffer.from(text))))
      .toEqual(["", "MY", "MZXQ", "MZXW6", "MZXW6YQ", "MZXW6YTB", "MZXW6YTBOI"]);
  });

  it("accepts only an exact 32-byte base64url key", () => {
    expect(controlRoomTotpKey(undefined)).toBeUndefined();
    expect(controlRoomTotpKey(testTotpKey.toString("base64url"))).toEqual(testTotpKey);
    for (const value of [Buffer.alloc(16).toString("base64url"), testTotpKey.toString("base64"), "not-a-key", `${testTotpKey.toString("base64url")}=`]) {
      expect(() => controlRoomTotpKey(value), value).toThrow("CONTROL_ROOM_TOTP_KEY_INVALID");
    }
  });
});

describe("stored second factor", () => {
  it("stores the seed only encrypted and bound to the admin id", () => {
    const { secret } = enrollControlRoomTotp(db, testTotpKey, at);
    const stored = (db.prepare("SELECT seed_ciphertext FROM control_room_totp").get() as { seed_ciphertext: string }).seed_ciphertext;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(base32Decode(secret).toString("base64url"));
    const code = totp(base32Decode(secret), at);
    expect(() => acceptControlRoomTotp(db, Buffer.alloc(32, 1), code, at, { confirming: true })).toThrow("CONTROL_ROOM_TOTP_SEED_INVALID");
    db.prepare("UPDATE control_room_totp SET admin_id='someone-else'").run();
    expect(() => acceptControlRoomTotp(db, testTotpKey, code, at, { confirming: true }, "someone-else")).toThrow("CONTROL_ROOM_TOTP_SEED_INVALID");
  });

  it("accepts each code once, never an earlier step, within one step of drift", () => {
    const seed = enrolled();
    expect(acceptControlRoomTotp(db, testTotpKey, totp(seed, later(1)), later(1))).toBe(true);
    expect(acceptControlRoomTotp(db, testTotpKey, totp(seed, later(1)), later(1))).toBe(false); // replay
    expect(acceptControlRoomTotp(db, testTotpKey, totp(seed, later(0)), later(1))).toBe(false); // older step, in window
    expect(acceptControlRoomTotp(db, testTotpKey, totp(seed, later(3)), later(2))).toBe(true);  // one step ahead
    expect(acceptControlRoomTotp(db, testTotpKey, totp(seed, later(7)), later(5))).toBe(false); // two ahead
    expect(acceptControlRoomTotp(db, testTotpKey, totp(seed, later(4)), later(6))).toBe(false); // two behind
    for (const code of ["", "12345", "1234567", " 123456", "12345a", 123456, null]) {
      expect(acceptControlRoomTotp(db, testTotpKey, code, later(9)), String(code)).toBe(false);
    }
    expect((db.prepare("SELECT last_accepted_step FROM control_room_totp").get() as { last_accepted_step: number }).last_accepted_step)
      .toBe(totpStep(later(3)));
  });

  it("lets only one of two connections spend the same code", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-room-totp-"));
    const first = new Database(join(directory, "c.sqlite")); migrateV2(first);
    const second = new Database(join(directory, "c.sqlite"));
    try {
      const seed = base32Decode(enrollControlRoomTotp(first, testTotpKey, at).secret);
      expect(acceptControlRoomTotp(second, testTotpKey, totp(seed, at), at, { confirming: true })).toBe(true);
      const results = [first, second].map((connection) => acceptControlRoomTotp(connection, testTotpKey, totp(seed, later(1)), later(1)));
      expect(results).toEqual([true, false]);
    } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("separates enrollment from login and refuses re-enrollment over a confirmed factor", () => {
    const { secret } = enrollControlRoomTotp(db, testTotpKey, at);
    const seed = base32Decode(secret);
    expect(() => acceptControlRoomTotp(db, testTotpKey, totp(seed, at), at)).toThrow("CONTROL_ROOM_TOTP_NOT_ENROLLED");
    expect(acceptControlRoomTotp(db, testTotpKey, totp(seed, at), at, { confirming: true })).toBe(true);
    expect(() => acceptControlRoomTotp(db, testTotpKey, totp(seed, later(1)), later(1), { confirming: true })).toThrow("CONTROL_ROOM_TOTP_ALREADY_ENROLLED");
    expect(() => enrollControlRoomTotp(db, testTotpKey, at)).toThrow("CONTROL_ROOM_TOTP_ALREADY_ENROLLED");
    expect(resetControlRoomTotp(db, at)).toEqual({ totpRemoved: true, sessionsRevoked: 0 });
    expect(() => acceptControlRoomTotp(db, testTotpKey, totp(seed, later(2)), later(2))).toThrow("CONTROL_ROOM_TOTP_NOT_ENROLLED");
  });
});

describe("Control Room login with TOTP", () => {
  const password = "synthetic-owner-password";
  const salt = Buffer.alloc(16, 4);
  const passwordScrypt = ["scrypt", "v1", "16384", "8", "1", salt.toString("base64url"),
    scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")].join(":");
  let clock = at;
  const app = (totpKey: Buffer | null = testTotpKey) => createCommerceV2App({
    db, config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "open" }),
    sourceCommit: "a".repeat(40), serviceToken: "synthetic", now: () => clock, controlRoomPeerAddress: () => "127.0.0.1",
    controlRoomLoginWait: async () => {},
    controlRoomAuth: { origin: "https://admin.flexperiment.ru", passwordScrypt, sessionSecret: "synthetic-totp-secret", trustedProxyIps: ["127.0.0.1"], totpKey: totpKey ?? undefined },
  });
  const login = (body: Record<string, unknown>, ip = "203.0.113.1", server = app()) => server.request("/v1/admin/login", {
    method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
  const sessions = () => (db.prepare("SELECT COUNT(*) AS n FROM control_room_admin_sessions").get() as { n: number }).n;
  beforeEach(() => { clock = later(2); });

  it("requires the current code with the password, and spends it", async () => {
    const seed = enrolled();
    expect((await login({ password })).status).toBe(401);
    expect((await login({ password, code: totp(seed, later(-5)) })).status).toBe(401);
    expect(sessions()).toBe(0);
    const code = totp(seed, clock);
    expect((await login({ password, code })).status).toBe(200);
    clock = later(3); // the spent code is still inside the drift window, and still refused
    expect((await login({ password, code }, "203.0.113.2")).status).toBe(401);
    expect(sessions()).toBe(1);
  });

  it("does not let a wrong password spend or probe a code", async () => {
    const seed = enrolled();
    for (let n = 0; n < 4; n++) expect((await login({ password: "wrong", code: totp(seed, clock) }, `203.0.113.${n + 1}`)).status).toBe(401);
    expect((await login({ password, code: totp(seed, clock) }, "198.51.100.1")).status).toBe(200);
  });

  it("allows only three code checks per step for a known password", async () => {
    const seed = enrolled();
    for (let n = 0; n < 3; n++) expect((await login({ password, code: "000000" }, `203.0.113.${n + 1}`)).status).toBe(401);
    const blocked = await login({ password, code: totp(seed, clock) }, "198.51.100.1");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: { code: "RATE_LIMITED" } });
    clock = later(3);
    expect((await login({ password, code: totp(seed, clock) }, "198.51.100.2")).status).toBe(200);
  });

  it("fails closed without a key or a confirmed factor", async () => {
    expect((await login({ password, code: "123456" }, "203.0.113.1", app(null))).status).toBe(503);
    enrollControlRoomTotp(db, testTotpKey, at);
    const pending = await login({ password, code: "123456" });
    expect(pending.status).toBe(403);
    expect(await pending.json()).toEqual({ error: { code: "CONTROL_ROOM_TOTP_NOT_ENROLLED" } });
    expect(sessions()).toBe(0);
  });

  it("does not spend the code when the session cannot be written", async () => {
    const seed = enrolled();
    db.exec("CREATE TRIGGER reject_session BEFORE INSERT ON control_room_admin_sessions BEGIN SELECT RAISE(ABORT,'SESSION_STORE_UNAVAILABLE'); END");
    const code = totp(seed, clock);
    expect((await login({ password, code })).status).toBe(400);
    db.exec("DROP TRIGGER reject_session");
    expect((await login({ password, code }, "203.0.113.2")).status).toBe(200);
  });
});

describe("owner recovery over SSH", () => {
  const environment = { CONTROL_ROOM_TOTP_KEY: testTotpKey.toString("base64url") };
  const run = (argv: string[], input?: unknown, now = at.toISOString()) => runOwnerCommand(db, argv, input, environment, now);
  const audit = () => db.prepare("SELECT action,details_json FROM control_room_audit_log ORDER BY rowid").all() as Array<{ action: string; details_json: string }>;

  it("enrolls, confirms with a code, and revokes sessions opened before the factor", () => {
    db.prepare("INSERT INTO control_room_admin_sessions(id,admin_id,expires_at,created_at) VALUES ('old','singleton-admin','2027-01-01','2026-10-18')").run();
    const enrollment = run(["totp", "enroll", "--actor", "art"]) as { secret: string; otpauthUri: string };
    expect(enrollment.otpauthUri).toBe(`otpauth://totp/Flexperiment:Control%20Room?secret=${enrollment.secret}&issuer=Flexperiment&algorithm=SHA1&digits=6&period=30`);
    expect(() => run(["totp", "confirm", "--actor", "art"], { code: "000000" })).toThrow("CONTROL_ROOM_TOTP_CODE_INVALID");
    expect(run(["totp", "confirm", "--actor", "art"], { code: totp(base32Decode(enrollment.secret), at) })).toEqual({ confirmed: true, sessionsRevoked: 1 });
    expect(audit().map(({ action }) => action)).toEqual(["TOTP_ENROLLMENT_STARTED", "TOTP_ENROLLED"]);
    expect(JSON.stringify(audit())).not.toContain(enrollment.secret);
    expect(() => run(["totp", "enroll", "--actor", "art"])).toThrow("CONTROL_ROOM_TOTP_ALREADY_ENROLLED");
  });

  it("resets the factor and every session, audited, so only a new enrollment opens the room", () => {
    enrolled();
    db.prepare("INSERT INTO control_room_admin_sessions(id,admin_id,expires_at,created_at) VALUES ('live','singleton-admin','2027-01-01','2026-10-18')").run();
    expect(run(["totp", "reset", "--actor", "art"])).toEqual({ totpRemoved: true, sessionsRevoked: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM control_room_totp").get()).toEqual({ n: 0 });
    expect(run(["session", "revoke-all", "--actor", "art"])).toEqual({ sessionsRevoked: 0 });
    expect(audit().map(({ action }) => action)).toEqual(["TOTP_RESET", "SESSIONS_REVOKED"]);
  });

  it("refuses without the key and without an actor", () => {
    expect(() => runOwnerCommand(db, ["totp", "enroll", "--actor", "art"], undefined, {}, at.toISOString())).toThrow("CONTROL_ROOM_TOTP_NOT_CONFIGURED");
    expect(() => run(["totp", "reset"])).toThrow("OWNER_COMMAND_ACTOR_REQUIRED");
    expect(db.prepare("SELECT COUNT(*) AS n FROM control_room_audit_log").get()).toEqual({ n: 0 });
  });
});
