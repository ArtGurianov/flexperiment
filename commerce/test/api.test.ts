import { createHash, randomUUID, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { MockProvider } from "../src/provider";
import { UnisenderGoProvider } from "../src/email-provider";

process.env.COMMERCE_SESSION_SECRET = "test-session-secret";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT = `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;

const { createApp } = await import("../src/api");
const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };

function appFixture() {
  const db = openDatabase(":memory:"); migrate(db);
  const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'tomsk', 'Томск')").run(cityId);
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'test', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(legalManifest));
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2026-10-01T10:00:00.000Z', '2026-10-01T13:00:00.000Z', 'Asia/Tomsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return { db, app: createApp(db, new MockProvider()) };
}

describe("commerce HTTP boundary", () => {
  it("serves public commerce same-origin without CORS headers", async () => {
    const { db, app } = appFixture();
    const response = await app.request("http://flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "x-commerce-trusted-client-ip": "127.0.0.1" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    db.close();
  });

  it("has no generic financial status editor", async () => {
    const { db, app } = appFixture();
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.1" }, body: JSON.stringify({ password: "correct horse" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    const response = await app.request("http://admin.flexperiment.ru/v1/admin/payments/any/status", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", Cookie: cookie } });
    expect(response.status).toBe(404);
    db.close();
  });

  it("uses the RC.8.3 provider-reference paths and leaves the old attach path absent", async () => {
    const { db, app } = appFixture();
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.1" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")! };
    const legacy = await app.request("http://admin.flexperiment.ru/v1/admin/payments/payment-1/attach-provider-reference", { method: "POST", headers });
    const current = await app.request("http://admin.flexperiment.ru/v1/admin/payments/payment-1/provider-reference", { method: "POST", headers });
    expect(legacy.status).toBe(404);
    expect(current.status).toBe(400);
    db.close();
  });

  it("authenticates and applies a documented batched Unisender status callback", async () => {
    const { db } = appFixture();
    const outboxId = randomUUID();
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key)
      VALUES (?, 'BOOKING_CANCELLED', 'buyer@example.test', 'hash', 'booking-cancelled', '{}', 'stable-key')`).run(outboxId);
    const apiKey = "test-api-key-not-a-secret";
    const app = createApp(db, new MockProvider(), new UnisenderGoProvider({ apiKey, fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async () => Response.json({ status: "success", job_id: "job" })));
    const unsigned = JSON.stringify({ auth: "pending", events_by_user: [{ user_id: 1, events: [{ event_name: "transactional_email_status", event_data: { job_id: "job-1", metadata: { outbox_id: outboxId }, status: "delivered", event_time: "2026-08-20 00:00:00" } }] }] });
    const body = unsigned.replace("pending", createHash("md5").update(unsigned.replace("pending", apiKey)).digest("hex"));
    const response = await app.request("http://flexperiment.ru/v1/webhooks/unisender", { method: "POST", headers: { "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.1" }, body });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT status, job_id FROM email_outbox WHERE id = ?").get(outboxId)).toMatchObject({ status: "DELIVERED", job_id: "job-1" });
    db.close();
  });
});
