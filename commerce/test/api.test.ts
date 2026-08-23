import { createHash, randomUUID, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { MockProvider } from "../src/provider";
import { UnisenderGoProvider } from "../src/email-provider";
import { CommerceDomain } from "../src/domain";
import { decryptTicketCapability } from "../src/crypto";
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

    const tour = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "x-commerce-trusted-client-ip": "127.0.0.22" } });
    const visible = await tour.json() as { cities: { city: string; sales_status: string }[] };
    expect(visible.cities.map((entry) => entry.city)).toEqual(["closed-city", "tomsk"]);
    expect(visible.cities.find((entry) => entry.city === "closed-city")).toMatchObject({ sales_status: "CLOSED" });
    expect(visible.cities.some((entry) => entry.city === "hidden-city" || entry.city === "empty-city")).toBe(false);

    db.prepare("UPDATE occurrences SET sales_status = 'CLOSED', visibility = 'HIDDEN' WHERE visibility = 'PUBLISHED'").run();
    const emptyTour = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "x-commerce-trusted-client-ip": "127.0.0.23" } });
    expect(await emptyTour.json()).toEqual({ cities: [] });
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

  it("exposes settlement evidence as a pure Admin read and requires idempotency for lifecycle commands", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const agentId = randomUUID(); const settlementId = randomUUID();
    db.prepare("INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, npd_status_checked_at, default_reward_type, default_reward_value) VALUES (?, 'settlement-api-agent', 'Settlement Agent', 'Settlement Agent Legal', 'settlement-agent@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', datetime('now'), 'FIXED', 100)").run(agentId);
    db.prepare("INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id) VALUES (?, ?, ?, 100, 'TRANSFER', 'PREPARED', 'SELF_EMPLOYED', ?, 'admin')").run(settlementId, agentId, occurrenceId, new Date().toISOString());
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.57" }, body: JSON.stringify({ password: "correct horse" }) });
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
    const first = await app.request(`http://admin.flexperiment.ru/v1/admin/reward-settlements/${settlementId}/payment-made`, { method: "POST", headers: { ...headers, "Idempotency-Key": "settlement-api-payment-key" }, body: JSON.stringify({ confirmation_text: "I confirm the money was transferred" }) });
    expect(await first.json()).toMatchObject({ id: settlementId, status: "PENDING_DOCUMENT" });
    const replay = await app.request(`http://admin.flexperiment.ru/v1/admin/reward-settlements/${settlementId}/payment-made`, { method: "POST", headers: { ...headers, "Idempotency-Key": "settlement-api-payment-key" }, body: JSON.stringify({ confirmation_text: "I confirm the money was transferred" }) });
    expect(await replay.json()).toMatchObject({ id: settlementId, status: "PENDING_DOCUMENT" });
    db.close();
  });

  it("requires a session-bound reauthentication capability to cancel an occurrence", async () => {
    const { db, app } = appFixture();
    const occurrenceId = (db.prepare("SELECT id FROM occurrences LIMIT 1").get() as { id: string }).id;
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.44" },
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
    const loginHeaders = { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.47" };
    const firstLogin = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: loginHeaders, body: JSON.stringify({ password: "correct horse" }) });
    const firstHeaders = { Origin: "https://admin.flexperiment.ru", Cookie: firstLogin.headers.get("set-cookie")!, "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.47" };
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
      headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.45" },
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
      headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.88" },
      body: JSON.stringify({ order_number: "FX-NOT-AN-ORDER", captcha_token: "proof" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(verified).toBe(1);
    db.close();
  });

  it("fails closed before refund lookup when SmartCaptcha rejects or is unavailable", async () => {
    for (const [result, status, code] of [["INVALID", 422, "CAPTCHA_INVALID"], ["UNAVAILABLE", 503, "CAPTCHA_UNAVAILABLE"]] as const) {
      const { db, app } = appFixture({ verify: async () => result });
      const response = await app.request("http://api.flexperiment.ru/v1/public/refunds/request", {
        method: "POST",
        headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": `127.0.0.${status}` },
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
      headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.89" },
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
        headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": `127.0.0.${city.length}` },
        body: JSON.stringify({ email: "withdraw@example.test", city, pd_consent_accepted: true, captcha_token: "proof" }),
      });
      expect(response.status).toBe(202);
    }
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.99" }, body: JSON.stringify({ password: "correct horse" }) });
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
    const checkout = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "995e27bc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru");
    const order = db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string; public_order_number: string; payment_id: string };
    domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    const token = db.prepare("SELECT token_ciphertext, token_nonce FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id) as { token_ciphertext: string; token_nonce: string };
    const capability = decryptTicketCapability(token.token_ciphertext, token.token_nonce);
    const context = await app.request("http://api.flexperiment.ru/v1/public/refunds/confirmation-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.46" }, body: JSON.stringify({ token: capability }) });
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({ order_number: order.public_order_number, eligibility: "ELIGIBLE", amount_remaining_kopecks: 100000 });
    expect(db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CONFIRMED" });
    expect(db.prepare("SELECT consumed_at FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id)).toMatchObject({ consumed_at: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM refund_obligations WHERE payment_id = ?").get(order.payment_id)).toMatchObject({ count: 0 });
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
    const cityPayload = { city_slug: "omsk", reason: "Tochka Phase 0 certification" };
    const cityKey = "b6a8e45a-9334-4626-8041-000000000001";
    const mismatchedCity = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000009" }, body: JSON.stringify({ ...cityPayload, title: "Томск" }) });
    expect(mismatchedCity.status).toBe(422);
    const unsupportedCity = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000000" }, body: JSON.stringify({ city_slug: "unsupported-city", reason: "Catalog validation test" }) });
    expect(unsupportedCity.status).toBe(400);
    expect(await unsupportedCity.json()).toEqual({ error: { code: "CITY_SLUG_UNKNOWN" } });
    const firstCity = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify(cityPayload) });
    expect(firstCity.status).toBe(201);
    const city = await firstCity.json() as { id: string; slug: string; title: string };
    expect(city).toMatchObject({ slug: "omsk", title: "Омск" });
    const cityReplay = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify(cityPayload) });
    expect(await cityReplay.json()).toMatchObject({ id: city.id });
    const changedReplay = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": cityKey }, body: JSON.stringify({ ...cityPayload, reason: "Different canonical request" }) });
    expect(changedReplay.status).toBe(409);
    const duplicateSlug = await app.request("http://admin.flexperiment.ru/v1/admin/cities", { method: "POST", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000006" }, body: JSON.stringify(cityPayload) });
    expect(duplicateSlug.status).toBe(409);
    const cityPatch = await app.request(`http://admin.flexperiment.ru/v1/admin/cities/${city.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000007" }, body: JSON.stringify({ city_slug: "moscow", reason: "Corrected canonical city" }) });
    expect(cityPatch.status).toBe(200);
    expect(await cityPatch.json()).toMatchObject({ id: city.id, slug: "moscow", title: "Москва" });
    db.prepare("UPDATE cities SET title = ? WHERE id = ?").run("Incorrect title", city.id);
    const canonicalTitleRepair = await app.request(`http://admin.flexperiment.ru/v1/admin/cities/${city.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000010" }, body: JSON.stringify({ city_slug: "moscow", reason: "Canonical title repair" }) });
    expect(await canonicalTitleRepair.json()).toMatchObject({ id: city.id, slug: "moscow", title: "Москва" });
    const cityWithOccurrenceId = (db.prepare("SELECT id FROM cities WHERE slug = 'tomsk'").get() as { id: string }).id;
    const blockedPatch = await app.request(`http://admin.flexperiment.ru/v1/admin/cities/${cityWithOccurrenceId}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000008" }, body: JSON.stringify({ city_slug: "kazan", reason: "Unsafe historical mutation" }) });
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

    const published = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000011" }, body: JSON.stringify({ price_kopecks: 100, capacity: 1, visibility: "PUBLISHED", reason: "Tochka Phase 0 certification" }) });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ id: created.id, visibility: "PUBLISHED", sales_status: "CLOSED" });
    const opened = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000012" }, body: JSON.stringify({ sales_status: "OPEN", reason: "Tochka Phase 0 certification" }) });
    expect(opened.status).toBe(200);
    const openedReplay = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000012" }, body: JSON.stringify({ sales_status: "OPEN", reason: "Tochka Phase 0 certification" }) });
    expect(await openedReplay.json()).toMatchObject({ id: created.id, visibility: "PUBLISHED", sales_status: "OPEN" });
    const patchConflict = await app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${created.id}`, { method: "PATCH", headers: { ...adminHeaders, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000012" }, body: JSON.stringify({ sales_status: "CLOSED", reason: "Changed patch" }) });
    expect(patchConflict.status).toBe(409);
    const after = await app.request("http://api.flexperiment.ru/v1/public/tour", { headers: { Origin: "https://flexperiment.ru", "x-commerce-trusted-client-ip": "127.0.0.1" } });
    expect((await after.json() as { cities: { id?: string }[] }).cities.some((entry) => entry.id === created.id)).toBe(true);
    expect(db.prepare("SELECT admin_id, action, entity_type, entity_id, details_json FROM admin_audit_log WHERE entity_id = ?").get(created.id)).toMatchObject({
      admin_id: expect.any(String), action: "OCCURRENCE_CREATED", entity_type: "occurrence", entity_id: created.id,
    });
    const evidence = JSON.parse(String((db.prepare("SELECT details_json FROM admin_audit_log WHERE entity_id = ?").get(created.id) as { details_json: string }).details_json));
    expect(evidence).toMatchObject({ reason: occurrencePayload.reason, idempotency_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/), canonical_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
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
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.55" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const patch = (key: string, payload: Record<string, unknown>) => app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${occurrenceId}`, {
      method: "PATCH", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ ...payload, reason: "Occurrence lifecycle test" }),
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
      headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.56" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const patch = (occurrenceId: string, key: string, payload: Record<string, unknown>) => app.request(`http://admin.flexperiment.ru/v1/admin/occurrences/${occurrenceId}`, {
      method: "PATCH", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ ...payload, reason: "Legacy state recovery" }),
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
    const context = await app.request("http://api.flexperiment.ru/v1/public/checkout-context", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.1" }, body: JSON.stringify({ occurrence_id: occurrenceId }) });
    const quoteId = (await context.json() as { quote_id: string }).quote_id;
    await app.request("http://api.flexperiment.ru/v1/public/checkouts", { method: "POST", headers: { Origin: "https://flexperiment.ru", "Content-Type": "application/json", "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000009", "x-commerce-trusted-client-ip": "127.0.0.1" }, body: JSON.stringify({ quote_id: quoteId, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }) });
    const orderId = (db.prepare("SELECT id FROM orders").get() as { id: string }).id;
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.1" }, body: JSON.stringify({ password: "correct horse" }) });
    const headers = { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const beforeCount = db.prepare("SELECT COUNT(*) AS count FROM reservation_abandonments").get();
    const evidence = await app.request(`http://admin.flexperiment.ru/v1/admin/orders/${orderId}/evidence`, { headers });
    expect(evidence.status).toBe(200);
    expect(evidence.headers.get("cache-control")).toBe("no-store");
    const evidenceBody = await evidence.json() as { order: { id: string }; payment: Record<string, unknown>; booking: { status: string }; ticket: unknown; email_outbox: unknown[] };
    expect(evidenceBody).toMatchObject({ order: { id: orderId }, booking: { status: "RESERVED" }, ticket: null, email_outbox: [] });
    expect(evidenceBody.payment).not.toHaveProperty("payment_url");
    expect(db.prepare("SELECT COUNT(*) AS count FROM reservation_abandonments").get()).toEqual(beforeCount);
    const abandoned = await app.request(`http://admin.flexperiment.ru/v1/admin/orders/${orderId}/abandon-reservation`, { method: "POST", headers: { ...headers, "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000010" }, body: JSON.stringify({ reason: "Certification interrupted before payment" }) });
    expect(abandoned.status).toBe(200);
    expect(await abandoned.json()).toMatchObject({ status: "CANCELLED" });
    db.close();
  });

  it("uses durable server-side Admin sessions and revokes the exact cookie on logout", async () => {
    const { db, app } = appFixture();
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.1" }, body: JSON.stringify({ password: "correct horse" }) });
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
      method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": ip }, body: JSON.stringify({ password: "correct horse" }),
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
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", { method: "POST", headers: { Origin: "https://admin.flexperiment.ru", "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.42" }, body: JSON.stringify({ password: "correct horse" }) });
    const response = await app.request("http://admin.flexperiment.ru/v1/admin/occurrences", {
      method: "POST",
      headers: { Origin: "https://admin.flexperiment.ru", Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json", "Idempotency-Key": "b6a8e45a-9334-4626-8041-000000000012" },
      body: JSON.stringify({ city_id: cityId, title: "Late venue disclosure", starts_at: "2026-10-01T10:00:00.000Z", ends_at: "2026-10-01T13:00:00.000Z", timezone: "Asia/Tomsk", price_kopecks: 100, capacity: 1, venue_status: "TO_BE_ANNOUNCED", venue_disclosure_text: "Venue will be announced later.", venue_announce_by: "2026-10-01T10:00:00.000Z", reason: "Admin validation test" }),
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
    const response = await app.request("http://flexperiment.ru/v1/webhooks/unisender", { method: "POST", headers: { "Content-Type": "application/json", "x-commerce-trusted-client-ip": "127.0.0.1" }, body });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT status, job_id FROM email_outbox WHERE id = ?").get(outboxId)).toMatchObject({ status: "DELIVERED", job_id: "job-1" });
    db.close();
  });
});
