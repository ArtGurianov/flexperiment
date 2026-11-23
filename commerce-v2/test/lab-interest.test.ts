import { labInterestManifest, labInterestManifestBytes, labInterestManifestSha256 } from "./fixtures/lab-interest";
import { parseLabInterestManifest } from "../src/lab-interest-legal";
import { LabInterestMailError } from "../src/lab-interest-mail";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { migrateV2 } from "../src/db";
import { applyV2Seed } from "../src/seed";
import { loadCommerceRuntimeConfig, type CommerceRuntimeConfig } from "../src/payment-mode";
import {
  confirmLabInterest, dispatchLabSalesOpenedNotices, labInterestWithdrawToken,
  prepareLabSalesOpenedNotices, purgeLabInterest, type LabInterestEmail,
} from "../src/lab-interest";
import { labShowcaseSchema } from "../../lib/lab-showcase-contract";
import { setTestStorefronts, withTestStorefrontSwitch } from "./fixtures/sales";

const LAB = "http://localhost:3000";
const SECRET = "synthetic-lab-interest-secret";
const consent = labInterestManifest.consent;
let db: Database.Database;
let clock: Date;
let sent: LabInterestEmail[];

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  clock = new Date("2026-11-22T10:00:00Z"); sent = [];
  applyV2Seed(db, {
    cities: [{ slug: "fixture-city", title: "Isolated fixture city" }, { slug: "other-city", title: "Other fixture city" }],
    labOccurrences: [
      { occurrenceRef: "closed-event", citySlug: "fixture-city", title: "Closed fixture event", startsAt: "2026-12-05T10:00:00Z",
        endsAt: "2026-12-05T12:00:00Z", timezone: "Europe/Moscow", capacity: 7,
        venue: { status: "CONFIRMED", name: "Fixture studio", address: "Fixture street 1", public: true } },
      { occurrenceRef: "private-event", citySlug: "other-city", title: "Acceptance fixture event", startsAt: "2026-12-06T10:00:00Z",
        endsAt: "2026-12-06T12:00:00Z", timezone: "Europe/Moscow", capacity: 7,
        venue: { status: "TO_BE_ANNOUNCED", disclosureText: "Адрес сообщим позже", announceBy: "2026-12-01T10:00:00Z" } },
    ],
    products: [
      { productRef: "lab:closed-event", occurrenceRef: "closed-event", kind: "LAB", accessModel: "PAID", offerRef: "lab:closed-event", priceKopecks: 250000, saleMode: "CLOSED" },
      { productRef: "lab:private-event", occurrenceRef: "private-event", kind: "LAB", accessModel: "PAID", offerRef: "lab:private-event", priceKopecks: 99900, saleMode: "CLOSED" },
    ],
  });
  db.prepare("UPDATE lab_occurrences SET visibility='LISTED'").run();
  db.prepare("UPDATE offers SET sale_mode='ACCEPTANCE_ONLY',acceptance_allowlist_json='[\"secret-owner@example.invalid\"]' WHERE offer_ref='lab:private-event'").run();
});
afterEach(() => db.close());

const config = (env: Record<string, string> = { PAYMENT_MODE: "disabled" }) =>
  withTestStorefrontSwitch(loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", ...env })) as CommerceRuntimeConfig;
const server = (options: { enabled?: boolean; manifest?: false; mail?: false | ((message: LabInterestEmail) => Promise<void>); runtime?: CommerceRuntimeConfig } = {}) =>
  createCommerceV2App({
    db, config: options.runtime ?? config(), sourceCommit: "a".repeat(40), serviceToken: "isolated-fixture", now: () => clock,
    campaignUnsubscribeSecret: SECRET, labGuestTrustedProxyIps: ["10.0.5.4"], labGuestPeerAddress: () => "10.0.5.4",
    labInterestSignupsEnabled: options.enabled ?? true, labInterestManifest: options.manifest === false ? undefined : labInterestManifest,
    sendLabInterestEmail: options.mail === false ? undefined : options.mail ?? (async (message) => { sent.push(message); }),
  });
const post = (app: ReturnType<typeof server>, path: string, body: unknown, origin: string | null = LAB) => app.request(path, {
  method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.10", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
});
const cityId = (slug: string) => (db.prepare("SELECT id FROM cities WHERE slug=?").get(slug) as { id: string }).id;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** Every table's row count except the interest store and the hashed rate-limit buckets. */
const snapshot = () => Object.fromEntries((db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
  AND name NOT IN ('lab_interest_signups','lab_interest_notices','lab_guest_rate_limits') ORDER BY name`).all() as Array<{ name: string }>)
  .map(({ name }) => [name, count(`"${name}"`)]));
const tokenFrom = (url: string, key: string) => new URL(url).hash.slice(1).split("=")[1]!.replace(new RegExp(`^${key}=`), "");

describe("FLEX-8 public LAB showcase with closed sales", () => {
  it("shows published CLOSED events with dates and prices and a clear closed status, without writing", async () => {
    const before = db.prepare("SELECT total_changes() AS n").get();
    const response = await server().request("/v1/lab/showcase");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = labShowcaseSchema.parse(await response.json());
    expect(body.sales).toEqual({ state: "CLOSED", reason: "PAYMENTS_DISABLED" });
    expect(body.occurrences).toEqual([{ occurrenceRef: "closed-event", cityId: cityId("fixture-city"), title: "Closed fixture event",
      startsAt: "2026-12-05T10:00:00Z", endsAt: "2026-12-05T12:00:00Z", timezone: "Europe/Moscow", amountKopecks: 250000, currency: "RUB",
      venue: { status: "CONFIRMED", name: "Fixture studio", address: "Fixture street 1" }, sales: "CLOSED" }]);
    expect(body.interest).toEqual({ available: true, consent, privacy: labInterestManifest.privacy });
    expect(JSON.stringify(body)).not.toMatch(/secret-owner|allowlist|capacity|soldOut|Acceptance fixture/);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    // The purchasable catalogue still lists nothing: CLOSED offers are information only.
    expect((await (await server().request("/v1/lab/catalogue")).json()).occurrences).toEqual([]);
  });

  it("explains a closed LAB storefront and a closed offer separately from disabled payments", async () => {
    const mock = config({ PAYMENT_MODE: "mock" });
    setTestStorefronts(db, { LAB: "CLOSED", COURSES: "OPEN" });
    expect((await (await server({ runtime: mock }).request("/v1/lab/showcase")).json()).sales).toEqual({ state: "CLOSED", reason: "STOREFRONT_CLOSED" });
    setTestStorefronts(db, { LAB: "OPEN" });
    expect((await (await server({ runtime: mock }).request("/v1/lab/showcase")).json()).sales).toEqual({ state: "CLOSED", reason: "OFFERS_CLOSED" });
    db.prepare("UPDATE offers SET sale_mode='PUBLIC' WHERE offer_ref='lab:closed-event'").run();
    const open = await (await server({ runtime: mock }).request("/v1/lab/showcase")).json();
    expect(open.sales).toEqual({ state: "OPEN", reason: null }); expect(open.occurrences[0].sales).toBe("OPEN");
  });

  it("hides finished, cancelled, unlisted and withdrawn events", async () => {
    db.prepare("UPDATE lab_occurrences SET visibility='UNLISTED'").run();
    expect((await (await server().request("/v1/lab/showcase")).json()).occurrences).toEqual([]);
    db.prepare("UPDATE lab_occurrences SET visibility='LISTED'").run();
    clock = new Date("2026-12-05T10:00:01Z");
    expect((await (await server().request("/v1/lab/showcase")).json()).occurrences).toEqual([]);
    clock = new Date("2026-11-22T10:00:00Z");
    db.prepare("UPDATE products SET withdrawn_at='2026-11-21',withdrawn_reason='fixture',withdrawn_terms_ref='fixture-terms'").run();
    expect((await (await server().request("/v1/lab/showcase")).json()).occurrences).toEqual([]);
  });

  it("reports interest as unavailable without a mail transport", async () => {
    expect((await (await server({ mail: false }).request("/v1/lab/showcase")).json()).interest.available).toBe(false);
  });

  it("requires an independently pinned LAB_INTEREST manifest before collecting email", async () => {
    expect(parseLabInterestManifest(labInterestManifestBytes, "0".repeat(64))).toBeUndefined();
    expect(parseLabInterestManifest(labInterestManifestBytes, labInterestManifestSha256)).toEqual(labInterestManifest);
    const app = server({ manifest: false });
    const showcase = await app.request("/v1/lab/showcase");
    expect(showcase.status).toBe(200);
    expect((await showcase.json()).interest).toEqual({ available: false, consent: null, privacy: null });
    expect((await post(app, "/v1/lab/interest", { email: "fan@example.test", cityId: cityId("fixture-city"), consent })).status).toBe(503);
    expect(count("lab_interest_signups")).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("FLEX-8 interest signup (double opt-in)", () => {
  it("records interest only: zero customers, orders, seat holds, payment attempts, tickets or guest access", async () => {
    const before = snapshot();
    const response = await post(server(), "/v1/lab/interest", { email: " Visitor@Example.TEST ", cityId: cityId("fixture-city"), consent });
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ accepted: true });
    expect(snapshot()).toEqual(before);
    for (const table of ["customers", "orders", "order_lines", "checkout_quotes", "checkout_attempts", "lab_guest_access", "lab_tickets", "refund_requests"]) {
      expect(count(table)).toBe(0);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkout_quotes WHERE seat_hold_ref IS NOT NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT email_normalized,state,purpose,consent_text_version,consent_text_sha256,confirmed_at FROM lab_interest_signups").all())
      .toEqual([{ email_normalized: "visitor@example.test", state: "PENDING", purpose: "LAB_SALES_NOTICE",
        consent_text_version: consent.version, consent_text_sha256: consent.textSha256, confirmed_at: null }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "CONFIRM", email: "visitor@example.test", cityTitle: "Isolated fixture city" });
    // Only the hash of the confirmation token is stored.
    const token = tokenFrom((sent[0] as { confirmUrl: string }).confirmUrl, "confirm");
    expect(JSON.stringify(db.prepare("SELECT * FROM lab_interest_signups").all())).not.toContain(token);
  });

  it("refuses without consent, from another origin, without mail, and for an unknown city, storing nothing", async () => {
    const app = server();
    expect((await post(app, "/v1/lab/interest", { email: "a@example.test" })).status).toBe(422);
    expect((await post(app, "/v1/lab/interest", { email: "a@example.test", cityId: cityId("fixture-city"), consent: { ...consent, textSha256: "0".repeat(64) } })).status).toBe(422);
    expect((await post(app, "/v1/lab/interest", { email: "a@example.test", cityId: cityId("fixture-city"), consent }, "https://evil.example")).status).toBe(403);
    expect((await post(app, "/v1/lab/interest", { email: "a@example.test", cityId: cityId("fixture-city"), consent }, null)).status).toBe(403);
    expect((await post(app, "/v1/lab/interest", { email: "not-an-email", cityId: cityId("fixture-city"), consent })).status).toBe(422);
    expect((await post(app, "/v1/lab/interest", { email: "a@example.test", cityId: "missing", consent })).status).toBe(422);
    expect((await post(app, "/v1/lab/interest", { email: "missing-city@example.test", consent })).status).toBe(422);
    expect((await post(server({ mail: false }), "/v1/lab/interest", { email: "a@example.test", cityId: cityId("fixture-city"), consent })).status).toBe(503);
    expect(count("lab_interest_signups")).toBe(0); expect(sent).toHaveLength(0);
  });

  it("keeps the showcase and withdrawals available without accepting registrations before approval", async () => {
    await post(server(), "/v1/lab/interest", { email: "existing@example.test", cityId: cityId("fixture-city"), consent });
    const confirmation = sent[0] as Extract<LabInterestEmail, { kind: "CONFIRM" }>;
    const app = server({ enabled: false });
    expect((await app.request("/v1/lab/showcase")).status).toBe(200);
    expect((await post(app, "/v1/lab/interest", { email: "new@example.test", cityId: cityId("fixture-city"), consent })).status).toBe(503);
    expect((await post(app, "/v1/lab/interest/confirm", { token: tokenFrom(confirmation.confirmUrl, "confirm") })).status).toBe(503);
    expect((await post(app, "/v1/lab/interest/withdraw", { token: tokenFrom(confirmation.withdrawUrl, "withdraw") })).status).toBe(200);
    expect(count("lab_interest_signups")).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("does not keep an address whose confirmation could not be sent", async () => {
    const response = await post(server({ mail: async () => { throw new LabInterestMailError("LAB_INTEREST_MAIL_REJECTED"); } }), "/v1/lab/interest", { email: "a@example.test", cityId: cityId("fixture-city"), consent });
    expect(response.status).toBe(202); expect(count("lab_interest_signups")).toBe(0);
  });

  it("keeps an ambiguously sent link usable and does not mail again on duplicate sign-up", async () => {
    let confirmation: string | undefined;
    let calls = 0;
    const app = server({ mail: async message => {
      calls++;
      if (message.kind === "CONFIRM") confirmation = tokenFrom(message.confirmUrl, "confirm");
      throw new LabInterestMailError("LAB_INTEREST_MAIL_AMBIGUOUS");
    } });
    for (let i = 0; i < 2; i++) {
      expect((await post(app, "/v1/lab/interest", { email: "a@example.test", cityId: cityId("fixture-city"), consent })).status).toBe(202);
    }
    expect(calls).toBe(1);
    expect((await post(app, "/v1/lab/interest/confirm", { token: confirmation })).status).toBe(200);
    expect(db.prepare("SELECT state FROM lab_interest_signups").get()).toEqual({ state: "CONFIRMED" });
  });

  it("answers identically for suppressed, confirmed and rate-limited addresses", async () => {
    db.prepare("INSERT INTO email_suppressions(email_normalized,reason) VALUES ('suppressed@example.test','ONE_CLICK')").run();
    const app = server();
    const suppressed = await post(app, "/v1/lab/interest", { email: "suppressed@example.test", cityId: cityId("fixture-city"), consent });
    expect(suppressed.status).toBe(202); expect(await suppressed.json()).toEqual({ accepted: true });
    expect(count("lab_interest_signups")).toBe(0); expect(sent).toHaveLength(0);
    for (let attempt = 0; attempt < 5; attempt++) expect((await post(app, "/v1/lab/interest", { email: "busy@example.test", cityId: cityId("fixture-city"), consent })).status).toBe(202);
    expect(sent).toHaveLength(1); // repeats do not rotate an unexpired link
    expect(count("lab_interest_signups")).toBe(1);
  });

  it("confirms once, withdraws by link or one-click, and withdrawal deletes the row", async () => {
    const app = server();
    await post(app, "/v1/lab/interest", { email: "visitor@example.test", cityId: cityId("fixture-city"), consent });
    const message = sent[0] as Extract<LabInterestEmail, { kind: "CONFIRM" }>;
    const token = tokenFrom(message.confirmUrl, "confirm");
    expect((await post(app, "/v1/lab/interest/confirm", { token }, "https://evil.example")).status).toBe(403);
    expect((await post(app, "/v1/lab/interest/confirm", { token })).status).toBe(200);
    expect((await post(app, "/v1/lab/interest/confirm", { token })).status).toBe(422);
    expect(db.prepare("SELECT state,confirm_token_sha256 FROM lab_interest_signups").get()).toEqual({ state: "CONFIRMED", confirm_token_sha256: null });
    // A repeated signup of a confirmed address sends nothing.
    await post(app, "/v1/lab/interest", { email: "visitor@example.test", cityId: cityId("fixture-city"), consent }); expect(sent).toHaveLength(1);
    const withdraw = tokenFrom(message.withdrawUrl, "withdraw");
    expect((await post(app, "/v1/lab/interest/withdraw", { token: withdraw.slice(0, -2) + "xx" }, null)).status).toBe(422);
    expect((await app.request(`/v1/lab/interest/withdraw?token=${encodeURIComponent(withdraw)}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" })).status).toBe(200);
    expect(count("lab_interest_signups")).toBe(0);
    expect(db.prepare("SELECT email_normalized FROM lab_interest_suppressions").all())
      .toEqual([{ email_normalized: "visitor@example.test" }]);
    expect(count("email_suppressions")).toBe(0);
    expect((await post(app, "/v1/lab/interest/withdraw", { token: withdraw }, null)).status).toBe(200);
    // A later signup of the withdrawn address is acknowledged but stores and sends nothing.
    await post(app, "/v1/lab/interest", { email: "visitor@example.test", cityId: cityId("fixture-city"), consent });
    expect(count("lab_interest_signups")).toBe(0); expect(sent).toHaveLength(1);
  });

  it("expires an unconfirmed token", async () => {
    await post(server(), "/v1/lab/interest", { email: "visitor@example.test", cityId: cityId("fixture-city"), consent });
    const token = tokenFrom((sent[0] as { confirmUrl: string }).confirmUrl, "confirm");
    expect(() => confirmLabInterest(db, token, "2026-11-24T10:00:00Z", consent)).toThrow("LAB_INTEREST_TOKEN_INVALID");
  });
});

describe("FLEX-8 notices stay inside their purpose", () => {
  const signup = async (email: string, city?: string) => {
    await post(server(), "/v1/lab/interest", { email, cityId: cityId(city ?? "fixture-city"), consent });
    const message = sent.at(-1) as Extract<LabInterestEmail, { kind: "CONFIRM" }>;
    confirmLabInterest(db, tokenFrom(message.confirmUrl, "confirm"), clock.toISOString(), consent);
  };
  const deps = { origin: LAB, secret: SECRET, commerceOrigin: "http://localhost:4000" };
  const notice = { noticeKey: "lab-sales-opened:2026-12", subject: "Продажи LAB открыты", message: "Билеты доступны на сайте." };

  it("cannot be prepared while LAB sales are closed", () => {
    expect(() => prepareLabSalesOpenedNotices(db, { ...notice, labSwitch: "CLOSED", cityId: cityId("fixture-city") }, deps, clock)).toThrow("LAB_INTEREST_SALES_NOT_OPEN");
  });

  it("skips a signup that expires after preparation, including a leap-day confirmation", async () => {
    clock = new Date("2028-02-29T10:00:00Z");
    await signup("leap@example.test");
    const input = { ...notice, labSwitch: "OPEN" as const, cityId: cityId("fixture-city") };
    clock = new Date("2029-02-28T09:59:59Z");
    const prepared = prepareLabSalesOpenedNotices(db, input, deps, clock);
    expect(prepared).toHaveLength(1);
    clock = new Date("2029-02-28T10:00:00Z");
    expect(prepareLabSalesOpenedNotices(db, input, deps, clock)).toEqual([]);
    expect(await dispatchLabSalesOpenedNotices(db, prepared, async () => { throw new Error("must not send"); }, () => clock))
      .toEqual({ sent: 0, skipped: 1, unknown: 0 });
    expect(count("lab_interest_notices")).toBe(0);
  });

  it("reaches only confirmed, non-suppressed signups of the city, once, with a withdrawal link", async () => {
    await signup("city@example.test", "fixture-city");
    await signup("other@example.test", "other-city");
    await signup("suppressed@example.test");
    await post(server(), "/v1/lab/interest", { email: "pending@example.test", cityId: cityId("fixture-city"), consent });
    db.prepare("INSERT INTO email_suppressions(email_normalized,reason) VALUES ('suppressed@example.test','ONE_CLICK')").run();
    const prepared = prepareLabSalesOpenedNotices(db, { ...notice, labSwitch: "OPEN", cityId: cityId("fixture-city") }, deps, clock);
    expect(prepared.map((message) => message.email).sort()).toEqual(["city@example.test"]);
    expect(prepared[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const delivered: LabInterestEmail[] = [];
    expect(await dispatchLabSalesOpenedNotices(db, prepared, async (message) => { delivered.push(message); }, () => clock))
      .toEqual({ sent: 1, skipped: 0, unknown: 0 });
    expect(delivered.every((message) => message.kind === "NOTICE" && !("signupId" in message))).toBe(true);
    expect(await dispatchLabSalesOpenedNotices(db, prepared, async () => { throw new Error("must not resend"); }, () => clock))
      .toEqual({ sent: 0, skipped: 1, unknown: 0 });
    expect(prepareLabSalesOpenedNotices(db, { ...notice, labSwitch: "OPEN", cityId: cityId("fixture-city") }, deps, clock)).toEqual([]);
    // The consent covers one notice: a different notice key does not reach the same signups again.
    expect(prepareLabSalesOpenedNotices(db, { ...notice, noticeKey: "lab-sales-opened:2027-01", labSwitch: "OPEN", cityId: cityId("other-city") }, deps, clock).map((m) => m.email))
      .toEqual(["other@example.test"]);
  });

  it("never retries an unknown provider outcome and skips a signup withdrawn after preparation", async () => {
    await signup("first@example.test"); await signup("second@example.test");
    const prepared = prepareLabSalesOpenedNotices(db, { ...notice, labSwitch: "OPEN", cityId: cityId("fixture-city") }, deps, clock);
    const second = prepared.find((message) => message.email === "second@example.test")!;
    db.prepare("DELETE FROM lab_interest_signups WHERE id=?").run(second.signupId);
    expect(await dispatchLabSalesOpenedNotices(db, prepared, async () => { throw new Error("timeout"); }, () => clock))
      .toEqual({ sent: 0, skipped: 1, unknown: 1 });
    expect(db.prepare("SELECT state FROM lab_interest_notices").all()).toEqual([{ state: "ATTEMPTED" }]);
    expect(prepareLabSalesOpenedNotices(db, { ...notice, labSwitch: "OPEN", cityId: cityId("fixture-city") }, deps, clock)).toEqual([]);
  });

  it("derives a withdrawal capability bound to one signup and the server secret", () => {
    const id = "0".repeat(32);
    expect(labInterestWithdrawToken(id, SECRET)).not.toBe(labInterestWithdrawToken(id, "other-secret"));
    expect(labInterestWithdrawToken(id, SECRET)).not.toBe(labInterestWithdrawToken("1".repeat(32), SECRET));
  });
});

describe("FLEX-8 retention (E proposal, owner decision D-I2 pending)", () => {
  const policy = { pendingMaxAgeSeconds: 7 * 24 * 3600, deliveredMaxAgeSeconds: 30 * 24 * 3600, confirmedMaxAgeSeconds: 365 * 24 * 3600 };
  const confirmLast = () => confirmLabInterest(db, tokenFrom((sent.at(-1) as { confirmUrl: string }).confirmUrl, "confirm"), clock.toISOString(), consent);

  it("has no default policy", () => {
    expect(() => purgeLabInterest(db, {} as never, clock)).toThrow("LAB_INTEREST_RETENTION_POLICY_INVALID");
    expect(() => purgeLabInterest(db, { ...policy, confirmedMaxAgeSeconds: 2 * 366 * 24 * 3600 }, clock)).toThrow("LAB_INTEREST_RETENTION_POLICY_INVALID");
  });

  it("deletes PENDING after its link expires, delivered after 30 days and any CONFIRMED after 12 months", async () => {
    await post(server(), "/v1/lab/interest", { email: "pending@example.test", cityId: cityId("fixture-city"), consent });
    await post(server(), "/v1/lab/interest", { email: "delivered@example.test", cityId: cityId("fixture-city"), consent }); confirmLast();
    await post(server(), "/v1/lab/interest", { email: "undelivered@example.test", cityId: cityId("fixture-city"), consent }); confirmLast();
    const deps = { origin: LAB, secret: SECRET, commerceOrigin: "http://localhost:4000" };
    const prepared = prepareLabSalesOpenedNotices(db, { noticeKey: "opened", labSwitch: "OPEN", cityId: cityId("fixture-city"), subject: "Продажи открыты", message: "Билеты на сайте." }, deps, clock);
    await dispatchLabSalesOpenedNotices(db, prepared, async (message) => {
      if (message.email === "undelivered@example.test") throw new Error("timeout");
    }, () => clock);
    expect(purgeLabInterest(db, policy, new Date("2026-11-23T10:00:00Z"))).toEqual({ pending: 0, delivered: 0, expired: 0 });
    expect(purgeLabInterest(db, policy, new Date("2026-11-24T10:00:01Z"))).toEqual({ pending: 1, delivered: 0, expired: 0 });
    expect(purgeLabInterest(db, policy, new Date("2026-12-22T10:00:01Z"))).toEqual({ pending: 0, delivered: 1, expired: 0 });
    expect(db.prepare("SELECT email_normalized FROM lab_interest_signups").all()).toEqual([{ email_normalized: "undelivered@example.test" }]);
    expect(purgeLabInterest(db, policy, new Date("2027-11-23T10:00:01Z"))).toEqual({ pending: 0, delivered: 0, expired: 1 });
    expect(count("lab_interest_signups") + count("lab_interest_notices")).toBe(0);
  });
});
