import Database from "better-sqlite3";
import { serve } from "@hono/node-server";
import { scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { canonicalIp, controlRoomClientIp, controlRoomTrustedProxyIps } from "../src/control-room-client-ip";
import { consumeControlRoomLoginLimits } from "../src/control-room-auth";
import { migrateV2 } from "../src/db";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";

let db: Database.Database;
const password = "synthetic-owner-password";
const salt = Buffer.alloc(16, 1);
const passwordScrypt = ["scrypt", "v1", "16384", "8", "1", salt.toString("base64url"),
  scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")].join(":");
const auth = { origin: "https://admin.flexperiment.ru", passwordScrypt, sessionSecret: "synthetic-login-secret", trustedProxyIps: ["127.0.0.1"] };
const epoch = new Date("2026-10-18T00:00:00Z");
const makeApp = (peer: string | undefined = "127.0.0.1", realSocket = false, trustedProxyIps: readonly string[] = auth.trustedProxyIps) => createCommerceV2App({
  db, config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "open" }),
  sourceCommit: "a".repeat(40), serviceToken: "synthetic", controlRoomAuth: { ...auth, trustedProxyIps }, now: () => epoch,
  ...(realSocket ? {} : { controlRoomPeerAddress: () => peer }),
});
const login = (app: ReturnType<typeof makeApp>, ip: string, extra: Record<string, string> = {}, suppliedPassword = "wrong") =>
  app.request("/v1/admin/login", { method: "POST", headers: { origin: auth.origin, "content-type": "application/json", "x-real-ip": ip, ...extra },
    body: JSON.stringify({ password: suppliedPassword }) });
const consume = (source: string, now = epoch) => consumeControlRoomLoginLimits(db, { source, now, secret: auth.sessionSecret });

beforeEach(() => { db = new Database(":memory:"); migrateV2(db); });
afterEach(() => db.close());

describe("Control Room trusted login source", () => {
  it("accepts only an exact transport peer and a single valid nginx address", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.1", "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "192.0.2.2" });
    expect(controlRoomClientIp(headers, "::ffff:127.0.0.1", auth.trustedProxyIps)).toBe("203.0.113.1");
    expect(controlRoomClientIp(headers, "127.0.0.2", auth.trustedProxyIps)).toBeUndefined();
    expect(controlRoomClientIp(headers, undefined, auth.trustedProxyIps)).toBeUndefined();
    expect(controlRoomClientIp(headers, "127.0.0.1", [])).toBeUndefined();
    headers.delete("x-real-ip");
    expect(controlRoomClientIp(headers, "127.0.0.1", auth.trustedProxyIps)).toBeUndefined();
    for (const value of ["203.0.113.1, 192.0.2.1", "bad", "[::1]:80", " 203.0.113.1", "203.0.113.1/32", "fe80::1%eth0"]) {
      expect(canonicalIp(value), value).toBeUndefined();
    }
  });

  it("canonicalizes IPv6 and mapped IPv4 and refuses broad proxy configuration", () => {
    expect(canonicalIp("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonicalIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(canonicalIp("::ffff:c000:201")).toBe("192.0.2.1");
    expect(controlRoomTrustedProxyIps(undefined)).toEqual([]);
    expect(controlRoomTrustedProxyIps("127.0.0.1, ::1")).toEqual(["127.0.0.1", "::1"]);
    for (const value of ["0.0.0.0/0", "172.16.0.0/12", "coolify-proxy", "127.0.0.1,", "127.0.0.1:80"]) {
      expect(() => controlRoomTrustedProxyIps(value)).toThrow("CONTROL_ROOM_TRUSTED_PROXY_IPS_INVALID");
    }
  });

  it("rotating forged CF and XFF never changes the nginx-selected IP budget", async () => {
    const app = makeApp();
    for (let n = 1; n <= 6; n++) {
      const response = await login(app, "203.0.113.1", { "cf-connecting-ip": `192.0.2.${n}`, "x-forwarded-for": `198.51.100.${n}, 192.0.2.1` });
      expect(response.status).toBe(n <= 5 ? 401 : 429);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    // Another genuine source is independent, without requiring any CF header.
    expect((await login(app, "203.0.113.2", {}, password)).status).toBe(200);
  });

  it("blocks rotating source IPs at the singleton account cap", async () => {
    const app = makeApp();
    for (let n = 1; n <= 21; n++) expect((await login(app, `203.0.113.${n}`)).status).toBe(n <= 20 ? 401 : 429);
    expect(db.prepare("SELECT COUNT(*) n FROM control_room_admin_sessions").get()).toEqual({ n: 0 });
    const keys = db.prepare("SELECT rate_key FROM control_room_login_rate_limits").all();
    expect(JSON.stringify(keys)).not.toMatch(/203\.0\.113|synthetic-login-secret/);
    // Constructing another app over the durable database cannot reset account admission.
    expect((await login(makeApp(), "198.51.100.1", {}, password)).status).toBe(429);
  });

  it("rejects missing/untrusted socket metadata and malformed replacement headers before charging budgets", async () => {
    expect((await login(makeApp("127.0.0.1", false, []), "203.0.113.1", {}, password)).status).toBe(503);
    expect((await login(makeApp("127.0.0.2"), "203.0.113.1", {}, password)).status).toBe(403);
    expect((await login(makeApp(undefined, true), "203.0.113.1", {}, password)).status).toBe(403);
    expect((await login(makeApp(), "203.0.113.1, 198.51.100.2", {}, password)).status).toBe(403);
    const app = makeApp();
    expect((await app.request("/v1/admin/login", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "203.0.113.1" },
      body: JSON.stringify({ password }) })).status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) n FROM control_room_login_rate_limits").get()).toEqual({ n: 0 });
  });

  it("uses the real Node socket through the served HTTP adapter", async () => {
    const server = serve({ fetch: makeApp(undefined, true).fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/login`, {
        method: "POST", headers: { origin: auth.origin, "content-type": "application/json", "x-real-ip": "203.0.113.8", "cf-connecting-ip": "spoofed" },
        body: JSON.stringify({ password }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      await response.arrayBuffer();
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});

describe("atomic IP and singleton account windows", () => {
  it("retains budgets across independent SQLite connections and reopening the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-room-login-"));
    const path = join(directory, "synthetic.sqlite");
    let first: Database.Database | undefined, second: Database.Database | undefined;
    const input = { source: "203.0.113.9", secret: auth.sessionSecret, now: epoch };
    try {
      first = new Database(path); migrateV2(first);
      second = new Database(path);
      for (let n = 0; n < 5; n++) consumeControlRoomLoginLimits(n % 2 ? first : second, input);
      first.close(); first = undefined;
      expect(() => consumeControlRoomLoginLimits(second!, input)).toThrow("RATE_LIMITED");
      second.close(); second = new Database(path);
      expect(() => consumeControlRoomLoginLimits(second!, input)).toThrow("RATE_LIMITED");
    } finally { first?.close(); second?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps the daily IP cap after the shorter window rolls and rolls back partial account charges", () => {
    for (let quarter = 0; quarter < 4; quarter++) for (let n = 0; n < 5; n++) consume("203.0.113.1", new Date(+epoch + quarter * 15 * 60_000));
    const before = db.prepare("SELECT * FROM control_room_login_rate_limits ORDER BY rate_key,window_start").all();
    expect(() => consume("203.0.113.1", new Date(+epoch + 60 * 60_000))).toThrow("RATE_LIMITED");
    expect(db.prepare("SELECT * FROM control_room_login_rate_limits ORDER BY rate_key,window_start").all()).toEqual(before);
    expect(() => consume("203.0.113.1", new Date(+epoch + 24 * 60 * 60_000))).not.toThrow();
  });

  it("keeps the daily account cap across IPs and time windows without charging rejected sources", () => {
    for (let quarter = 0; quarter < 5; quarter++) for (let n = 0; n < 20; n++) consume(`203.0.113.${quarter * 20 + n}`, new Date(+epoch + quarter * 15 * 60_000));
    const before = db.prepare("SELECT * FROM control_room_login_rate_limits ORDER BY rate_key,window_start").all();
    expect(() => consume("198.51.100.1", new Date(+epoch + 75 * 60_000))).toThrow("RATE_LIMITED");
    expect(db.prepare("SELECT * FROM control_room_login_rate_limits ORDER BY rate_key,window_start").all()).toEqual(before);
    expect(() => consume("198.51.100.1", new Date(+epoch + 24 * 60 * 60_000))).not.toThrow();
  });
});
