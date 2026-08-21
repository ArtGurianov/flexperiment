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
  it("allows the configured public browser origin and required checkout headers", async () => {
    const { db, app } = appFixture();
    const response = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "x-commerce-trusted-client-ip": "127.0.0.1" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://flexperiment.ru");
    expect(response.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");
    expect(response.headers.get("cache-control")).toBe("no-store");
    db.close();
  });

  it("answers public checkout preflight and rejects an untrusted browser origin", async () => {
    const { db, app } = appFixture();
    const preflight = await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "OPTIONS", headers: { Origin: "https://flexperiment.ru", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,idempotency-key" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://flexperiment.ru");
    const rejected = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://untrusted.example" } });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
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

  it("creates an audited hidden occurrence and exposes it only after the existing publish command", async () => {
    const { db, app } = appFixture();
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.1" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    const adminHeaders = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const cityPayload = { name: "Омск", slug: "omsk", reason: "Tochka Phase 0 certification" };
    const cityKey = "b6a8e45a-9334-4626-8041-000000000001";
    const firstCity = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify(cityPayload) });
    expect(firstCity.status).toBe(201);
    const city = await firstCity.json() as { id: string; slug: string; title: string };
    expect(city).toMatchObject({ slug: "omsk", title: "Омск" });
    const cityReplay = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify(cityPayload) });
    expect(await cityReplay.json()).toMatchObject({ id: city.id });
    const changedReplay = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify({ ...cityPayload, name: "Другой Омск" }) });
    expect(changedReplay.status).toBe(409);
    const duplicateSlug = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000006" }, body: JSON.stringify(cityPayload) });
    expect(duplicateSlug.status).toBe(409);

    const occurrencePayload = {
      city_id: city.id,
      title: "FLEXPERIMENT — Tochka certification",
      starts_at: "2026-08-22T12:00:00+07:00",
      ends_at: "2026-08-22T15:00:00+07:00",
      timezone: "Asia/Omsk",
      price_kopecks: 100,
      capacity: 1,
      venue_status: "TO_BE_ANNOUNCED",
      venue_disclosure_text: "Venue will be announced to registered participants.",
      venue_announce_by: "2026-08-21T12:00:00+07:00",
      reason: "Tochka Phase 0 certification",
    };
    const occurrenceKey = "b6a8e45a-9334-4626-8041-000000000002";
    const occurrence = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": occurrenceKey }, body: JSON.stringify(occurrencePayload) });
    expect(occurrence.status).toBe(201);
    const created = await occurrence.json() as { id: string; sales_status: string; visibility: string };
    expect(created).toMatchObject({ sales_status: "CLOSED", visibility: "HIDDEN" });
    const occurrenceReplay = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": occurrenceKey }, body: JSON.stringify(occurrencePayload) });
    expect(await occurrenceReplay.json()).toMatchObject({ id: created.id });
    const occurrenceConflict = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": occurrenceKey }, body: JSON.stringify({ ...occurrencePayload, title: "Changed title" }) });
    expect(occurrenceConflict.status).toBe(409);
    const before = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "x-commerce-trusted-client-ip": "127.0.0.1" } });
    expect((await before.json() as { cities: { id?: string }[] }).cities.some((entry) => entry.id === created.id)).toBe(false);

    const unknownCity = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000003" }, body: JSON.stringify({ ...occurrencePayload, city_id: randomUUID() }) });
    expect(unknownCity.status).toBe(404);
    const invalidCapacity = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000004" }, body: JSON.stringify({ ...occurrencePayload, capacity: 0 }) });
    expect(invalidCapacity.status).toBe(422);
    const invalidPrice = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000007" }, body: JSON.stringify({ ...occurrencePayload, price_kopecks: 0 }) });
    expect(invalidPrice.status).toBe(422);
    const unsafeCreate = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000005" }, body: JSON.stringify({ ...occurrencePayload, visibility: "PUBLISHED" }) });
    expect(unsafeCreate.status).toBe(422);
    const unsafeSalesCreate = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000008" }, body: JSON.stringify({ ...occurrencePayload, sales_status: "OPEN" }) });
    expect(unsafeSalesCreate.status).toBe(422);

    const published = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ price_kopecks: 100, capacity: 1, sales_status: "OPEN", visibility: "PUBLISHED", reason: "Tochka Phase 0 certification" }) });
    expect(published.status).toBe(200);
    const after = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "x-commerce-trusted-client-ip": "127.0.0.1" } });
    expect((await after.json() as { cities: { id?: string }[] }).cities.some((entry) => entry.id === created.id)).toBe(true);
    expect(db.prepare("SELECT admin_id, action, entity_type, entity_id, details_json FROM admin_audit_log WHERE entity_id = ?").get(created.id)).toMatchObject({
      admin_id: expect.any(String), action: "OCCURRENCE_CREATED", entity_type: "occurrence", entity_id: created.id,
    });
    const evidence = JSON.parse(String((db.prepare("SELECT details_json FROM admin_audit_log WHERE entity_id = ?").get(created.id) as { details_json: string }).details_json));
    expect(evidence).toMatchObject({ reason: occurrencePayload.reason, idempotency_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/), canonical_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
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
