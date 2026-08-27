import { createHash, randomUUID, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { MockProvider } from "../src/provider";
import { UnisenderGoProvider } from "../src/email-provider";
import { CommerceDomain } from "../src/domain";
import { decryptTicketCapability, sha256 } from "../src/crypto";
import type { SmartCaptchaVerifier } from "../src/smartcaptcha";

process.env.COMMERCE_SESSION_SECRET = "test-session-secret";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT = `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;

const { createApp } = await import("../src/api");
const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };

const passingCaptcha: SmartCaptchaVerifier = { verify: async () => "PASS" };

function appFixture(smartCaptcha: SmartCaptchaVerifier = passingCaptcha) {
  const db = openDatabase(":memory:"); migrate(db);
  const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'tomsk', 'Томск')").run(cityId);
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'test', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(legalManifest));
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2026-10-01T10:00:00.000Z', '2026-10-01T13:00:00.000Z', 'Asia/Tomsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return { db, app: createApp(db, new MockProvider(), undefined, smartCaptcha) };
}

describe("commerce HTTP boundary", () => {
  it("allows the configured public browser origin and required checkout headers", async () => {
    const { db, app } = appFixture();
    const response = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "X-Forwarded-For": "127.0.0.1" } });
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

  it("rejects retired identity fields at the public checkout boundary", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.24" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
    const quoteId = (await context.json() as { quote_id: string }).quote_id;
    const response = await app.request("http://api.flexperiment.ru/v1/public/checkouts", {
      method: "POST",
      headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": "retired-dob-rejected", "X-Forwarded-For": "127.0.0.24" },
      body: JSON.stringify({ quote_id: quoteId, customer_name: "Покупатель", customer_email: "buyer@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", participant: { name: "Участник", date_of_birth: "1990-01-01" }, offer_accepted: true, pd_consent_accepted: true }),
    });
    expect(response.status).toBe(422);
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
    db.close();
  });

  it("uses a ticket capability, not a name, for public admission", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const domain = new CommerceDomain(db, new MockProvider());
    const quote = domain.checkoutContext({ occurrenceId });
    const checkout = await domain.checkoutAsync({
      quote_id: quote.quote_id, customer_email: "buyer@example.test", customer_adult_confirmed: true,
      participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true,
    }, "anonymous-ticket-admission-001", "https://flexperiment.ru");
    const payment = db.prepare("SELECT id FROM payments WHERE order_id = (SELECT id FROM orders WHERE public_status_id = ?)").get(checkout.status_id) as { id: string };
    domain.markPaymentPaid(payment.id, 100_000, "provider-payment");
    const ticket = db.prepare("SELECT capability_ciphertext, capability_nonce FROM tickets").get() as { capability_ciphertext: string; capability_nonce: string };
    const capability = decryptTicketCapability(ticket.capability_ciphertext, ticket.capability_nonce);
    const response = await app.request("http://api.flexperiment.ru/v1/public/ticket", { headers: { Authorization: `Bearer ${capability}`, "X-Forwarded-For": "127.0.0.24" } });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "VALID", participant_age_band: "ADULT" });
    expect(body).not.toHaveProperty("customer_name");
    expect(body).not.toHaveProperty("participant_name");
    db.close();
  });

  it("rejects a superseded DOB-era idempotency contract without creating another order", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.26" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
    const quoteId = (await context.json() as { quote_id: string }).quote_id;
    const key = "legacy-dob-idempotency-key";
    const current = { quote_id: quoteId, customer_email: "buyer@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true };
    const created = await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": key, "X-Forwarded-For": "127.0.0.26" }, body: JSON.stringify(current) });
    const original = await created.json() as { status_id: string; payment_url: string | null };
    db.prepare("UPDATE checkout_idempotency SET canonical_request_hash = ? WHERE idempotency_key_hash = ?").run("v1:historical-dob-request", sha256(key));
    const replay = await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": key, "X-Forwarded-For": "127.0.0.26" }, body: JSON.stringify(current) });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: { code: "IDEMPOTENCY_CONTRACT_SUPERSEDED" } });
    expect(original.status_id).toEqual(expect.any(String));
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 1 });
    db.close();
  });

  it("replays normalized anonymous checkout bodies and binds the age band", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.27" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
    const quoteId = (await context.json() as { quote_id: string }).quote_id;
    const key = "normalized-current-idempotency";
    const body = { quote_id: quoteId, customer_email: " BUYER@example.test ", customer_adult_confirmed: true, participant_age_band: "MINOR_14_17", minor_legal_representative_confirmed: true, offer_accepted: true, pd_consent_accepted: true };
    const headers = { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": key, "X-Forwarded-For": "127.0.0.27" };
    const created = await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers, body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const original = await created.json();
    const replay = await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers, body: JSON.stringify({ ...body, customer_email: "BUYER@example.test" }) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject(original);
    const conflict = await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers, body: JSON.stringify({ ...body, participant_age_band: "ADULT" }) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    db.close();
  });

  it("rejects a stale DOB checkout with the durable sales-pause outcome before validation or order creation", async () => {
    const previousToken = process.env.COMMERCE_RELEASE_CONTROL_TOKEN;
    process.env.COMMERCE_RELEASE_CONTROL_TOKEN = "release-control-test-token";
    const { db, app } = appFixture();
    try {
      const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
      const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.25" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
      const quoteId = (await context.json() as { quote_id: string }).quote_id;
      const release = { release_id: randomUUID(), mode: "CONTROLLED_CUTOVER", expected: { source_commit: "a".repeat(40), migration: "0033_runtime_release_evidence.sql", legal_version: "2026-08-25.1", legal_manifest_sha256: "b".repeat(64), legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) } } };
      const headers = { Authorization: "Bearer release-control-test-token", "Content-Type": "application/json" };
      expect((await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", { method: "POST", headers, body: JSON.stringify(release) })).status).toBe(200);
      expect((await app.request("http://api.flexperiment.ru/v1/internal/release-control/pause", { method: "POST", headers, body: JSON.stringify(release) })).status).toBe(200);
      const response = await app.request("http://api.flexperiment.ru/v1/public/checkouts", {
        method: "POST",
        headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": "paused-stale-dob-client", "X-Forwarded-For": "127.0.0.25" },
        body: JSON.stringify({ quote_id: quoteId, customer_email: "buyer@example.test", participant: { self: true, date_of_birth: "1990-01-01" }, offer_accepted: true, pd_consent_accepted: true }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "SALES_TEMPORARILY_PAUSED" } });
      expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM payments").get()).toEqual({ count: 0 });
    } finally {
      db.close();
      if (previousToken === undefined) delete process.env.COMMERCE_RELEASE_CONTROL_TOKEN;
      else process.env.COMMERCE_RELEASE_CONTROL_TOKEN = previousToken;
    }
  });

  it("returns only cities that have a published occurrence, irrespective of sales status", async () => {
    const { db, app } = appFixture();
    const hiddenCityId = randomUUID(); const emptyCityId = randomUUID(); const closedCityId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)").run(hiddenCityId, "hidden-city", "Hidden city");
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)").run(emptyCityId, "empty-city", "Empty city");
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)").run(closedCityId, "closed-city", "Closed city");
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Hidden', '2026-10-02T10:00:00.000Z', '2026-10-02T13:00:00.000Z', 'Asia/Tomsk', 100, 1, 'HIDDEN', 'CLOSED', 'CONFIRMED', 'Studio', 'Lenina 2')`).run(randomUUID(), hiddenCityId);
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Published but closed', '2026-10-03T10:00:00.000Z', '2026-10-03T13:00:00.000Z', 'Asia/Tomsk', 100, 1, 'PUBLISHED', 'CLOSED', 'CONFIRMED', 'Studio', 'Lenina 3')`).run(randomUUID(), closedCityId);

    const tour = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "X-Forwarded-For": "127.0.0.22" } });
    const visible = await tour.json() as { cities: { city: string; sales_status: string }[] };
    expect(visible.cities.map((entry) => entry.city)).toEqual(["closed-city", "tomsk"]);
    expect(visible.cities.find((entry) => entry.city === "closed-city")).toMatchObject({ sales_status: "CLOSED" });
    expect(visible.cities.some((entry) => entry.city === "hidden-city" || entry.city === "empty-city")).toBe(false);

    db.prepare("UPDATE occurrences SET sales_status = 'CLOSED', visibility = 'HIDDEN' WHERE visibility = 'PUBLISHED'").run();
    const emptyTour = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "X-Forwarded-For": "127.0.0.23" } });
    expect(await emptyTour.json()).toEqual({ cities: [] });
    db.close();
  });

  it("uses the same safe public occurrence DTO on every catalogue endpoint", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const publicHeaders = { Origin: "https://flexperiment.ru", "X-Forwarded-For": "127.0.0.32" };

    const tour = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: publicHeaders });
    const byCity = await app.request("http://api.flexperiment.ru/v1/public/cities/tomsk/occurrences", { headers: publicHeaders });
    const byId = await app.request(`http://api.flexperiment.ru/v1/public/occurrences/${occurrenceId}`, { headers: publicHeaders });
    const [tourOccurrence] = (await tour.json() as { cities: unknown[] }).cities;
    const [cityOccurrence] = (await byCity.json() as { occurrences: unknown[] }).occurrences;
    const individualOccurrence = await byId.json();

    for (const occurrence of [tourOccurrence, cityOccurrence, individualOccurrence]) {
      expect(occurrence).toMatchObject({
        id: occurrenceId,
        city: "tomsk",
        city_title: "Томск",
        venue: { status: "CONFIRMED", name: null, address: null, disclosure_text: null, announce_by: null },
      });
      expect(occurrence).not.toHaveProperty("venue_public");
      expect(occurrence).not.toHaveProperty("venue_name");
      expect(occurrence).not.toHaveProperty("venue_address");
    }

    const checkoutContext = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", {
      method: "POST",
      headers: { ...publicHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ occurrence_id: occurrenceId }),
    });
    expect(await checkoutContext.json()).toMatchObject({ venue_disclosure: "Studio: Lenina 1" });

    db.prepare("UPDATE occurrences SET venue_public = 1 WHERE id = ?").run(occurrenceId);
    const exposed = await app.request("http://api.flexperiment.ru/v1/public/occurrences/" + occurrenceId, { headers: publicHeaders });
    expect(await exposed.json()).toMatchObject({ venue: { status: "CONFIRMED", name: "Studio", address: "Lenina 1" } });
    db.close();
  });

  it("exposes only a TBD venue presentation, never an address", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    db.prepare(`UPDATE occurrences
      SET venue_status = 'TO_BE_ANNOUNCED', venue_name = NULL, venue_address = NULL,
        venue_disclosure_text = 'Площадка уточняется.', venue_announce_by = '2026-09-20T10:00:00.000Z'
      WHERE id = ?`).run(occurrenceId);
    const response = await app.request("http://api.flexperiment.ru/v1/public/occurrences/" + occurrenceId, {
      headers: { Origin: "https://flexperiment.ru", "X-Forwarded-For": "127.0.0.33" },
    });
    expect(await response.json()).toMatchObject({ venue: {
      status: "TO_BE_ANNOUNCED", name: null, address: null,
      disclosure_text: "Площадка уточняется.", announce_by: "2026-09-20T10:00:00.000Z",
    } });
    db.close();
  });

  it("has no generic financial status editor", async () => {
    const { db, app } = appFixture();
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body: JSON.stringify({ password: "correct horse" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    const response = await app.request("http://admin.flexperiment.ru/v1/admin/payments/any/status", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", Cookie: cookie } });
    expect(response.status).toBe(404);
    db.close();
  });

  it("reports and acknowledges operational email attention without changing delivery facts", async () => {
    const { db, app } = appFixture();
    const insert = db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
      payload_snapshot, status, provider_idempotence_key, attempts, sent_at, bounced_at,
      provider_error_code, provider_error_message)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', ?, ?, 2,
      '2026-08-23T00:00:00.000Z', '2026-08-23T00:01:00.000Z', 'hard_bounced', 'Mailbox unavailable')`);
    for (const status of ["FAILED", "BOUNCED", "SEND_UNKNOWN", "DELIVERED"]) insert.run(`api-attention-${status}`, status, `api-attention-key-${status}`);
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.58" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };

    const dashboard = await app.request("http://admin.flexperiment.ru/v1/admin/dashboard", { headers });
    expect(await dashboard.json()).toMatchObject({ health: { email_attention: { count: 3 } } });
    const list = await app.request("http://admin.flexperiment.ru/v1/admin/email-attention", { headers });
    const listed = await list.json() as { attention_count: number; incidents: { id: string; requires_attention: number }[] };
    expect(listed.attention_count).toBe(3);
    expect(listed.incidents.filter((incident) => incident.requires_attention === 1)).toHaveLength(3);
    expect(listed.incidents.map((incident) => incident.id)).not.toContain("api-attention-DELIVERED");

    const empty = await app.request("http://admin.flexperiment.ru/v1/admin/email-attention/api-attention-FAILED/acknowledge", { method: "POST", headers, body: JSON.stringify({}) });
    expect(await empty.json()).toMatchObject({ acknowledged_now: true, incident: { status: "FAILED", ops_acknowledged_reason: null } });
    const unknown = await app.request("http://admin.flexperiment.ru/v1/admin/email-attention/not-an-outbox/acknowledge", { method: "POST", headers, body: JSON.stringify({}) });
    expect(unknown.status).toBe(404);
    const replay = await app.request("http://admin.flexperiment.ru/v1/admin/email-attention/api-attention-FAILED/acknowledge", { method: "POST", headers, body: JSON.stringify({ audit_context: "Must not overwrite." }) });
    expect(await replay.json()).toMatchObject({ acknowledged_now: false, incident: { ops_acknowledged_reason: null } });
    expect(db.prepare(`SELECT status, attempts, sent_at, bounced_at, provider_error_code,
      provider_error_message, ops_acknowledged_reason FROM email_outbox WHERE id = 'api-attention-FAILED'`).get())
      .toEqual({ status: "FAILED", attempts: 2, sent_at: "2026-08-23T00:00:00.000Z", bounced_at: "2026-08-23T00:01:00.000Z", provider_error_code: "hard_bounced", provider_error_message: "Mailbox unavailable", ops_acknowledged_reason: null });
    const after = await app.request("http://admin.flexperiment.ru/v1/admin/email-attention", { headers });
    const afterBody = await after.json() as { attention_count: number; incidents: { requires_attention: number }[] };
    expect(afterBody.attention_count).toBe(2);
    expect(afterBody.incidents.filter((incident) => incident.requires_attention === 1)).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'EMAIL_ATTENTION_ACKNOWLEDGED'").get()).toEqual({ count: 1 });
    db.close();
  });

  it("exposes settlement evidence as a pure Admin read and requires idempotency for lifecycle commands", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const agentId = randomUUID(); const settlementId = randomUUID();
    db.prepare("INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, npd_status_checked_at, default_reward_type, default_reward_value) VALUES (?, 'settlement-api-agent', 'Settlement Agent', 'Settlement Agent Legal', 'settlement-agent@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', datetime('now'), 'FIXED', 100)").run(agentId);
    db.prepare("INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id) VALUES (?, ?, ?, 100, 'TRANSFER', 'PREPARED', 'SELF_EMPLOYED', ?, 'admin')").run(settlementId, agentId, occurrenceId, new Date().toISOString());
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.57" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const reviewCount = db.prepare("SELECT COUNT(*) AS count FROM settlement_prepared_reviews").get();
    const list = await app.request("http://admin.flexperiment.ru/v1/admin/reward-settlements", { headers });
    expect(list.status).toBe(200);
    expect((await list.json() as { settlements: { id: string; stale_prepared: number }[] }).settlements).toEqual(expect.arrayContaining([expect.objectContaining({ id: settlementId, stale_prepared: 0 })]));
    const detail = await app.request(`http://admin.flexperiment.ru/v1/admin/reward-settlements/${settlementId}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ settlement: { id: settlementId, status: "PREPARED" }, recoveries: [] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM settlement_prepared_reviews").get()).toEqual(reviewCount);
    const missingKey = await app.request(`http://admin.flexperiment.ru/v1/admin/reward-settlements/${settlementId}/payment-made`, { method: "POST", headers, body: JSON.stringify({ confirmation_text: "I confirm the money was transferred" }) });
    expect(missingKey.status).toBe(400);
    const missingReason = await app.request(`http://admin.flexperiment.ru/v1/admin/reward-settlements/${settlementId}/payment-made`, { method: "POST", headers: { ...headers, "Idempotency-Key": "settlement-api-payment-no-reason" }, body: JSON.stringify({ confirmation_text: "I confirm the money was transferred" }) });
    expect(missingReason.status).toBe(422);
    const first = await app.request(`http://admin.flexperiment.ru/v1/admin/reward-settlements/${settlementId}/payment-made`, { method: "POST", headers: { ...headers, "Idempotency-Key": "settlement-api-payment-key" }, body: JSON.stringify({ confirmation_text: "I confirm the money was transferred", reason: "Bank transfer was confirmed." }) });
    expect(await first.json()).toMatchObject({ id: settlementId, status: "PENDING_DOCUMENT" });
    const replay = await app.request(`http://admin.flexperiment.ru/v1/admin/reward-settlements/${settlementId}/payment-made`, { method: "POST", headers: { ...headers, "Idempotency-Key": "settlement-api-payment-key" }, body: JSON.stringify({ confirmation_text: "I confirm the money was transferred", reason: "Bank transfer was confirmed." }) });
    expect(await replay.json()).toMatchObject({ id: settlementId, status: "PENDING_DOCUMENT" });
    db.close();
  });

  it("makes stale-prepared and open-incident dashboard counters query-equivalent destination subsets", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const agentId = randomUUID(); const reviewedSettlementId = randomUUID(); const otherSettlementId = randomUUID();
    db.prepare("INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, npd_status_checked_at, default_reward_type, default_reward_value) VALUES (?, 'filter-agent', 'Filter Agent', 'Filter Agent Legal', 'filter-agent@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', datetime('now'), 'FIXED', 100)").run(agentId);
    const insertSettlement = db.prepare("INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id) VALUES (?, ?, ?, 100, 'TRANSFER', 'PREPARED', 'SELF_EMPLOYED', ?, 'admin')");
    insertSettlement.run(reviewedSettlementId, agentId, occurrenceId, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
    insertSettlement.run(otherSettlementId, agentId, occurrenceId, new Date().toISOString());
    db.prepare("INSERT INTO settlement_prepared_reviews(settlement_id) VALUES (?)").run(reviewedSettlementId);
    db.prepare("INSERT INTO operational_incidents(id, incident_key, kind, entity_type, entity_id, details_json, status) VALUES (?, 'open-filter-incident', 'VENUE_ANNOUNCEMENT_OVERDUE', 'occurrence', ?, '{}', 'OPEN')").run(randomUUID(), occurrenceId);
    db.prepare("INSERT INTO operational_incidents(id, incident_key, kind, entity_type, entity_id, details_json, status, resolution_note, resolved_at) VALUES (?, 'resolved-filter-incident', 'VENUE_ANNOUNCEMENT_OVERDUE', 'occurrence', ?, '{}', 'RESOLVED', 'fixed', datetime('now'))").run(randomUUID(), occurrenceId);
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.91" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };

    const dashboard = await app.request("http://admin.flexperiment.ru/v1/admin/dashboard", { headers });
    expect(await dashboard.json()).toMatchObject({ health: { stale_prepared_settlements: { count: 1 }, operational_incidents: { count: 1 } } });
    const settlements = await app.request("http://admin.flexperiment.ru/v1/admin/reward-settlements?stale_prepared=1", { headers });
    expect((await settlements.json() as { settlements: { id: string; prepared_review_status: string }[] }).settlements)
      .toEqual([expect.objectContaining({ id: reviewedSettlementId, prepared_review_status: "OPEN" })]);
    const incidents = await app.request("http://admin.flexperiment.ru/v1/admin/operational-incidents?status=OPEN", { headers });
    expect((await incidents.json() as { incidents: { status: string }[] }).incidents).toEqual([expect.objectContaining({ status: "OPEN" })]);
    db.close();
  });

  it("requires a session-bound reauthentication capability to cancel an occurrence", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.44" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const missing = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${occurrenceId}/cancel`, { method: "POST", headers: { ...headers, "Idempotency-Key": "ca82fbea-0e17-4c32-bfce-000000000001" }, body: JSON.stringify({ reason: "Organizer illness", reauth_capability: "x".repeat(32) }) });
    expect(missing.status).toBe(403);
    const invalid = await app.request("http://admin.flexperiment.ru/v1/admin/reauth", { method: "POST", headers, body: JSON.stringify({ password: "wrong password", purpose: "CANCEL_OCCURRENCE", resource_id: occurrenceId }) });
    expect(invalid.status).toBe(401);
    const reauth = await app.request("http://admin.flexperiment.ru/v1/admin/reauth", { method: "POST", headers, body: JSON.stringify({ password: "correct horse", purpose: "CANCEL_OCCURRENCE", resource_id: occurrenceId }) });
    expect(reauth.status).toBe(200);
    const capability = (await reauth.json() as { capability: string }).capability;
    const cancelled = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${occurrenceId}/cancel`, { method: "POST", headers: { ...headers, "Idempotency-Key": "ca82fbea-0e17-4c32-bfce-000000000001" }, body: JSON.stringify({ reason: "Organizer illness", reauth_capability: capability }) });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ fulfillment_status: "CANCELLED", sales_status: "CLOSED" });
    expect(db.prepare("SELECT details_json FROM admin_audit_log WHERE action = 'OCCURRENCE_CANCELLED'").get()).toMatchObject({ details_json: expect.not.stringContaining(capability) });
    db.close();
  });

  it("rate limits repeated reauthentication password failures per session without blocking another session", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const loginHeaders = { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.47" };
    const firstLogin = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: loginHeaders, body: JSON.stringify({ password: "correct horse" }) });
    const firstHeaders = { Origin: "https://admin.flexperiment.ru", Cookie: firstLogin.headers.get("set-cookie")!, "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.47" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.request("http://admin.flexperiment.ru/v1/admin/reauth", { method: "POST", headers: firstHeaders, body: JSON.stringify({ password: "wrong", purpose: "CANCEL_OCCURRENCE", resource_id: occurrenceId }) });
      expect(response.status).toBe(401);
    }
    const throttled = await app.request("http://admin.flexperiment.ru/v1/admin/reauth", { method: "POST", headers: firstHeaders, body: JSON.stringify({ password: "correct horse", purpose: "CANCEL_OCCURRENCE", resource_id: occurrenceId }) });
    expect(throttled.status).toBe(429);
    const secondLogin = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: loginHeaders, body: JSON.stringify({ password: "correct horse" }) });
    const second = await app.request("http://admin.flexperiment.ru/v1/admin/reauth", { method: "POST", headers: { ...firstHeaders, Cookie: secondLogin.headers.get("set-cookie")! }, body: JSON.stringify({ password: "correct horse", purpose: "CANCEL_OCCURRENCE", resource_id: occurrenceId }) });
    expect(second.status).toBe(200);
    db.close();
  });

  it("acknowledges public refund requests without disclosing whether an order exists", async () => {
    const { db, app } = appFixture();
    const response = await app.request("http://api.flexperiment.ru/v1/public/refunds/request", {
      method: "POST",
      headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.45" },
      body: JSON.stringify({ order_number: "FX-UNKNOWN-ORDER", captcha_token: "valid-captcha-token" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    db.close();
  });

  it("verifies SmartCaptcha before refund lookup and preserves the opaque response after a valid proof", async () => {
    let verified = 0;
    const { db, app } = appFixture({ verify: async (token, ip) => {
      verified += 1;
      expect(token).toBe("proof");
      expect(ip).toBe("127.0.0.88");
      return "PASS";
    } });
    const response = await app.request("http://api.flexperiment.ru/v1/public/refunds/request", {
      method: "POST",
      headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.88" },
      body: JSON.stringify({ order_number: "FX-NOT-AN-ORDER", captcha_token: "proof" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(verified).toBe(1);
    db.close();
  });

  it("omits an untrusted forwarded chain from the SmartCaptcha request", async () => {
    let capturedIp = "not-called" as string | undefined;
    const { db, app } = appFixture({ verify: async (_token, ip) => {
      capturedIp = ip;
      return "PASS";
    } });
    const response = await app.request("http://api.flexperiment.ru/v1/public/refunds/request", {
      method: "POST",
      headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4, 198.51.100.17" },
      body: JSON.stringify({ order_number: "FX-CHAIN-UNTRUSTED", captcha_token: "proof" }),
    });
    expect(response.status).toBe(202);
    expect(capturedIp).toBeUndefined();
    db.close();
  });

  it("fails closed before refund lookup when SmartCaptcha rejects or is unavailable", async () => {
    for (const [result, status, code, ip] of [["INVALID", 422, "CAPTCHA_INVALID", "127.0.0.82"], ["UNAVAILABLE", 503, "CAPTCHA_UNAVAILABLE", "127.0.0.83"]] as const) {
      const { db, app } = appFixture({ verify: async () => result });
      const response = await app.request("http://api.flexperiment.ru/v1/public/refunds/request", {
        method: "POST",
        headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ order_number: "FX-NOT-AN-ORDER", captcha_token: "proof" }),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code } });
      expect(db.prepare("SELECT COUNT(*) AS count FROM customer_refund_confirmation_tokens").get()).toEqual({ count: 0 });
      db.close();
    }
  });

  it("stores one consent-evidenced city interest request and accepts a duplicate without enumeration", async () => {
    const { db, app } = appFixture();
    const request = (email: string, city = "kemerovo") => app.request("http://api.flexperiment.ru/v1/public/city-interest", {
      method: "POST",
      headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.89" },
      body: JSON.stringify({ email, city, pd_consent_accepted: true, captcha_token: "proof" }),
    });
    expect((await request("  ART@EXAMPLE.TEST ")).status).toBe(202);
    expect((await request("art@example.test")).status).toBe(202);
    expect(db.prepare("SELECT email_normalized, city_slug, privacy_policy_version, pd_consent_version FROM city_interest_requests").all()).toEqual([
      { email_normalized: "art@example.test", city_slug: "kemerovo", privacy_policy_version: "test-1", pd_consent_version: "test-1" },
    ]);
    expect((await request("art@example.test", "unsupported-city")).status).toBe(400);
    db.close();
  });

  it("allows an authenticated operator to withdraw all city-interest rows without persisting the email", async () => {
    const { db, app } = appFixture();
    for (const city of ["kemerovo", "omsk"]) {
      const response = await app.request("http://api.flexperiment.ru/v1/public/city-interest", {
        method: "POST",
        headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": `127.0.0.${city.length}` },
        body: JSON.stringify({ email: "withdraw@example.test", city, pd_consent_accepted: true, captcha_token: "proof" }),
      });
      expect(response.status).toBe(202);
    }
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.99" }, body: JSON.stringify({ password: "correct horse" }) });
    const withdrawn = await app.request("http://admin.flexperiment.ru/v1/admin/city-interest/withdraw", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "withdraw@example.test", reason: "Consent withdrawal received" }),
    });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toEqual({ withdrawn: true, deleted_count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE email_normalized = 'withdraw@example.test'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT details_json FROM admin_audit_log WHERE action = 'CITY_INTEREST_WITHDRAWN'").get()).toEqual({ details_json: expect.not.stringContaining("withdraw@example.test") });
    db.close();
  });

  it("reads refund confirmation context without consuming or cancelling anything", async () => {
    const { db, app } = appFixture();
    const domain = new CommerceDomain(db, new MockProvider());
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const quote = domain.checkoutContext({ occurrenceId });
    const checkout = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "995e27bc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru");
    const order = db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string; public_order_number: string; payment_id: string };
    domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    const token = db.prepare("SELECT token_ciphertext, token_nonce FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id) as { token_ciphertext: string; token_nonce: string };
    const capability = decryptTicketCapability(token.token_ciphertext, token.token_nonce);
    const context = await app.request("http://api.flexperiment.ru/v1/public/refunds/confirmation-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.46" }, body: JSON.stringify({ token: capability }) });
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({ order_number: order.public_order_number, eligibility: "ELIGIBLE", amount_remaining_kopecks: 100000 });
    expect(db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CONFIRMED" });
    expect(db.prepare("SELECT consumed_at FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id)).toMatchObject({ consumed_at: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM refund_obligations WHERE payment_id = ?").get(order.payment_id)).toMatchObject({ count: 0 });
    db.close();
  });

  it("uses the RC.8.3 provider-reference paths and leaves the old attach path absent", async () => {
    const { db, app } = appFixture();
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body: JSON.stringify({ password: "correct horse" }) });
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
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    const adminHeaders = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const cityPayload = { city_slug: "omsk", audit_context: "Tochka Phase 0 certification" };
    const cityKey = "b6a8e45a-9334-4626-8041-000000000001";
    const mismatchedCity = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000009" }, body: JSON.stringify({ ...cityPayload, title: "Томск" }) });
    expect(mismatchedCity.status).toBe(422);
    const unsupportedCity = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000000" }, body: JSON.stringify({ city_slug: "unsupported-city", audit_context: "Catalog validation test" }) });
    expect(unsupportedCity.status).toBe(400);
    expect(await unsupportedCity.json()).toEqual({ error: { code: "CITY_SLUG_UNKNOWN" } });
    const firstCity = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify(cityPayload) });
    expect(firstCity.status).toBe(201);
    const city = await firstCity.json() as { id: string; slug: string; title: string };
    expect(city).toMatchObject({ slug: "omsk", title: "Омск" });
    const cityReplay = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify(cityPayload) });
    expect(await cityReplay.json()).toMatchObject({ id: city.id });
    const changedReplay = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify({ ...cityPayload, audit_context: "Different canonical request" }) });
    expect(changedReplay.status).toBe(409);
    const duplicateSlug = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000006" }, body: JSON.stringify(cityPayload) });
    expect(duplicateSlug.status).toBe(409);
    const cityPatch = await app.request(`http://admin.flexperiment.ru/v1/admin/cities/${city.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000007" }, body: JSON.stringify({ city_slug: "moscow", audit_context: "Corrected canonical city" }) });
    expect(cityPatch.status).toBe(200);
    expect(await cityPatch.json()).toMatchObject({ id: city.id, slug: "moscow", title: "Москва" });
    db.prepare("UPDATE cities SET title = ? WHERE id = ?").run("Incorrect title", city.id);
    const canonicalTitleRepair = await app.request(`http://admin.flexperiment.ru/v1/admin/cities/${city.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000010" }, body: JSON.stringify({ city_slug: "moscow", audit_context: "Canonical title repair" }) });
    expect(await canonicalTitleRepair.json()).toMatchObject({ id: city.id, slug: "moscow", title: "Москва" });
    const cityWithOccurrenceId = (db.prepare("SELECT id FROM cities WHERE slug = 'tomsk'").get() as { id: string }).id;
    const blockedPatch = await app.request(`http://admin.flexperiment.ru/v1/admin/cities/${cityWithOccurrenceId}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000008" }, body: JSON.stringify({ city_slug: "kazan", audit_context: "Unsafe historical mutation" }) });
    expect(blockedPatch.status).toBe(409);
    expect(await blockedPatch.json()).toEqual({ error: { code: "CITY_HAS_OCCURRENCES" } });

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
      audit_context: "Tochka Phase 0 certification",
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
    const before = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "X-Forwarded-For": "127.0.0.1" } });
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

    const published = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000011" }, body: JSON.stringify({ price_kopecks: 100, capacity: 1, visibility: "PUBLISHED", audit_context: "Tochka Phase 0 certification", expected_revision: 1 }) });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ id: created.id, visibility: "PUBLISHED", sales_status: "CLOSED" });
    const opened = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000012" }, body: JSON.stringify({ sales_status: "OPEN", audit_context: "Tochka Phase 0 certification", expected_revision: 2 }) });
    expect(opened.status).toBe(200);
    const openedReplay = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000012" }, body: JSON.stringify({ sales_status: "OPEN", audit_context: "Tochka Phase 0 certification", expected_revision: 2 }) });
    expect(await openedReplay.json()).toMatchObject({ id: created.id, visibility: "PUBLISHED", sales_status: "OPEN" });
    const patchConflict = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000012" }, body: JSON.stringify({ sales_status: "CLOSED", audit_context: "Changed patch", expected_revision: 3 }) });
    expect(patchConflict.status).toBe(409);
    const after = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "X-Forwarded-For": "127.0.0.1" } });
    expect((await after.json() as { cities: { id?: string }[] }).cities.some((entry) => entry.id === created.id)).toBe(true);
    expect(db.prepare("SELECT admin_id, action, entity_type, entity_id, details_json FROM admin_audit_log WHERE entity_id = ?").get(created.id)).toMatchObject({
      admin_id: expect.any(String), action: "OCCURRENCE_CREATED", entity_type: "occurrence", entity_id: created.id,
    });
    const evidence = JSON.parse(String((db.prepare("SELECT details_json FROM admin_audit_log WHERE entity_id = ?").get(created.id) as { details_json: string }).details_json));
    expect(evidence).toMatchObject({ audit_context: occurrencePayload.audit_context, idempotency_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/), canonical_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });

    // Creation and ordinary material edits do not require an operator note.
    // The audit ledger keeps a deliberate empty value rather than fabricating
    // a reason or losing the command evidence.
    const withoutContext = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", {
      method: "POST",
      headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000013" },
      body: JSON.stringify({ ...occurrencePayload, title: "FLEXPERIMENT — no audit context", audit_context: undefined }),
    });
    expect(withoutContext.status).toBe(201);
    const contextFree = await withoutContext.json() as { id: string; admin_revision: number };
    const contextFreeAudit = JSON.parse(String((db.prepare("SELECT details_json FROM admin_audit_log WHERE entity_id = ?").get(contextFree.id) as { details_json: string }).details_json));
    expect(contextFreeAudit.audit_context).toBeNull();
    const contextFreePatch = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${contextFree.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000014" },
      body: JSON.stringify({ title: "FLEXPERIMENT — context optional", expected_revision: contextFree.admin_revision }),
    });
    expect(contextFreePatch.status).toBe(200);
    db.close();
  });

  it("enforces the occurrence visibility and sales state machine at both API and SQLite boundaries", async () => {
    const { db, app } = appFixture();
    const cityId = (db.prepare("SELECT id FROM cities WHERE slug = 'tomsk'").get() as { id: string }).id;
    const occurrenceId = randomUUID();
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'State machine', '2026-10-04T10:00:00.000Z', '2026-10-04T13:00:00.000Z', 'Asia/Tomsk', 100, 1, 'HIDDEN', 'CLOSED', 'CONFIRMED', 'Studio', 'Lenina 4')`).run(occurrenceId, cityId);
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.55" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const patch = (key: string, payload: Record<string, unknown>) => app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${occurrenceId}`, {
      method: "PATCH", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ ...payload, audit_context: "Occurrence lifecycle test", expected_revision: Number((db.prepare("SELECT admin_revision FROM occurrences WHERE id = ?").get(occurrenceId) as { admin_revision: number }).admin_revision) }),
    });
    const state = () => db.prepare("SELECT visibility, sales_status FROM occurrences WHERE id = ?").get(occurrenceId);

    const publishAndOpen = await patch("d81172c2-25a5-4f15-80e5-000000000001", { visibility: "PUBLISHED", sales_status: "OPEN" });
    expect(publishAndOpen.status).toBe(409);
    expect(await publishAndOpen.json()).toEqual({ error: { code: "OCCURRENCE_STATE_TRANSITION_FORBIDDEN" } });
    expect(state()).toMatchObject({ visibility: "HIDDEN", sales_status: "CLOSED" });

    expect((await patch("d81172c2-25a5-4f15-80e5-000000000002", { visibility: "PUBLISHED" })).status).toBe(200);
    expect(state()).toMatchObject({ visibility: "PUBLISHED", sales_status: "CLOSED" });
    expect((await patch("d81172c2-25a5-4f15-80e5-000000000003", { sales_status: "OPEN" })).status).toBe(200);
    expect(state()).toMatchObject({ visibility: "PUBLISHED", sales_status: "OPEN" });

    const closeAndHide = await patch("d81172c2-25a5-4f15-80e5-000000000004", { visibility: "HIDDEN", sales_status: "CLOSED" });
    expect(closeAndHide.status).toBe(409);
    expect(await closeAndHide.json()).toEqual({ error: { code: "OCCURRENCE_STATE_TRANSITION_FORBIDDEN" } });
    expect(state()).toMatchObject({ visibility: "PUBLISHED", sales_status: "OPEN" });

    expect((await patch("d81172c2-25a5-4f15-80e5-000000000005", { sales_status: "PAUSED" })).status).toBe(200);
    expect(state()).toMatchObject({ visibility: "PUBLISHED", sales_status: "PAUSED" });
    const hidePaused = await patch("d81172c2-25a5-4f15-80e5-000000000006", { visibility: "HIDDEN" });
    expect(hidePaused.status).toBe(409);
    expect(await hidePaused.json()).toEqual({ error: { code: "OCCURRENCE_STATE_TRANSITION_FORBIDDEN" } });

    expect((await patch("d81172c2-25a5-4f15-80e5-000000000007", { sales_status: "OPEN" })).status).toBe(200);
    expect(state()).toMatchObject({ visibility: "PUBLISHED", sales_status: "OPEN" });
    expect((await patch("d81172c2-25a5-4f15-80e5-000000000008", { sales_status: "CLOSED" })).status).toBe(200);
    expect(state()).toMatchObject({ visibility: "PUBLISHED", sales_status: "CLOSED" });
    expect((await patch("d81172c2-25a5-4f15-80e5-000000000009", { visibility: "HIDDEN" })).status).toBe(200);
    expect(state()).toMatchObject({ visibility: "HIDDEN", sales_status: "CLOSED" });

    const openHidden = await patch("d81172c2-25a5-4f15-80e5-000000000010", { sales_status: "OPEN" });
    expect(openHidden.status).toBe(409);
    expect(await openHidden.json()).toEqual({ error: { code: "OCCURRENCE_STATE_TRANSITION_FORBIDDEN" } });
    expect(() => db.prepare("UPDATE occurrences SET sales_status = 'OPEN' WHERE id = ?").run(occurrenceId)).toThrow(/OCCURRENCE_HIDDEN_SALES_MUST_BE_CLOSED/);
    expect(() => db.prepare("UPDATE occurrences SET sales_status = 'PAUSED' WHERE id = ?").run(occurrenceId)).toThrow(/OCCURRENCE_HIDDEN_SALES_MUST_BE_CLOSED/);
    db.close();
  });

  it("allows only close-sales recovery from legacy hidden sellable occurrences", async () => {
    const { db, app } = appFixture();
    const cityId = (db.prepare("SELECT id FROM cities WHERE slug = 'tomsk'").get() as { id: string }).id;
    const openId = randomUUID(); const pausedId = randomUUID();
    // Simulate pre-0010 rows. The production trigger remains active for all
    // normal writes; only these in-memory fixtures bypass its INSERT check.
    db.exec("DROP TRIGGER occurrences_visibility_sales_before_insert");
    const insertLegacy = db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, venue_status, venue_name, venue_address)
      VALUES (?, ?, ?, '2026-10-05T10:00:00.000Z', '2026-10-05T13:00:00.000Z', 'Asia/Tomsk', 100, 1, 'HIDDEN', ?, 'CONFIRMED', 'Studio', 'Lenina 5')`);
    insertLegacy.run(openId, cityId, "Legacy hidden open", "OPEN");
    insertLegacy.run(pausedId, cityId, "Legacy hidden paused", "PAUSED");
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.56" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const patch = (occurrenceId: string, key: string, payload: Record<string, unknown>) => app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${occurrenceId}`, {
      method: "PATCH", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ ...payload, audit_context: "Legacy state recovery", expected_revision: Number((db.prepare("SELECT admin_revision FROM occurrences WHERE id = ?").get(occurrenceId) as { admin_revision: number }).admin_revision) }),
    });

    const openPublish = await patch(openId, "e81172c2-25a5-4f15-80e5-000000000001", { visibility: "PUBLISHED" });
    expect(openPublish.status).toBe(409);
    expect(await openPublish.json()).toEqual({ error: { code: "OCCURRENCE_STATE_TRANSITION_FORBIDDEN" } });
    const openWithEdit = await patch(openId, "e81172c2-25a5-4f15-80e5-000000000002", { sales_status: "CLOSED", title: "Not allowed during recovery" });
    expect(openWithEdit.status).toBe(409);
    expect((await patch(openId, "e81172c2-25a5-4f15-80e5-000000000003", { sales_status: "CLOSED" })).status).toBe(200);

    const pausedOpen = await patch(pausedId, "e81172c2-25a5-4f15-80e5-000000000004", { sales_status: "OPEN" });
    expect(pausedOpen.status).toBe(409);
    expect(await pausedOpen.json()).toEqual({ error: { code: "OCCURRENCE_STATE_TRANSITION_FORBIDDEN" } });
    expect((await patch(pausedId, "e81172c2-25a5-4f15-80e5-000000000005", { sales_status: "CLOSED" })).status).toBe(200);

    expect(db.prepare("SELECT visibility, sales_status FROM occurrences WHERE id = ?").get(openId)).toMatchObject({ visibility: "HIDDEN", sales_status: "CLOSED" });
    expect(db.prepare("SELECT visibility, sales_status FROM occurrences WHERE id = ?").get(pausedId)).toMatchObject({ visibility: "HIDDEN", sales_status: "CLOSED" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_type = 'occurrence' AND entity_id IN (?, ?)").get(openId, pausedId)).toMatchObject({ count: 2 });
    db.close();
  });

  it("exposes order evidence read-only and abandons only a reserved booking", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;
    const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
    const quoteId = (await context.json() as { quote_id: string }).quote_id;
    await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000009", "X-Forwarded-For": "127.0.0.1", "User-Agent": "Customer acceptance test" }, body: JSON.stringify({ quote_id: quoteId, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }) });
    const orderId = (db.prepare("SELECT id FROM orders").get() as { id: string }).id;
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const beforeCount = db.prepare("SELECT COUNT(*) AS count FROM reservation_abandonments").get();
    const evidence = await app.request(`http://admin.flexperiment.ru/v1/admin/orders/${orderId}/evidence`, { headers });
    expect(evidence.status).toBe(200);
    expect(evidence.headers.get("cache-control")).toBe("no-store");
    const evidenceBody = await evidence.json() as { order: { id: string }; payment: Record<string, unknown>; booking: { status: string }; ticket: unknown; email_outbox: unknown[] };
    expect(evidenceBody).toMatchObject({ order: { id: orderId }, booking: { status: "RESERVED" }, ticket: null, email_outbox: [] });
    expect(evidenceBody.payment).not.toHaveProperty("payment_url");
    expect(db.prepare("SELECT customer_adult_confirmed_at, customer_acceptance_ip, customer_acceptance_user_agent, participant_name, participant_age_band, participant_is_customer FROM orders WHERE id = ?").get(orderId))
      .toMatchObject({ customer_adult_confirmed_at: expect.any(String), customer_acceptance_ip: "127.0.0.1", customer_acceptance_user_agent: "Customer acceptance test", participant_name: null, participant_age_band: "ADULT", participant_is_customer: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM reservation_abandonments").get()).toEqual(beforeCount);
    const abandoned = await app.request(`http://admin.flexperiment.ru/v1/admin/orders/${orderId}/abandon-reservation`, { method: "POST", headers: { ...headers, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000010" }, body: JSON.stringify({ reason: "Certification interrupted before payment" }) });
    expect(abandoned.status).toBe(200);
    expect(await abandoned.json()).toMatchObject({ status: "CANCELLED" });
    db.close();
  });

  it("exposes only authenticated, redacted certification evidence", async () => {
    const previousSourceCommit = process.env.SOURCE_COMMIT;
    process.env.SOURCE_COMMIT = "547b25be75849a84c2f0f37ea9aa7fe7e485818c";
    const { db, app } = appFixture();
    try {
      const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;
      const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.61" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
      const quoteId = (await context.json() as { quote_id: string }).quote_id;
      await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": "certification-evidence-checkout", "X-Forwarded-For": "127.0.0.61" }, body: JSON.stringify({ quote_id: quoteId, customer_email: "certification@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }) });
      const order = db.prepare("SELECT id FROM orders").get() as { id: string };
      const payment = db.prepare("SELECT id FROM payments WHERE order_id = ?").get(order.id) as { id: string };
      const booking = db.prepare("SELECT id FROM bookings WHERE order_id = ?").get(order.id) as { id: string };
      const ticketId = randomUUID(); const ticketOutboxId = randomUUID(); const bookingOutboxId = randomUUID(); const refundId = randomUUID(); const compensationRefundId = randomUUID(); const obligationId = randomUUID();
      db.prepare("UPDATE payments SET status = 'PAID', captured_amount_kopecks = 100, provider_payment_id = 'operation-safe' WHERE id = ?").run(payment.id);
      db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?").run(booking.id);
      db.prepare("INSERT INTO tickets(id, booking_id, status, capability_hash, capability_ciphertext, capability_nonce, key_version) VALUES (?, ?, 'VALID', 'capability-hash', 'ciphertext', 'nonce', 1)").run(ticketId, booking.id);
      db.prepare("INSERT INTO provider_webhook_events(id, provider, semantic_key, payload_hash, status, entity_id, observed_json) VALUES (?, 'TOCHKA', 'operation-safe:APPROVED', 'payload-hash', 'APPLIED', ?, ?)").run(randomUUID(), payment.id, JSON.stringify({ raw_jwt: "must-not-leak" }));
      const insertOutbox = db.prepare("INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_ref, payload_snapshot, status, provider_idempotence_key, job_id, delivered_at) VALUES (?, ?, 'certification@example.test', 'email-hash', 'test', ?, ?, 'DELIVERED', ?, ?, datetime('now'))");
      insertOutbox.run(ticketOutboxId, "TICKET", ticketId, JSON.stringify({ customer_email: "certification@example.test", capability: "must-not-leak" }), randomUUID(), "ticket-job");
      insertOutbox.run(bookingOutboxId, "BOOKING_CANCELLED", booking.id, JSON.stringify({ customer_name: "Certification Customer" }), randomUUID(), "booking-job");
      db.prepare("INSERT INTO email_provider_events(id, outbox_id, semantic_key, status, provider_status, job_id) VALUES (?, ?, ?, 'DELIVERED', 'delivered', ?)").run(randomUUID(), ticketOutboxId, "ticket-delivered", "ticket-job");
      db.prepare("INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status) VALUES (?, ?, 'CUSTOMER_CANCELLATION_PARTIAL', 100, 'FULFILLED')").run(obligationId, payment.id);
      db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, provider_reference, succeeded_at) VALUES (?, ?, ?, ?, 100, 'Certification', 'REFUND_OBLIGATION', 'SUCCEEDED', ?, ?, 'refund-safe', datetime('now'))").run(refundId, randomUUID(), order.id, payment.id, randomUUID(), randomUUID());
      db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, provider_reference, succeeded_at) VALUES (?, ?, ?, ?, 1, 'Independent compensation', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, ?, 'compensation-safe', datetime('now'))").run(compensationRefundId, randomUUID(), order.id, payment.id, randomUUID(), randomUUID());

    expect((await app.request("http://admin.flexperiment.ru/v1/admin/system/evidence", { headers: { Origin: "https://admin.flexperiment.ru" } })).status).toBe(401);
    expect((await app.request(`http://admin.flexperiment.ru/v1/admin/orders/${order.id}/evidence`, { headers: { Origin: "https://admin.flexperiment.ru" } })).status).toBe(401);
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.61" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")! };
    const system = await app.request("http://admin.flexperiment.ru/v1/admin/system/evidence", { headers });
    expect(system.headers.get("cache-control")).toBe("no-store");
    expect(await system.json()).toMatchObject({ source_commit: process.env.SOURCE_COMMIT, migration_head: { version: "0035_promo_codes_v0.sql" }, migration_versions: expect.arrayContaining([{ version: "0031_participant_age_band.sql" }]), active_legal_release: { version: "test" } });
      const evidence = await app.request(`http://admin.flexperiment.ru/v1/admin/orders/${order.id}/evidence`, { headers });
      const body = await evidence.json() as { order: { currency: string } } & Record<string, unknown>;
    expect(body).toMatchObject({
      payment: { id: payment.id, provider_payment_id: "operation-safe", captured_amount_kopecks: 100 },
      ticket: { id: ticketId, status: "VALID" },
      tochka_webhook_events: [{ provider: "TOCHKA", semantic_key: "operation-safe:APPROVED", status: "APPLIED", entity_id: payment.id }],
      refund_obligation: { id: obligationId, payment_id: payment.id, target_refunded_amount_kopecks: 100 },
    });
      expect(body.order.currency).toBe("RUB");
      expect(body.refunds).toEqual(expect.arrayContaining([expect.objectContaining({ id: refundId, refund_obligation_id: obligationId, provider_reference: "refund-safe" })]));
      expect(body.refunds).toEqual(expect.arrayContaining([expect.objectContaining({ id: compensationRefundId, refund_obligation_id: null, provider_reference: "compensation-safe" })]));
    expect(body.email_outbox).toEqual(expect.arrayContaining([expect.objectContaining({ id: ticketOutboxId, job_id: "ticket-job", status: "DELIVERED" }), expect.objectContaining({ id: bookingOutboxId, job_id: "booking-job" })]));
    expect(body.email_provider_events).toEqual(expect.arrayContaining([expect.objectContaining({ outbox_id: ticketOutboxId, status: "DELIVERED", provider_status: "delivered" })]));
    const serialized = JSON.stringify(body);
    for (const forbidden of ["certification@example.test", "Certification Customer", "must-not-leak", "ciphertext", "capability-hash"]) expect(serialized).not.toContain(forbidden);
    } finally {
      db.close();
      if (previousSourceCommit === undefined) delete process.env.SOURCE_COMMIT;
      else process.env.SOURCE_COMMIT = previousSourceCommit;
    }
  });

  it("uses durable server-side Admin sessions and revokes the exact cookie on logout", async () => {
    const { db, app } = appFixture();
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body: JSON.stringify({ password: "correct horse" }) });
    const cookie = login.headers.get("set-cookie")!;
    expect(login.status).toBe(200);
    expect(cookie).toMatch(/^fx_admin_session=[^;]+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
    expect(cookie).not.toContain("Domain=");
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: cookie };
    const session = await app.request("http://admin.flexperiment.ru/v1/admin/session", { headers });
    expect(await session.json()).toEqual({ authenticated: true });
    expect(db.prepare("SELECT id, revoked_at FROM admin_sessions").all()).toHaveLength(1);
    const cities = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { headers });
    expect((await cities.json() as { cities: { occurrence_count: number }[] }).cities[0]).toMatchObject({ occurrence_count: 1 });
    const occurrences = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", { headers });
    expect((await occurrences.json() as { occurrences: { availability: number }[] }).occurrences[0]).toMatchObject({ availability: 5 });
    const logout = await app.request("http://admin.flexperiment.ru/v1/admin/logout", { method: "POST", headers });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    expect(logout.headers.get("set-cookie")).toBe("fx_admin_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
    expect(logout.headers.get("set-cookie")).not.toContain("Domain=");
    expect(db.prepare("SELECT revoked_at FROM admin_sessions").get()).toMatchObject({ revoked_at: expect.any(String) });
    const restartedApp = createApp(db, new MockProvider());
    const replay = await restartedApp.request("http://admin.flexperiment.ru/v1/admin/session", { headers });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: { code: "ADMIN_AUTH_REQUIRED" } });
    // A repeated logout remains safe: the revoked session is not revived. It
    // follows the existing authenticated-endpoint contract and returns 401.
    expect((await restartedApp.request("http://admin.flexperiment.ru/v1/admin/logout", { method: "POST", headers })).status).toBe(401);
    db.close();
  });

  it("keeps independent Admin sessions active and rejects missing, revoked, expired, and tampered sessions", async () => {
    const { db, app } = appFixture();
    const login = async (ip: string) => app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify({ password: "correct horse" }),
    });
    const [first, second] = await Promise.all([login("127.0.0.11"), login("127.0.0.12")]);
    const firstHeaders = { Origin: "https://admin.flexperiment.ru", Cookie: first.headers.get("set-cookie")! };
    const secondHeaders = { Origin: "https://admin.flexperiment.ru", Cookie: second.headers.get("set-cookie")! };
    await app.request("http://admin.flexperiment.ru/v1/admin/logout", { method: "POST", headers: firstHeaders });
    expect((await app.request("http://admin.flexperiment.ru/v1/admin/session", { headers: firstHeaders })).status).toBe(401);
    expect((await app.request("http://admin.flexperiment.ru/v1/admin/session", { headers: secondHeaders })).status).toBe(200);

    const secondCookieMatch = secondHeaders.Cookie.match(/fx_admin_session=([^;]+)/);
    if (!secondCookieMatch) throw new Error("Expected Admin session cookie");
    const secondCookieValue = secondCookieMatch[1];
    const secondSessionId = JSON.parse(Buffer.from(secondCookieValue.split(".")[0], "base64url").toString("utf8")).sid as string;
    db.prepare("UPDATE admin_sessions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1_000).toISOString(), secondSessionId);
    expect((await app.request("http://admin.flexperiment.ru/v1/admin/session", { headers: secondHeaders })).status).toBe(401);
    expect((await app.request("http://admin.flexperiment.ru/v1/admin/session", { headers: { Origin: "https://admin.flexperiment.ru", Cookie: "fx_admin_session=not-a-session" } })).status).toBe(401);

    const third = await login("127.0.0.13");
    const validCookie = third.headers.get("set-cookie")!;
    const thirdCookieMatch = validCookie.match(/fx_admin_session=([^;]+)/);
    if (!thirdCookieMatch) throw new Error("Expected Admin session cookie");
    const tamperedValue = `${thirdCookieMatch[1].startsWith("A") ? "B" : "A"}${thirdCookieMatch[1].slice(1)}`;
    const tamperedCookie = validCookie.replace(/fx_admin_session=[^;]+/, `fx_admin_session=${tamperedValue}`);
    expect((await app.request("http://admin.flexperiment.ru/v1/admin/session", { headers: { Origin: "https://admin.flexperiment.ru", Cookie: tamperedCookie } })).status).toBe(401);
    const { issueAdminSession } = await import("../src/auth");
    const unknownCookie = issueAdminSession();
    expect((await app.request("http://admin.flexperiment.ru/v1/admin/session", { headers: { Origin: "https://admin.flexperiment.ru", Cookie: `fx_admin_session=${unknownCookie}` } })).status).toBe(401);
    expect((await app.request("http://admin.flexperiment.ru/v1/admin/cities", { headers: { Origin: "https://admin.flexperiment.ru", Cookie: `fx_admin_session=${unknownCookie}` } })).status).toBe(401);
    const sessionCount = db.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get() as { count: number };
    expect(sessionCount.count).toBe(2);
    db.close();
  });

  it("rejects a venue announcement deadline that is not before the occurrence", async () => {
    const { db, app } = appFixture();
    const cityId = (db.prepare("SELECT id FROM cities").get() as { id: string }).id;
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.42" }, body: JSON.stringify({ password: "correct horse" }) });
    const response = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json", "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000012" },
      body: JSON.stringify({ city_id: cityId, title: "Late venue disclosure", starts_at: "2026-10-01T10:00:00.000Z", ends_at: "2026-10-01T13:00:00.000Z", timezone: "Asia/Tomsk", price_kopecks: 100, capacity: 1, venue_status: "TO_BE_ANNOUNCED", venue_disclosure_text: "Venue will be announced later.", venue_announce_by: "2026-10-01T10:00:00.000Z", audit_context: "Admin validation test" }),
    });
    expect(response.status).toBe(422);
    expect(() => db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, venue_status, venue_disclosure_text, venue_announce_by)
      VALUES (?, ?, 'Raw SQL late deadline', '2026-10-01T10:00:00.000Z', '2026-10-01T13:00:00.000Z', 'Asia/Tomsk', 100, 1, 'HIDDEN', 'CLOSED', 'TO_BE_ANNOUNCED', 'Disclosure', '2026-10-01T10:00:00.000Z')`).run(randomUUID(), cityId)).toThrow(/VENUE_ANNOUNCEMENT_TOO_LATE/);
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
    const response = await app.request("http://flexperiment.ru/v1/webhooks/unisender", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT status, job_id FROM email_outbox WHERE id = ?").get(outboxId)).toMatchObject({ status: "DELIVERED", job_id: "job-1" });
    expect(db.prepare("SELECT status, provider_status, job_id FROM email_provider_events WHERE outbox_id = ?").get(outboxId)).toEqual({ status: "DELIVERED", provider_status: "delivered", job_id: "job-1" });
    db.close();
  });

  it("offers the Unisender GET verification response and keeps callback POST authentication mandatory", async () => {
    const { db } = appFixture();
    const apiKey = "test-api-key-not-a-secret";
    const app = createApp(db, new MockProvider(), new UnisenderGoProvider({ apiKey, fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async () => Response.json({ status: "success", job_id: "job" })));

    const probe = await app.request("http://api.flexperiment.ru/v1/webhooks/unisender");
    expect(probe.status).toBe(200);
    expect(probe.headers.get("cache-control")).toBe("no-store");
    expect(await probe.json()).toEqual({ ok: true });

    const unsignedPost = await app.request("http://api.flexperiment.ru/v1/webhooks/unisender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unsignedPost.status).toBe(401);
    expect(await unsignedPost.json()).toEqual({ error: { code: "UNISENDER_WEBHOOK_AUTH_INVALID" } });
    db.close();
  });

  it("preserves the exact Unisender bounce outcome instead of collapsing provider evidence", async () => {
    const { db } = appFixture();
    const outboxId = randomUUID();
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key)
      VALUES (?, 'BOOKING_CANCELLED', 'buyer@example.test', 'hash', 'booking-cancelled', '{}', 'soft-bounce-key')`).run(outboxId);
    const apiKey = "test-api-key-not-a-secret";
    const app = createApp(db, new MockProvider(), new UnisenderGoProvider({ apiKey, fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async () => Response.json({ status: "success", job_id: "job" })));
    const unsigned = JSON.stringify({ auth: "pending", events_by_user: [{ user_id: 1, events: [{ event_name: "transactional_email_status", event_data: { job_id: "job-2", metadata: { outbox_id: outboxId }, status: "soft_bounced", event_time: "2026-08-20 00:00:00" } }] }] });
    const body = unsigned.replace("pending", createHash("md5").update(unsigned.replace("pending", apiKey)).digest("hex"));
    expect((await app.request("http://flexperiment.ru/v1/webhooks/unisender", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body })).status).toBe(200);
    expect(db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "BOUNCED" });
    expect(db.prepare("SELECT status, provider_status FROM email_provider_events WHERE outbox_id = ?").get(outboxId)).toEqual({ status: "BOUNCED", provider_status: "soft_bounced" });
    db.close();
  });

  it("decomposes REVIEW_REQUIRED into per-table dashboard counters whose predicates match their filtered destinations", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;
    const checkout = async (idempotencyKey: string, email: string) => {
      const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.71" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
      const quoteId = (await context.json() as { quote_id: string }).quote_id;
      await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Forwarded-For": "127.0.0.71" }, body: JSON.stringify({ quote_id: quoteId, customer_email: email, customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }) });
      const order = db.prepare("SELECT id FROM orders WHERE customer_email = ?").get(email) as { id: string };
      const payment = db.prepare("SELECT id FROM payments WHERE order_id = ?").get(order.id) as { id: string };
      return { orderId: order.id, paymentId: payment.id };
    };
    const reviewPayment = await checkout("review-required-payment-checkout", "review-payment@example.test");
    db.prepare("UPDATE payments SET status = 'REVIEW_REQUIRED' WHERE id = ?").run(reviewPayment.paymentId);
    const reviewRefundOrder = await checkout("review-required-refund-checkout", "review-refund@example.test");
    db.prepare("UPDATE payments SET status = 'PAID', captured_amount_kopecks = 100000 WHERE id = ?").run(reviewRefundOrder.paymentId);
    const reviewRefundId = randomUUID();
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash) VALUES (?, ?, ?, ?, 100, 'Under review', 'ADMIN_COMPENSATION', 'REVIEW_REQUIRED', ?, ?)").run(reviewRefundId, randomUUID(), reviewRefundOrder.orderId, reviewRefundOrder.paymentId, randomUUID(), randomUUID());

    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.71" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")! };

    const dashboard = await app.request("http://admin.flexperiment.ru/v1/admin/dashboard", { headers });
    const dashboardBody = await dashboard.json() as { health: Record<string, { count: number }> };
    expect(dashboardBody.health.review_required_payments.count).toBe(1);
    expect(dashboardBody.health.review_required_refunds.count).toBe(1);

    // The counter predicate (payments.status = 'REVIEW_REQUIRED') must match the
    // destination filter predicate exactly, or the deep-link would show a
    // different set than what was counted.
    const filteredOrders = await app.request("http://admin.flexperiment.ru/v1/admin/orders?payment_status=REVIEW_REQUIRED", { headers });
    const filteredOrdersBody = await filteredOrders.json() as { orders: { id: string }[] };
    expect(filteredOrdersBody.orders.map((order) => order.id)).toEqual([reviewPayment.orderId]);

    const filteredRefunds = await app.request("http://admin.flexperiment.ru/v1/admin/refunds?status=REVIEW_REQUIRED", { headers });
    const filteredRefundsBody = await filteredRefunds.json() as { refunds: { id: string }[] };
    expect(filteredRefundsBody.refunds.map((refund) => refund.id)).toEqual([reviewRefundId]);
    db.close();
  });

  it("filters /refunds by status and source independently", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;
    const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.72" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
    const quoteId = (await context.json() as { quote_id: string }).quote_id;
    await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": "refund-filter-checkout", "X-Forwarded-For": "127.0.0.72" }, body: JSON.stringify({ quote_id: quoteId, customer_email: "refund-filter@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }) });
    const order = db.prepare("SELECT id FROM orders ORDER BY created_at DESC LIMIT 1").get() as { id: string };
    const payment = db.prepare("SELECT id FROM payments WHERE order_id = ?").get(order.id) as { id: string };
    db.prepare("UPDATE payments SET status = 'PARTIALLY_REFUNDED', captured_amount_kopecks = 100000 WHERE id = ?").run(payment.id);
    const pendingCompensationId = randomUUID(); const succeededObligationId = randomUUID();
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash) VALUES (?, ?, ?, ?, 100, 'Pending', 'ADMIN_COMPENSATION', 'REQUESTED', ?, ?)").run(pendingCompensationId, randomUUID(), order.id, payment.id, randomUUID(), randomUUID());
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 100, 'Done', 'REFUND_OBLIGATION', 'SUCCEEDED', ?, ?, datetime('now'))").run(succeededObligationId, randomUUID(), order.id, payment.id, randomUUID(), randomUUID());

    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.72" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")! };

    const byStatus = await app.request("http://admin.flexperiment.ru/v1/admin/refunds?status=REQUESTED", { headers });
    expect((await byStatus.json() as { refunds: { id: string }[] }).refunds.map((refund) => refund.id)).toEqual([pendingCompensationId]);
    const bySource = await app.request("http://admin.flexperiment.ru/v1/admin/refunds?source=REFUND_OBLIGATION", { headers });
    expect((await bySource.json() as { refunds: { id: string }[] }).refunds.map((refund) => refund.id)).toEqual([succeededObligationId]);
    const byBoth = await app.request("http://admin.flexperiment.ru/v1/admin/refunds?status=SUCCEEDED&source=REFUND_OBLIGATION", { headers });
    expect((await byBoth.json() as { refunds: { id: string }[] }).refunds.map((refund) => refund.id)).toEqual([succeededObligationId]);
    db.close();
  });

  it("matches the pending_refunds dashboard counter's multi-state predicate via repeated status params", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;
    // one_nonterminal_refund_per_payment forbids two non-terminal refunds on
    // the same payment, so each pending status needs its own order/payment.
    const ids: Record<string, string> = {};
    let ipSuffix = 195;
    for (const status of ["REQUESTED", "SUBMITTING", "SUBMIT_UNKNOWN", "RECONCILING", "SUCCEEDED"]) {
      const email = `pending-refunds-${status.toLowerCase()}@example.test`;
      const ip = `127.0.0.${ipSuffix++}`; // "checkout-new" allows only 3 first-time checkouts per IP / 10min
      const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
      const quoteId = (await context.json() as { quote_id: string }).quote_id;
      const checkout = await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": `pending-refunds-checkout-${status}`, "X-Forwarded-For": ip }, body: JSON.stringify({ quote_id: quoteId, customer_email: email, customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }) });
      expect(checkout.status).toBe(201);
      const order = db.prepare("SELECT id FROM orders WHERE customer_email = ?").get(email) as { id: string };
      const payment = db.prepare("SELECT id FROM payments WHERE order_id = ?").get(order.id) as { id: string };
      db.prepare("UPDATE payments SET status = 'PARTIALLY_REFUNDED', captured_amount_kopecks = 100000 WHERE id = ?").run(payment.id);
      const id = randomUUID(); ids[status] = id;
      const succeededAt = status === "SUCCEEDED" ? ", succeeded_at" : "";
      const succeededAtValue = status === "SUCCEEDED" ? ", datetime('now')" : "";
      db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash${succeededAt}) VALUES (?, ?, ?, ?, 1, 'r', 'ADMIN_COMPENSATION', ?, ?, ?${succeededAtValue})`).run(id, randomUUID(), order.id, payment.id, status, randomUUID(), randomUUID());
    }

    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.73" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")! };

    const dashboard = await app.request("http://admin.flexperiment.ru/v1/admin/dashboard", { headers });
    expect((await dashboard.json() as { health: Record<string, { count: number }> }).health.pending_refunds.count).toBe(4);

    const filtered = await app.request("http://admin.flexperiment.ru/v1/admin/refunds?status=REQUESTED&status=SUBMITTING&status=SUBMIT_UNKNOWN&status=RECONCILING", { headers });
    const filteredIds = (await filtered.json() as { refunds: { id: string }[] }).refunds.map((refund) => refund.id).sort();
    expect(filteredIds).toEqual([ids.REQUESTED, ids.SUBMITTING, ids.SUBMIT_UNKNOWN, ids.RECONCILING].sort());
    db.close();
  });
});
