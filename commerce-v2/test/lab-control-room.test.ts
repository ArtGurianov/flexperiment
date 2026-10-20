import Database from "better-sqlite3";
import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabOccurrencesResponse } from "@flexperiment/control-room-contracts";
import { configureProduct } from "../src/catalog-control";
import { createCommerceV2App } from "../src/app";
import { checkout, confirmCheckout, MockPaymentRail, prepareCheckout } from "../src/checkout";
import { CONTROL_ROOM_ADMIN_ID } from "../src/control-room-totp";
import { migrateV2 } from "../src/db";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { enrolledTotp, testTotpKey } from "./fixtures/control-room-totp";
import { stageALegalManifestJson } from "./fixtures/legal";
import { openTestStorefront, qualifyTestFiscalPolicies, setTestStorefronts, testCheckoutConfig, withTestStorefrontSwitch } from "./fixtures/sales";

/** ART-341: LAB occurrence CRUD through the Control Room, against one live price. */
const NOW = "2026-09-30T12:00:00.000Z";
const REF = "lab:november";
const PATH = `/v1/admin/v2/lab/occurrences/${encodeURIComponent(REF)}`;
const ORIGIN = "https://admin.flexperiment.ru";
const password = "correct horse battery staple";
const salt = Buffer.alloc(16, 7);
const passwordScrypt = ["scrypt", "v1", "16384", "8", "1", salt.toString("base64url"),
  scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")].join(":");

let db: Database.Database;
let rail: MockPaymentRail;
let server: ReturnType<typeof createCommerceV2App>;
let cookie: string;

const occurrence = {
  occurrenceRef: REF, citySlug: "nsk", title: "LAB в ноябре", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T17:00:00Z",
  timezone: "Asia/Novosibirsk", capacity: 2, venue: { status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1", public: true },
  reason: "Новая встреча",
};

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) => server.request(path, {
  method, headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});
const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });
const list = async () => (await (await send("GET", "/v1/admin/v2/lab")).json() as LabOccurrencesResponse).occurrences;
const current = async () => (await list()).find((item) => item.occurrenceRef === REF)!;
const edit = async (patch: Record<string, unknown> | unknown[], expectedVersion?: number) =>
  json(await send("PATCH", PATH, { expectedVersion: expectedVersion ?? (await current()).version, patch, reason: "Правка" }));
const setOffer = async (terms: Record<string, unknown>, expectedProductVersion?: number) => json(await send("PUT", `${PATH}/offer`, {
  priceKopecks: 250_000, saleMode: "CLOSED", paymentPurpose: "Участие в мастер-классе LAB",
  expectedProductVersion: expectedProductVersion ?? (await current()).offer?.productVersion ?? 0, ...terms,
}));
const publicCatalogue = async () => (await server.request("/v1/lab/catalogue")).json() as Promise<{ occurrences: Array<Record<string, unknown>> }>;

let customers = 0;
const customer = () => {
  const id = `customer-${++customers}`;
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run(id, `${id}@example.com`);
  return { customerId: id, customerEmail: `${id}@example.com` };
};
const buySeat = () => checkout(db, rail, testCheckoutConfig, { ...customer(), offerRef: REF, idempotencyKey: `seat-${customers}` }, NOW);

/** An occurrence with a CLOSED, priced offer, listed and then opened to PUBLIC under a test LAB activation. */
const openForSale = async () => {
  expect((await json(await send("POST", "/v1/admin/v2/lab/occurrences", occurrence))).status).toBe(201);
  expect((await setOffer({})).status).toBe(200);
  qualifyTestFiscalPolicies(db);
  expect((await edit({ visibility: "LISTED" })).status).toBe(200);
  openTestStorefront(db, "LAB");
  expect((await setOffer({ saleMode: "PUBLIC" })).status).toBe(200);
};

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  rail = new MockPaymentRail();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('lab-legal','LAB','lab-stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  const totp = enrolledTotp(db, new Date(NOW));
  server = createCommerceV2App({
    db, sourceCommit: "a".repeat(40), serviceToken: "service-token", paymentRail: rail, now: () => new Date(NOW),
    config: withTestStorefrontSwitch(loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "mock", KINESCOPE_DELIVERY_MODE: "open", MERCHANT_PROMOTION_PREFIX: "FX-" })),
    controlRoomAuth: { origin: ORIGIN, sessionSecret: "test-control-room-secret", passwordScrypt, trustedProxyIps: ["127.0.0.1"], totpKey: testTotpKey },
    controlRoomPeerAddress: () => "127.0.0.1",
  });
  const login = await server.request("/v1/admin/login", { method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-real-ip": "203.0.113.10" },
    body: JSON.stringify({ password, code: totp.next() }) });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!;
  expect((await send("POST", "/v1/admin/v2/cities", { slug: "nsk", title: "Новосибирск" })).status).toBe(201);
});

afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("Control Room LAB authorization", () => {
  const writes: Array<[string, string, unknown]> = [
    ["POST", "/v1/admin/v2/cities", { slug: "msk", title: "Москва" }],
    ["PATCH", "/v1/admin/v2/cities/nsk", { title: "Новосиб" }],
    ["POST", "/v1/admin/v2/lab/occurrences", occurrence],
    ["PATCH", PATH, { expectedVersion: 1, patch: { title: "Чужой" }, reason: "x" }],
    ["POST", `${PATH}/cancel`, { expectedVersion: 1, reason: "x" }],
    ["PUT", `${PATH}/offer`, { priceKopecks: 1, saleMode: "CLOSED", expectedProductVersion: 0 }],
  ];

  it.each(writes)("refuses %s %s without a session, with a forged one and from a foreign origin", async (method, path, body) => {
    const before = db.prepare("SELECT (SELECT COUNT(*) FROM audit_log) + (SELECT COUNT(*) FROM lab_occurrences) AS writes").get();
    expect(await json(await send(method, path, body, {}))).toEqual({ status: 401, body: { error: { code: "ADMIN_AUTH_REQUIRED" } } });
    expect((await send(method, path, body, { cookie: "flexperiment_control_room=forged.token" })).status).toBe(401);
    expect(await json(await send(method, path, body, { cookie, origin: "https://evil.example" })))
      .toEqual({ status: 403, body: { error: { code: "ORIGIN_FORBIDDEN" } } });
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM audit_log) + (SELECT COUNT(*) FROM lab_occurrences) AS writes").get()).toEqual(before);
  });

  it("refuses a revoked session and never takes the actor from the body", async () => {
    const created = await json(await send("POST", "/v1/admin/v2/lab/occurrences", { ...occurrence, actor: "intruder" }));
    expect(created).toEqual({ status: 201, body: { occurrenceRef: REF, version: 1 } });
    expect(db.prepare("SELECT DISTINCT actor FROM lab_occurrence_revisions").all()).toEqual([{ actor: CONTROL_ROOM_ADMIN_ID }]);
    expect(db.prepare("SELECT admin_id FROM control_room_audit_log WHERE action='LAB_OCCURRENCE_CREATED'").all())
      .toEqual([{ admin_id: CONTROL_ROOM_ADMIN_ID }]);
    expect((await send("POST", "/v1/admin/logout", {})).status).toBe(200);
    expect((await edit({ title: "После выхода" }, 1)).status).toBe(401);
    expect(db.prepare("SELECT title FROM lab_occurrences").get()).toEqual({ title: occurrence.title });
  });
});

describe("Control Room LAB occurrence CRUD", () => {
  it("creates, edits, publishes and closes new promises with optimistic versions", async () => {
    expect((await json(await send("POST", "/v1/admin/v2/lab/occurrences", occurrence))).status).toBe(201);
    expect(await current()).toMatchObject({ phase: "SCHEDULED", visibility: "UNLISTED", version: 1, citySlug: "nsk", offer: null });
    expect(await json(await send("PATCH", "/v1/admin/v2/cities/nsk", { title: "Новосибирск (центр)" })))
      .toEqual({ status: 200, body: expect.objectContaining({ slug: "nsk", title: "Новосибирск (центр)" }) });

    expect(await edit({ title: "LAB в ноябре: тело", capacity: 12, adminReservedSeats: 2 }))
      .toEqual({ status: 200, body: { occurrenceRef: REF, version: 2, changed: true } });
    expect(await setOffer({})).toEqual({ status: 200, body: { productRef: REF, offerRef: REF, version: 1 } });
    expect(await edit({ visibility: "LISTED" })).toMatchObject({ status: 200, body: { version: 3 } });
    // LAB sales stay CLOSED: no PUBLIC offer while the owner's LAB switch is closed (ART-319).
    setTestStorefronts(db, { LAB: "CLOSED" });
    expect(await setOffer({ saleMode: "PUBLIC" })).toEqual({ status: 409, body: { error: { code: "SALES_STOPPED" } } });
    expect((await current()).offer).toMatchObject({ saleMode: "CLOSED", priceKopecks: 250_000, productVersion: 1 });
    expect((await publicCatalogue()).occurrences).toEqual([]);

    qualifyTestFiscalPolicies(db);
    openTestStorefront(db, "LAB");
    expect((await setOffer({ saleMode: "PUBLIC" })).status).toBe(200);
    expect((await publicCatalogue()).occurrences).toEqual([expect.objectContaining({ occurrenceRef: REF, amountKopecks: 250_000 })]);
    expect((await setOffer({ saleMode: "CLOSED" })).status).toBe(200);
    expect((await publicCatalogue()).occurrences).toEqual([]);
  });

  it("refuses a stale occurrence version and a conflicting price written against the same product version", async () => {
    await send("POST", "/v1/admin/v2/lab/occurrences", occurrence);
    expect((await edit({ title: "Первый оператор" }, 1)).status).toBe(200);
    expect(await edit({ title: "Второй оператор" }, 1))
      .toEqual({ status: 409, body: { error: { code: "LAB_OCCURRENCE_VERSION_CONFLICT" } } });
    expect((await current()).title).toBe("Первый оператор");

    expect((await setOffer({ priceKopecks: 250_000 }, 0)).status).toBe(200);
    expect((await setOffer({ priceKopecks: 300_000 }, 1)).status).toBe(200);
    expect(await setOffer({ priceKopecks: 199_000 }, 1)).toEqual({ status: 409, body: { error: { code: "CATALOG_VERSION_CONFLICT" } } });
    expect((await current()).offer).toMatchObject({ priceKopecks: 300_000, productVersion: 2 });
  });

  it("keeps product and occurrence identity out of reach", async () => {
    await send("POST", "/v1/admin/v2/lab/occurrences", occurrence);
    expect(await json(await send("POST", "/v1/admin/v2/lab/occurrences", { ...occurrence, title: "Двойник" })))
      .toEqual({ status: 409, body: { error: { code: "LAB_OCCURRENCE_REF_TAKEN" } } });
    for (const patch of [{ occurrenceRef: "lab:other" }, { citySlug: "msk" }, { lifecycle: "SCHEDULED" }]) {
      expect(await edit(patch)).toEqual({ status: 422, body: { error: { code: "LAB_COMMAND_INVALID" } } });
    }
    // A caller-supplied identity on the LAB offer command is ignored: the occurrence names its product.
    expect((await setOffer({ productRef: "lab:hijack", offerRef: "lab:hijack", kind: "ONLINE_COURSE" })).body)
      .toEqual({ productRef: REF, offerRef: REF, version: 1 });
    const generic = (body: Record<string, unknown>) => send("POST", "/v1/admin/v2/catalogue/products", {
      kind: "LAB", accessModel: "PAID", occurrenceRef: REF, priceKopecks: 1, saleMode: "CLOSED", ...body });
    expect(await json(await generic({ productRef: "lab:second", offerRef: "lab:second", expectedVersion: 0 })))
      .toEqual({ status: 409, body: { error: { code: "LAB_OCCURRENCE_OFFER_EXISTS" } } });
    expect(await json(await generic({ productRef: REF, offerRef: "lab:renamed", expectedVersion: 1 })))
      .toEqual({ status: 409, body: { error: { code: "PRODUCT_IDENTITY_IMMUTABLE" } } });
    expect(db.prepare("SELECT COUNT(*) AS products FROM products").get()).toEqual({ products: 1 });
    expect(await json(await send("PATCH", PATH, "{not json")))
      .toEqual({ status: 422, body: { error: { code: "LAB_COMMAND_INVALID" } } });
    expect(await json(await send("PATCH", `/v1/admin/v2/lab/occurrences/${encodeURIComponent("lab:missing")}`,
      { expectedVersion: 1, patch: { title: "x" }, reason: "x" })))
      .toEqual({ status: 404, body: { error: { code: "LAB_OCCURRENCE_NOT_FOUND" } } });
  });

  it("locks what a sold seat was promised and keeps capacity above it", async () => {
    await openForSale();
    expect(await buySeat()).toMatchObject({ state: "PAID" });
    expect(await buySeat()).toMatchObject({ state: "PAID" });
    expect(await current()).toMatchObject({ soldSeats: 2, customerCommittedSeats: 2, availableSeats: 0 });
    await expect(buySeat()).rejects.toThrow("LAB_OCCURRENCE_SOLD_OUT");

    expect((await edit({ startsAt: "2026-11-02T09:00:00Z", endsAt: "2026-11-02T17:00:00Z" })).body)
      .toEqual({ error: { code: "LAB_OCCURRENCE_SCHEDULE_LOCKED" } });
    expect((await edit({ venue: { status: "CONFIRMED", name: "Другой зал", address: "Ленина, 2", public: true } })).body)
      .toEqual({ error: { code: "LAB_VENUE_CHANGE_REQUIRES_WORKFLOW" } });
    expect(await edit({ capacity: 1 })).toEqual({ status: 409, body: { error: { code: "LAB_CAPACITY_BELOW_COMMITTED_SEATS" } } });
    expect(await edit({ capacity: 3, adminReservedSeats: 2 }))
      .toEqual({ status: 409, body: { error: { code: "LAB_RESERVE_EXCEEDS_AVAILABLE_CAPACITY" } } });
    expect((await json(await send("POST", `${PATH}/cancel`, { expectedVersion: (await current()).version, reason: "Отмена" }))).body)
      .toEqual({ error: { code: "LAB_OCCURRENCE_HAS_COMMITTED_SEATS" } });

    // Allowed on a sold occurrence: more capacity, and the price of new quotes only.
    expect((await edit({ capacity: 3 })).status).toBe(200);
    expect((await setOffer({ saleMode: "PUBLIC", priceKopecks: 300_000 })).status).toBe(200);
    expect(db.prepare("SELECT unit_amount_kopecks FROM order_lines").all())
      .toEqual([{ unit_amount_kopecks: 250_000 }, { unit_amount_kopecks: 250_000 }]);
    expect(await current()).toMatchObject({ capacity: 3, availableSeats: 1, offer: expect.objectContaining({ priceKopecks: 300_000 }) });
    expect((await publicCatalogue()).occurrences).toEqual([expect.objectContaining({ amountKopecks: 300_000, soldOut: false })]);
  });

  it("cancels an unsold occurrence, closes its offer and refuses every later promise", async () => {
    await openForSale();
    const buyer = customer();
    const quote = await prepareCheckout(db, rail, testCheckoutConfig, { ...buyer, offerRef: REF, previewIdempotencyKey: "cancel-preview" }, NOW);
    expect(quote).toMatchObject({ state: "PRICE_REVIEW_REQUIRED" });

    const cancelled = await json(await send("POST", `${PATH}/cancel`, { expectedVersion: (await current()).version, reason: "Тренер заболел" }));
    expect(cancelled).toMatchObject({ status: 200, body: { occurrenceRef: REF, cancelledAt: NOW } });
    expect(await current()).toMatchObject({ phase: "CANCELLED", cancellationReason: "Тренер заболел", offer: expect.objectContaining({ saleMode: "CLOSED" }) });
    expect((await publicCatalogue()).occurrences).toEqual([]);
    await expect(confirmCheckout(db, rail, testCheckoutConfig, { ...buyer, quoteId: (quote as { quoteId: string }).quoteId,
      idempotencyKey: "cancel-confirm" }, NOW)).rejects.toThrow("LAB_OCCURRENCE_CANCELLED");

    expect((await edit({ title: "Воскрешение" })).body).toEqual({ error: { code: "LAB_OCCURRENCE_CANCELLED" } });
    const frozen = await current();
    const audits = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get();
    for (const terms of [{ saleMode: "PUBLIC" }, { saleMode: "CLOSED", priceKopecks: 300_000, paymentPurpose: "Иные условия" }]) {
      expect(await setOffer(terms)).toEqual({ status: 409, body: { error: { code: "LAB_OCCURRENCE_CANCELLED" } } });
    }
    expect(() => configureProduct(db, testCheckoutConfig, { productRef: REF, offerRef: REF, kind: "LAB", accessModel: "PAID",
      occurrenceRef: REF, priceKopecks: 300_000, saleMode: "CLOSED", actor: "direct-writer", expectedVersion: frozen.offer!.productVersion }, NOW))
      .toThrow("LAB_OCCURRENCE_CANCELLED");
    expect(await current()).toEqual(frozen);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual(audits);
    expect((await json(await send("POST", `${PATH}/cancel`, { expectedVersion: (await current()).version, reason: "Ещё раз" }))).body)
      .toEqual({ error: { code: "LAB_OCCURRENCE_CANCELLED" } });
  });
});

describe("one live LAB price (offers.price_kopecks)", () => {
  it("shows a Control Room price change on the public catalogue and in new quotes; an issued quote keeps its price", async () => {
    await openForSale();
    const buyer = customer();
    const first = await prepareCheckout(db, rail, testCheckoutConfig, { ...buyer, offerRef: REF, previewIdempotencyKey: "price-1",
      displayedAmountKopecks: 250_000 }, NOW) as Record<string, unknown>;
    expect(first).toMatchObject({ baseAmountKopecks: 250_000, finalAmountKopecks: 250_000, priceNotice: null });

    expect((await setOffer({ saleMode: "PUBLIC", priceKopecks: 300_000 })).status).toBe(200);
    expect((await publicCatalogue()).occurrences).toEqual([expect.objectContaining({ offerRef: REF, amountKopecks: 300_000 })]);

    // The buyer reopens the issued quote: same price, told that the catalogue moved.
    const reread = await prepareCheckout(db, rail, testCheckoutConfig, { ...buyer, offerRef: REF, previewIdempotencyKey: "price-1",
      displayedAmountKopecks: 250_000 }, NOW) as Record<string, unknown>;
    expect(reread).toMatchObject({ quoteId: first.quoteId, baseAmountKopecks: 250_000,
      priceNotice: { code: "CATALOG_PRICE_CHANGED_AFTER_QUOTE", quotedAmountKopecks: 250_000, currentAmountKopecks: 300_000 } });
    expect(await confirmCheckout(db, rail, testCheckoutConfig, { ...buyer, quoteId: String(first.quoteId), idempotencyKey: "price-1-pay" }, NOW))
      .toMatchObject({ state: "PAID" });
    expect(db.prepare("SELECT unit_amount_kopecks FROM order_lines").get()).toEqual({ unit_amount_kopecks: 250_000 });

    // A buyer whose page still showed the old price gets the live price and a warning.
    const late = await prepareCheckout(db, rail, testCheckoutConfig, { ...customer(), offerRef: REF, previewIdempotencyKey: "price-2",
      displayedAmountKopecks: 250_000 }, NOW) as Record<string, unknown>;
    expect(late).toMatchObject({ baseAmountKopecks: 300_000,
      priceNotice: { code: "PRICE_CHANGED_SINCE_DISPLAY", quotedAmountKopecks: 300_000, displayedAmountKopecks: 250_000 } });
    await expect(prepareCheckout(db, rail, testCheckoutConfig, { ...customer(), offerRef: REF, previewIdempotencyKey: "price-3",
      displayedAmountKopecks: -1 }, NOW)).rejects.toThrow("DISPLAYED_AMOUNT_INVALID");
  });
});

describe("LAB command error classification", () => {
  it.each([
    { paymentPurpose: "" }, { paymentPurpose: 42 }, { acceptanceAllowlist: "buyer@example.com" },
    { acceptanceAllowlist: [42] }, { acceptanceAllowlist: null }, { saleMode: "INVALID" },
  ])("answers malformed commercial terms with 422 and no writes: %j", async (terms) => {
    await send("POST", "/v1/admin/v2/lab/occurrences", occurrence);
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get();
    const result = await setOffer(terms);
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: { code: "paymentPurpose" in terms ? "PAYMENT_PURPOSE_REQUIRED"
      : "saleMode" in terms ? "SALE_MODE_INVALID" : "ACCEPTANCE_ALLOWLIST_INVALID" } });
    expect((await current()).offer).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual(before);
  });

  it("answers a missing required purpose with 422 after sales admission succeeds", async () => {
    await openForSale();
    expect(await setOffer({ saleMode: "PUBLIC", paymentPurpose: null }))
      .toEqual({ status: 422, body: { error: { code: "PAYMENT_PURPOSE_REQUIRED" } } });
  });

  it("rejects malformed occurrence and cancellation commands as input errors", async () => {
    expect((await send("POST", "/v1/admin/v2/lab/occurrences", { ...occurrence, citySlug: {} })).status).toBe(422);
    await send("POST", "/v1/admin/v2/lab/occurrences", occurrence);
    expect(await json(await send("POST", `${PATH}/cancel`, { reason: "missing version" })))
      .toEqual({ status: 422, body: { error: { code: "LAB_COMMAND_INVALID" } } });
    expect(await edit([])).toEqual({ status: 422, body: { error: { code: "LAB_COMMAND_INVALID" } } });
  });

  it.each(["SQLITE_BUSY", "private SQL details: buyer@example.com capability=secret"])("sanitizes unknown DB failures as 500 and logs no sensitive details: %s", async (failure) => {
    await send("POST", "/v1/admin/v2/lab/occurrences", occurrence);
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get();
    db.exec(`CREATE TRIGGER fail_offer BEFORE INSERT ON offers BEGIN SELECT RAISE(ABORT, '${failure}'); END`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await setOffer({})).toEqual({ status: 500, body: { error: { code: "LAB_OFFER_COMMAND_FAILED" } } });
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "LAB_COMMAND_FAILURE", code: "LAB_OFFER_COMMAND_FAILED", errorKind: "ERROR" }));
    expect((await current()).offer).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual(before);
  });
});
