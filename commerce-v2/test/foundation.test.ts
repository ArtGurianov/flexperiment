import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCommerceV2App } from "../src/app";
import { migrateV2, openV2Database } from "../src/db";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { createRefrefReadinessProbe } from "../src/readiness";
import { backupFoundation, markDurability, verifyDurability } from "../src/foundation-storage";

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.open) db.close(); });
const database = (path = ":memory:") => { const db = openV2Database(path); opened.push(db); migrateV2(db); return db; };
const sha = "a".repeat(40);
const payload = { service: "refref-runtime", status: "READY", sourceCommit: sha, checks: { database: true, redis: true } };
const env = { DEPLOY_ENV: "production", REFREF_READINESS_URL: "https://ops.refref.ru/readyz" };

describe("bounded read-only Refref readiness", () => {
  it("uses only the unauthenticated ops GET, bounded timeout and no redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload)));
    expect(await createRefrefReadinessProbe(env, fetcher)()).toBe("ready");
    const [, options] = fetcher.mock.calls[0];
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: { accept: "application/json" } });
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["https://evil.invalid/readyz", "https://ops.refref.ru.evil.invalid/readyz", "https://ops.refref.ru/readyz?x=1", "https://u:p@ops.refref.ru/readyz", "https://ops.refref.ru:443/readyz"])("refuses unqualified target %s", (url) => {
    expect(() => createRefrefReadinessProbe({ ...env, REFREF_READINESS_URL: url })).toThrow("REFREF_READINESS_URL_NOT_ALLOWED");
  });
  it("requires explicit URL and isolates canary/production", () => {
    expect(() => createRefrefReadinessProbe({ DEPLOY_ENV: "production" })).toThrow("REFREF_READINESS_URL_REQUIRED");
    expect(() => createRefrefReadinessProbe({ ...env, DEPLOY_ENV: "staging" })).toThrow();
    expect(() => createRefrefReadinessProbe({ DEPLOY_ENV: "staging", REFREF_READINESS_URL: "https://canary-ops.refref.ru/readyz" })).not.toThrow();
  });
  it.each([
    [503, payload], [200, { ...payload, status: "NOT_READY" }], [200, { ...payload, service: "foreign" }],
    [200, { ...payload, sourceCommit: "mutable" }], [200, { ...payload, checks: { database: false } }],
    [200, { ...payload, checks: {} }], [200, { ...payload, checks: [true] }], [200, { ...payload, checks: { db: "true" } }],
  ])("fails closed on status/contract drift", async (status, data) => {
    expect(await createRefrefReadinessProbe(env, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(data), { status: status as number })))()).toBe("unavailable");
  });
  it.each(["{invalid", "x".repeat(8193)])("rejects malformed and oversized responses", async (body) => {
    expect(await createRefrefReadinessProbe(env, vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))()).toBe("unavailable");
  });
  it("sanitizes transport exceptions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("SECRET JWT BODY URL"));
    expect(await createRefrefReadinessProbe(env, fetcher)()).toBe("unavailable");
  });
});

describe("actual application foundation boundaries", () => {
  const app = (db: Database.Database, probe = async () => "ready" as const) => createCommerceV2App({ db,
    config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", MERCHANT_PROMOTION_PREFIX: "FX-" }),
    serviceToken: "not-a-customer-credential", sourceCommit: sha, foundationMode: true, probeRefref: probe,
  });
  it("reports real database and Refref health", async () => {
    const response = await app(database()).request("/readyz");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, foundationMode: true, core: { database: "ok", paymentMode: "disabled" }, capabilities: { refref: "ready" } });
  });
  it("does not report closed database as healthy", async () => {
    const db = database(); db.close();
    const response = await app(db).request("/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, core: { database: "unavailable" } });
  });
  it("does not accept an incomplete catalog schema or omitted dependency probe", async () => {
    const db = database(); db.exec("DROP TABLE catalog_course_projection");
    expect((await app(db).request("/readyz")).status).toBe(503);
    const server = createCommerceV2App({ db: database(), config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "disabled" }), serviceToken: "token", sourceCommit: sha, foundationMode: true });
    expect((await server.request("/readyz")).status).toBe(503);
  });
  it("fails readiness if Refref stops answering", async () => {
    const server = createCommerceV2App({ db: database(), config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "disabled" }), serviceToken: "token", sourceCommit: sha, foundationMode: true, probeRefref: async () => "unavailable" });
    expect((await server.request("/readyz")).status).toBe(503);
  });
  it.each([["POST", "/v1/auth/sign-in/magic-link"], ["POST", "/v1/checkout"], ["POST", "/v1/internal/course-manifests"], ["GET", "/v1/admin/v2/orders"], ["POST", "/readyz"], ["GET", "/unknown"]])("refuses %s %s before customer/internal handlers", async (method, path) => {
    const db = database(); const response = await app(db).request(path, { method, headers: { authorization: "Bearer not-a-customer-credential" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "FOUNDATION_ISOLATED" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
  });
});

describe("SQLite persistence and real encrypted restore", () => {
  it("survives close/reopen and rejects wrong marker/environment/source", () => {
    const path = join(mkdtempSync(join(tmpdir(), "v2-durable-")), "commerce.sqlite");
    const db = database(path); const context = { environment: "canary" as const, sourceCommit: sha };
    const marker = markDurability(db, context); db.close();
    const reopened = database(path);
    expect(() => verifyDurability(reopened, context, marker)).not.toThrow();
    expect(() => verifyDurability(reopened, { ...context, sourceCommit: "b".repeat(40) }, marker)).toThrow("SQLITE_DURABILITY_FAILED");
    expect(() => verifyDurability(reopened, { ...context, environment: "production" }, marker)).toThrow("SQLITE_DURABILITY_FAILED");
    expect(() => verifyDurability(reopened, context, "missing")).toThrow("SQLITE_DURABILITY_FAILED");
  });
  it("encrypts an online WAL snapshot, restores it and removes plaintext", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v2-age-")); const key = join(dir, "key.txt");
    execFileSync("age-keygen", ["-o", key], { stdio: "ignore" }); chmodSync(key, 0o600);
    const recipient = execFileSync("age-keygen", ["-y", key], { encoding: "utf8" }).trim();
    const db = database(join(dir, "live.sqlite")); const context = { environment: "production" as const, sourceCommit: sha };
    const marker = markDurability(db, context);
    const backups = join(dir, "backups"); const proof = await backupFoundation(db, context, backups, recipient);
    expect(statSync(join(backups, proof.filename)).mode & 0o777).toBe(0o600);
    expect(readdirSync(backups)).toEqual([proof.filename]);
    expect(readFileSync(join(backups, proof.filename)).includes(Buffer.from(marker))).toBe(false);
    const restoredPath = join(dir, "restored.sqlite");
    execFileSync("age", ["-d", "-i", key, "-o", restoredPath, join(backups, proof.filename)], { stdio: "ignore" });
    const restored = database(restoredPath);
    expect(() => verifyDurability(restored, context, marker)).not.toThrow();
    expect(restored.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all());
    expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
  });
  it("fails closed and removes plaintext on encryption failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "v2-backup-failure-"));
    await expect(backupFoundation(database(), { environment: "canary", sourceCommit: sha }, directory, "age1" + "a".repeat(58), () => { throw new Error("secret"); })).rejects.toThrow("FOUNDATION_BACKUP_FAILED");
    expect(readdirSync(directory)).toEqual([]);
  });
});
