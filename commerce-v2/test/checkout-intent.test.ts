import { retireFiscalPolicy } from "../src/fiscal-policy";
import { RefrefPaymentRail } from "../src/refref-payment-rail";
import { cancelLabOccurrence, editLabOccurrence, labSeatInventory, type LabOccurrenceRow } from "../src/lab-occurrences";
import Database from "better-sqlite3";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import {
  AmbiguousRailCreateError, CheckoutConflictError, confirmCheckout, MockPaymentRail, prepareCheckout, RailRefusalError,
  reconcileCheckout, reconcilePendingCheckouts, type PaymentResolveInput,
} from "../src/checkout";
import { applyV2Migration, migrateV2 } from "../src/db";
import { saveMerchantPromotion } from "../src/promotions";
import { stageALegalManifestJson } from "./fixtures/legal";
import { activatePublicSales, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";

// ART-373: the durable purchase intent and payment-safe replay (design 2026-10-18 §2).

let db: Database.Database;
let rail: MockPaymentRail;

const T0 = "2026-09-30T10:00:00.000Z";
const at = (minutes: number) => new Date(new Date(T0).getTime() + minutes * 60_000).toISOString();
const customer = { customerId: "customer", customerEmail: "student@example.com" };
const preview = (key: string, extra: Partial<Parameters<typeof prepareCheckout>[3]> = {}, now = T0) =>
  prepareCheckout(db, rail, testCheckoutConfig, { ...customer, offerRef: "course:one", previewIdempotencyKey: key, ...extra }, now);
const confirm = (quoteId: string, key: string, now = at(1), who = customer) =>
  confirmCheckout(db, rail, testCheckoutConfig, { ...who, quoteId, idempotencyKey: key }, now);
const quoted = async (result: Awaited<ReturnType<typeof prepareCheckout>>) => {
  if (result.state !== "PRICE_REVIEW_REQUIRED") throw new Error(`expected a quote, got ${result.state}`);
  return result;
};
const intent = () => db.prepare(`SELECT state,order_public_id,line_ref,resolution_request_json,resolution_sends,consumed_at,expires_at
  FROM checkout_quotes`).get() as { state: string; order_public_id: string; line_ref: string; resolution_request_json: string;
    resolution_sends: number; consumed_at: string | null; expires_at: string | null };
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const addLab = (startsAt = "2026-11-01T09:00:00Z") => {
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('lab-legal','LAB','lab-stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
  db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
    VALUES ('occurrence','lab:november','city','LAB в ноябре',?,'2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Студия','Красный проспект, 1')`).run(startsAt);
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('lab-product','lab:november','LAB','PAID','lab:november')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('lab-offer','lab:november','lab-product',250000,'PUBLIC')").run();
  qualifyTestFiscalPolicies(db);
  activatePublicSales(db, "LAB");
};

function setupDatabase(beforeVersion?: string) {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  if (beforeVersion) {
    const directory = join(process.cwd(), "commerce-v2/migrations");
    for (const version of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < beforeVersion).sort()) {
      applyV2Migration(db, version, readFileSync(join(directory, version), "utf8"));
    }
  } else migrateV2(db);
  rail = new MockPaymentRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','course:one','product',10000,'PUBLIC')").run();
  qualifyTestFiscalPolicies(db);
  activatePublicSales(db);
}
beforeEach(() => setupDatabase());

describe("durable intent before the first Refref call", () => {
  it("persists the order and line ids and the exact request, with no buyer identity, before resolving", async () => {
    let seen: ReturnType<typeof intent> | undefined;
    const original = rail.resolve.bind(rail);
    const resolve = vi.spyOn(rail, "resolve").mockImplementation(async (request) => { seen = intent(); return original(request); });
    await quoted(await preview("intent"));
    expect(seen).toMatchObject({ state: "RESOLVING", resolution_sends: 1, consumed_at: null, expires_at: null });
    const frozen = JSON.parse(seen!.resolution_request_json) as PaymentResolveInput;
    expect(frozen.request).toEqual({
      merchantOrderRef: seen!.order_public_id,
      currency: "RUB",
      lines: [{ lineRef: seen!.line_ref, offerRef: "course:one", quantity: 1, merchantOfferAmountKopecks: 10_000 }],
      deliveryDegraded: { degraded: false },
    });
    expect(resolve.mock.calls[0][0]).toEqual(frozen);
    expect(seen!.resolution_request_json).not.toContain("student@example.com");
    expect(seen!.resolution_request_json).not.toContain("customer");
  });

  it("freezes the vNext resolution payload with its context and the reason delivery was degraded", async () => {
    const browserContextId = `ctx_${"0123456789abcdef".repeat(2)}`;
    await quoted(await preview("vnext", { checkoutCode: "PARTNER20", storefrontOrigin: "https://flexperiment.ru", browserContextId,
      deliveryDegraded: { degraded: true, reason: "TIMEOUT" } }));
    const { request } = JSON.parse(intent().resolution_request_json) as PaymentResolveInput;
    expect(request).toEqual({
      merchantOrderRef: intent().order_public_id, storefrontOrigin: "https://flexperiment.ru", browserContextId, currency: "RUB",
      lines: [{ lineRef: intent().line_ref, offerRef: "course:one", quantity: 1, merchantOfferAmountKopecks: 10_000 }],
      checkoutCode: "PARTNER20", deliveryDegraded: { degraded: true, reason: "TIMEOUT" },
    });
  });

  it.each([
    [{ deliveryDegraded: { degraded: true } }, "DELIVERY_DEGRADED_INVALID"],
    [{ deliveryDegraded: { degraded: false, reason: "FAILED" } }, "DELIVERY_DEGRADED_INVALID"],
    [{ deliveryDegraded: { degraded: true, reason: "LOST" } }, "DELIVERY_DEGRADED_INVALID"],
    [{ browserContextId: "ctx_short" }, "BROWSER_CONTEXT_ID_INVALID"],
  ])("refuses an invalid resolution context before anything is written (%o)", async (extra, code) => {
    const resolve = vi.spyOn(rail, "resolve");
    await expect(preview("invalid", extra as Partial<Parameters<typeof prepareCheckout>[3]>)).rejects.toThrow(code);
    expect(resolve).not.toHaveBeenCalled();
    expect(count("checkout_quotes")).toBe(0);
  });
});

describe("lost answers and replay", () => {
  it("recovers a resolution Refref committed but whose answer was lost, by sending the identical request", async () => {
    const resolve = vi.spyOn(rail, "resolve");
    expect(await preview("lost-after", { scenario: "ambiguous_resolve" })).toMatchObject({ state: "RESOLUTION_PENDING" });
    const first = intent();
    expect(first).toMatchObject({ state: "RESOLVING", resolution_sends: 1 });
    const replayed = await quoted(await preview("lost-after", { scenario: "ambiguous_resolve" }, at(1)));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1][0]).toEqual(resolve.mock.calls[0][0]);
    expect(intent()).toMatchObject({ state: "REVIEW", order_public_id: first.order_public_id, line_ref: first.line_ref, resolution_sends: 2 });
    // The quote's 15 minutes run from the intent, not from the replay.
    expect(replayed.expiresAt).toBe(at(15));
  });

  it("recovers a resolution lost before Refref committed it the same way", async () => {
    const original = rail.resolve.bind(rail);
    const resolve = vi.spyOn(rail, "resolve")
      .mockRejectedValueOnce(new AmbiguousRailCreateError())
      .mockImplementation(async (request) => original(request));
    expect(await preview("lost-before")).toMatchObject({ state: "RESOLUTION_PENDING" });
    await quoted(await preview("lost-before"));
    expect(resolve.mock.calls[1][0]).toEqual(resolve.mock.calls[0][0]);
    expect(count("checkout_quotes")).toBe(1);
  });

  it("refuses a different request under the same preview key or the same order", async () => {
    await quoted(await preview("same-key"));
    await expect(preview("same-key", { checkoutCode: "OTHER" })).rejects.toBeInstanceOf(CheckoutConflictError);
    await expect(preview("same-key", { checkoutCode: "OTHER" })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(preview("other-key", { orderPublicId: intent().order_public_id, checkoutCode: "OTHER" })).rejects.toThrow("CHECKOUT_HANDOFF_REUSED");
    // The same request on the same order (the buyer back from the handoff) is the same intent.
    await expect(preview("other-key", { orderPublicId: intent().order_public_id })).resolves.toMatchObject({ state: "PRICE_REVIEW_REQUIRED" });
    expect(count("checkout_quotes")).toBe(1);
  });

  it("ends an intent Refref refused for good, and answers every repeat with that refusal without calling again", async () => {
    const resolve = vi.spyOn(rail, "resolve").mockRejectedValue(new RailRefusalError("REFREF_RESOLUTION_REQUEST_MISMATCH"));
    await expect(preview("refused")).rejects.toThrow("REFREF_RESOLUTION_REQUEST_MISMATCH");
    await expect(preview("refused")).rejects.toThrow("REFREF_RESOLUTION_REQUEST_MISMATCH");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(intent()).toMatchObject({ state: "REFUSED", consumed_at: null });
  });

  it("never starts a payment on load or retry, and a replay after confirmation only reads the order back", async () => {
    const create = vi.spyOn(rail, "create");
    const quote = await quoted(await preview("load"));
    await preview("load", {}, at(0.5));
    await preview("load", {}, at(0.7));
    expect(create).not.toHaveBeenCalled();
    const paid = await confirm(quote.quoteId, "pay");
    expect(await preview("load", {}, at(2))).toEqual({ orderPublicId: paid.orderPublicId, state: "PAID", checkoutUrl: undefined });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps the intent's lineRef through the order, the snapshot and the attempt", async () => {
    const quote = await quoted(await preview("line"));
    const { line_ref, order_public_id } = intent();
    await confirm(quote.quoteId, "pay");
    expect(db.prepare("SELECT id FROM order_lines").get()).toEqual({ id: line_ref });
    expect(db.prepare("SELECT public_id FROM orders").get()).toEqual({ public_id: order_public_id });
    const snapshot = JSON.parse((db.prepare("SELECT checkout_snapshot_json FROM orders").get() as { checkout_snapshot_json: string }).checkout_snapshot_json);
    expect(snapshot.lines[0].lineRef).toBe(line_ref);
    const attempt = JSON.parse((db.prepare("SELECT request_payload_json FROM checkout_attempts").get() as { request_payload_json: string }).request_payload_json);
    expect(attempt).toMatchObject({ lineRef: line_ref, orderPublicId: order_public_id });
  });

  it("recovers a create that never answered (the process stopped after the order was committed) by order read-back", async () => {
    const quote = await quoted(await preview("crash"));
    const original = rail.create.bind(rail);
    const create = vi.spyOn(rail, "create").mockRejectedValueOnce(new Error("process stopped")).mockImplementation(async (input) => original(input));
    await expect(confirm(quote.quoteId, "pay")).rejects.toThrow("process stopped");
    expect(intent()).toMatchObject({ state: "PAYMENT_CREATING" });
    const order = intent().order_public_id;
    // Still possibly in flight: nothing is sent.
    expect(await reconcileCheckout(db, rail, order, at(1.5))).toMatchObject({ state: "CREATE_UNKNOWN" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await reconcilePendingCheckouts(db, rail, at(3))).toEqual({ selected: 1, reconciled: 1, failed: 0 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
    expect(intent()).toMatchObject({ state: "PAID" });
    expect(count("course_entitlements")).toBe(1);
  });

  it("records an unanswered create as UNCERTAIN and settles it once on read-back", async () => {
    const quote = await quoted(await preview("ambiguous", { scenario: "ambiguous_create" }));
    expect(await confirm(quote.quoteId, "pay")).toMatchObject({ state: "CREATE_UNKNOWN" });
    expect(intent()).toMatchObject({ state: "UNCERTAIN" });
    expect(await reconcileCheckout(db, rail, intent().order_public_id, at(2))).toMatchObject({ state: "PAID" });
    expect(intent()).toMatchObject({ state: "PAID" });
  });
});

describe("two tabs", () => {
  it("one quote confirmed in two tabs makes one order and one payment", async () => {
    const quote = await quoted(await preview("tab"));
    const create = vi.spyOn(rail, "create");
    const first = await confirm(quote.quoteId, "tab-one");
    const second = await confirm(quote.quoteId, "tab-two", at(1.2));
    expect(second.orderPublicId).toBe(first.orderPublicId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(count("orders")).toBe(1);
  });

  it("a second quote waits for the first tab's open payment, read back by order first", async () => {
    const one = await quoted(await preview("tab-one", { scenario: "customer_action" }));
    const two = await quoted(await preview("tab-two"));
    const started = await confirm(one.quoteId, "pay-one");
    expect(started).toMatchObject({ state: "CUSTOMER_ACTION_REQUIRED" });
    const reconcile = vi.spyOn(rail, "reconcile");
    const create = vi.spyOn(rail, "create");
    const refused = await confirm(two.quoteId, "pay-two").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CheckoutConflictError);
    expect(refused).toMatchObject({ message: "CHECKOUT_PAYMENT_IN_PROGRESS", orderPublicId: started.orderPublicId });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    // A new intent for the same offer is refused the same way while that payment is open.
    await expect(preview("tab-three", {}, at(2))).rejects.toThrow("CHECKOUT_PAYMENT_IN_PROGRESS");
    expect(count("orders")).toBe(1);
  });

  it("LAB: replacing an intent makes the old tab unpayable; a fresh intent after payment buys a second ticket", async () => {
    addLab();
    const lab = (key: string, now = T0) => prepareCheckout(db, rail, testCheckoutConfig,
      { ...customer, offerRef: "lab:november", previewIdempotencyKey: key }, now);
    const one = await quoted(await lab("lab-one"));
    const two = await quoted(await lab("lab-two"));
    await expect(confirm(one.quoteId, "lab-pay-one")).rejects.toThrow("CHECKOUT_INTENT_REPLACED");
    expect(await confirm(two.quoteId, "lab-pay-two")).toMatchObject({ state: "PAID" });
    const three = await quoted(await lab("lab-three", at(2)));
    expect(await confirm(three.quoteId, "lab-pay-three", at(3))).toMatchObject({ state: "PAID" });
    expect(count("orders")).toBe(2);
  });
});

describe("issued quote guarantee", () => {
  it("keeps its price and frozen line across a price change and an ordinary offer close", async () => {
    const quote = await quoted(await preview("guarantee"));
    db.prepare("UPDATE offers SET price_kopecks=20000, sale_mode='CLOSED'").run();
    await expect(preview("new-after-close", {}, at(0.5))).rejects.toThrow("OFFER_CLOSED");
    expect(await confirm(quote.quoteId, "pay")).toMatchObject({ state: "PAID" });
    expect(db.prepare("SELECT total_kopecks FROM orders").get()).toEqual({ total_kopecks: 10_000 });
  });

  it("LAB: a title edit after the quote is not a reason to refuse it; the order keeps the frozen occurrence", async () => {
    addLab();
    const quote = await quoted(await prepareCheckout(db, rail, testCheckoutConfig,
      { ...customer, offerRef: "lab:november", previewIdempotencyKey: "lab" }, T0));
    db.prepare("UPDATE lab_occurrences SET title='LAB в ноябре (обновлено)'").run();
    expect(await confirm(quote.quoteId, "pay")).toMatchObject({ state: "PAID" });
    expect(JSON.parse((db.prepare("SELECT occurrence_snapshot_json FROM order_lines").get() as { occurrence_snapshot_json: string })
      .occurrence_snapshot_json)).toMatchObject({ title: "LAB в ноябре" });
  });

  it.each([
    ["schedule", "UPDATE lab_occurrences SET starts_at='2026-11-02T09:00:00Z',ends_at='2026-11-02T17:00:00Z'"],
    ["timezone", "UPDATE lab_occurrences SET timezone='Europe/Moscow'"],
    ["venue address", "UPDATE lab_occurrences SET venue_address='Новый адрес'"],
    ["venue status", "UPDATE lab_occurrences SET venue_status='TO_BE_ANNOUNCED',venue_name=NULL,venue_address=NULL,venue_disclosure_text='Скоро',venue_announce_by='2026-10-20T00:00:00Z'"],
  ])("LAB: a pre-confirm %s edit requires a fresh preview", async (_change, sql) => {
    addLab();
    const input = { ...customer, offerRef: "lab:november", previewIdempotencyKey: "lab-before" };
    const quote = await quoted(await prepareCheckout(db, rail, testCheckoutConfig, input, T0));
    db.exec(sql);
    const create = vi.spyOn(rail, "create");
    await expect(confirm(quote.quoteId, "pay")).rejects.toThrow("CHECKOUT_QUOTE_STALE");
    expect(count("orders")).toBe(0);
    expect(create).not.toHaveBeenCalled();
    const fresh = await quoted(await prepareCheckout(db, rail, testCheckoutConfig,
      { ...input, previewIdempotencyKey: "lab-after" }, at(1)));
    expect(fresh.quoteId).not.toBe(quote.quoteId);
  });

  it.each([
    ["schedule", "starts_at='2026-11-02T09:00:00Z',ends_at='2026-11-02T17:00:00Z'", "starts_at='2026-11-01T09:00:00Z',ends_at='2026-11-01T17:00:00Z'"],
    ["timezone", "timezone='Europe/Moscow'", "timezone='Asia/Novosibirsk'"],
    ["venue", "venue_address='Новый адрес'", "venue_address='Красный проспект, 1'"],
  ])("LAB: a %s edit permanently ends a quote even when reverted before any confirm", async (_field, change, undo) => {
    addLab();
    const input = { ...customer, offerRef: "lab:november", previewIdempotencyKey: "original" };
    const quote = await quoted(await prepareCheckout(db, rail, testCheckoutConfig, input, T0));
    db.exec(`UPDATE lab_occurrences SET ${change}`);
    expect(intent()).toMatchObject({ state: "EXPIRED", consumed_at: null });
    db.exec(`UPDATE lab_occurrences SET ${undo}`);
    const create = vi.spyOn(rail, "create");
    await expect(confirm(quote.quoteId, "old")).rejects.toThrow("CHECKOUT_QUOTE_STALE");
    await expect(prepareCheckout(db, rail, testCheckoutConfig, input, at(1))).rejects.toThrow("CHECKOUT_QUOTE_STALE");
    expect(create).not.toHaveBeenCalled();
    expect(count("orders")).toBe(0);
    const fresh = await quoted(await prepareCheckout(db, rail, testCheckoutConfig,
      { ...input, previewIdempotencyKey: "fresh" }, at(1)));
    expect(fresh.quoteId).not.toBe(quote.quoteId);
    expect(db.prepare("SELECT state FROM checkout_quotes WHERE id=?").get(quote.quoteId)).toEqual({ state: "EXPIRED" });
  });

  it("LAB: editing while Refref resolves cannot revive an invalidated draft with a late answer", async () => {
    addLab();
    const resolve = rail.resolve.bind(rail);
    vi.spyOn(rail, "resolve").mockImplementation(async request => {
      db.exec("UPDATE lab_occurrences SET timezone='Europe/Moscow'");
      db.exec("UPDATE lab_occurrences SET timezone='Asia/Novosibirsk'");
      return resolve(request);
    });
    await expect(preview("in-flight", { offerRef: "lab:november" })).rejects.toThrow("CHECKOUT_QUOTE_STALE");
    expect(intent()).toMatchObject({ state: "EXPIRED", consumed_at: null });
    expect(count("orders")).toBe(0);
  });

  it("LAB: invalidation is rolled back together with a failed occurrence edit", async () => {
    addLab();
    await quoted(await preview("rollback", { offerRef: "lab:november" }));
    expect(() => db.transaction(() => {
      db.exec("UPDATE lab_occurrences SET timezone='Europe/Moscow'");
      expect(intent().state).toBe("EXPIRED");
      throw new Error("EDITOR_TRANSACTION_ABORTED");
    }).immediate()).toThrow("EDITOR_TRANSACTION_ABORTED");
    expect(intent().state).toBe("REVIEW");
  });

  it("LAB: migration 0031 ends legacy unconfirmed quotes without claiming their missing edit history", async () => {
    addLab();
    const quote = await quoted(await preview("upgrade", { offerRef: "lab:november" }));
    const row = db.prepare("SELECT * FROM checkout_quotes").get() as Record<string, unknown>;
    db.close(); setupDatabase("0031");
    addLab();
    // Import the issued quote through the original DRAFT -> RESOLVING -> REVIEW
    // transitions. Modern checkout code requires 0033 and cannot run on 0030.
    const reviewFields = ["base_amount_kopecks", "discount_kopecks", "final_amount_kopecks", "rail_quote_json", "expires_at"];
    const legacyColumns = new Set((db.pragma("table_info(checkout_quotes)") as Array<{ name: string }>).map(column => column.name));
    const draft = Object.fromEntries(Object.entries({ ...row, state: "DRAFT",
      ...Object.fromEntries(reviewFields.map((key) => [key, null])) }).filter(([key]) => legacyColumns.has(key)));
    const fields = Object.keys(draft);
    db.prepare(`INSERT INTO checkout_quotes(${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(draft));
    db.prepare("UPDATE checkout_quotes SET state='RESOLVING'").run();
    db.prepare(`UPDATE checkout_quotes SET state='REVIEW',${reviewFields.map((key) => `${key}=?`).join(",")}`).run(...reviewFields.map((key) => row[key]));
    const version = "0031_lab_quote_invalidation.sql";
    applyV2Migration(db, version, readFileSync(join(process.cwd(), "commerce-v2/migrations", version), "utf8"));
    expect(intent()).toMatchObject({ state: "EXPIRED", consumed_at: null });
    migrateV2(db); // Current checkout code can run after the complete upgrade.
    await expect(confirm(quote.quoteId, "old-upgrade")).rejects.toThrow("CHECKOUT_QUOTE_STALE");
    expect(count("orders")).toBe(0);
  });

  it("LAB: title, price and venue publicity edits preserve the issued quote", async () => {
    addLab();
    const quote = await quoted(await preview("ordinary", { offerRef: "lab:november" }));
    db.exec("UPDATE lab_occurrences SET title='Новое название',venue_public=1");
    db.exec("UPDATE offers SET price_kopecks=price_kopecks+1000 WHERE id='lab-offer'");
    expect(intent().state).toBe("REVIEW");
    expect(await confirm(quote.quoteId, "ordinary-pay")).toMatchObject({ state: "PAID" });
    expect(db.prepare("SELECT total_kopecks FROM orders").get()).toEqual({ total_kopecks: 250000 });
  });

  it("LAB: after confirm an occurrence edit cannot cancel a pending payment or release its seat", async () => {
    addLab();
    const input = { ...customer, offerRef: "lab:november", previewIdempotencyKey: "lab-pending", scenario: "customer_action" };
    const quote = await quoted(await prepareCheckout(db, rail, testCheckoutConfig, input, T0));
    expect(await confirm(quote.quoteId, "pay")).toMatchObject({ state: "CUSTOMER_ACTION_REQUIRED" });
    const frozen = (db.prepare("SELECT occurrence_snapshot_json FROM order_lines").get() as { occurrence_snapshot_json: string }).occurrence_snapshot_json;
    db.exec("UPDATE lab_occurrences SET starts_at='2026-11-02T09:00:00Z',ends_at='2026-11-02T17:00:00Z',venue_address='Новый адрес'");
    expect(await prepareCheckout(db, rail, testCheckoutConfig, input, at(20)))
      .toMatchObject({ state: "CUSTOMER_ACTION_REQUIRED", orderPublicId: intent().order_public_id });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "PAYMENT_PENDING" });
    expect((db.prepare("SELECT occurrence_snapshot_json FROM order_lines").get() as { occurrence_snapshot_json: string }).occurrence_snapshot_json).toBe(frozen);
    const row = db.prepare("SELECT occurrence_ref,capacity,admin_reserved_seats FROM lab_occurrences").get() as Pick<LabOccurrenceRow, "occurrence_ref" | "capacity" | "admin_reserved_seats">;
    expect(labSeatInventory(db, row)).toMatchObject({ pending: 1, customerCommitted: 1, available: 19 });
  });

  it.each([
    ["offer withdrawal", () => db.prepare("UPDATE products SET withdrawn_at=?,withdrawn_reason='withdrawn',withdrawn_terms_ref='terms'").run(T0), "OFFER_NOT_AVAILABLE"],
    ["a legal release change", () => {
      db.prepare("UPDATE legal_releases SET active=0").run();
      db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
        VALUES ('legal-2','COURSES','stage-a-v2',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
    }, "CHECKOUT_QUOTE_STALE"],
    ["a storefront close", () => db.prepare("UPDATE sales_activation SET revoked_at=?,revocation_reason='stop'").run(T0), "SALES_ACTIVATION_REQUIRED"],
  ])("is ended by %s", async (_event, change, code) => {
    const quote = await quoted(await preview("ended"));
    change();
    const create = vi.spyOn(rail, "create");
    await expect(confirm(quote.quoteId, "pay")).rejects.toThrow(code);
    expect(create).not.toHaveBeenCalled();
    expect(intent()).toMatchObject({ state: "REVIEW", consumed_at: null });
  });

  it("expires after 15 minutes; a new intent needs a new order", async () => {
    const quote = await quoted(await preview("expiry"));
    expect(quote.expiresAt).toBe(at(15));
    await expect(confirm(quote.quoteId, "pay", at(15))).rejects.toThrow("CHECKOUT_QUOTE_EXPIRED");
    expect(intent()).toMatchObject({ state: "EXPIRED", consumed_at: null });
    await expect(preview("expiry", {}, at(16))).rejects.toThrow("CHECKOUT_QUOTE_EXPIRED");
    const next = await quoted(await preview("expiry-next", {}, at(16)));
    expect(next.quoteId).not.toBe(quote.quoteId);
    expect(new Set((db.prepare("SELECT order_public_id FROM checkout_quotes").all() as { order_public_id: string }[])
      .map(({ order_public_id }) => order_public_id)).size).toBe(2);
  });

  it("ends at the LAB start and at the end of the applied promotion when those come first", async () => {
    addLab(at(5));
    const lab = await quoted(await prepareCheckout(db, rail, testCheckoutConfig,
      { ...customer, offerRef: "lab:november", previewIdempotencyKey: "lab" }, T0));
    expect(lab.expiresAt).toBe(at(5));
    saveMerchantPromotion(db, { id: "promotion", code: "FX-SHORT", discountKind: "FIXED", discountValue: 1_000,
      endsAt: at(7), actor: "operator", expectedVersion: 0 }, "FX-", T0);
    const promoted = await quoted(await prepareCheckout(db, rail, { ...testCheckoutConfig, merchantPromotionPrefix: "FX-" },
      { ...customer, offerRef: "course:one", previewIdempotencyKey: "promo", checkoutCode: "FX-SHORT" }, T0));
    expect(promoted.expiresAt).toBe(at(7));
  });

  it("keeps the promotion price when the promotion rule changes, and ends when the promotion is switched off", async () => {
    const config = { ...testCheckoutConfig, merchantPromotionPrefix: "FX-" };
    saveMerchantPromotion(db, { id: "promotion", code: "FX-LAUNCH", discountKind: "FIXED", discountValue: 1_000,
      actor: "operator", expectedVersion: 0 }, "FX-", T0);
    const quote = await quoted(await prepareCheckout(db, rail, config,
      { ...customer, offerRef: "course:one", previewIdempotencyKey: "promo", checkoutCode: "FX-LAUNCH" }, T0));
    db.prepare("UPDATE merchant_promotion SET discount_value=3000").run();
    db.prepare("UPDATE offers SET price_kopecks=12000").run();
    expect(await confirmCheckout(db, rail, config, { ...customer, quoteId: quote.quoteId, idempotencyKey: "pay" }, at(1)))
      .toMatchObject({ state: "PAID" });
    expect(db.prepare("SELECT total_kopecks FROM orders").get()).toEqual({ total_kopecks: 9_000 });
  });
});

describe("intent storage guards (migration 0030)", () => {
  it("never changes what the intent froze, and only moves forward before confirmation", async () => {
    await quoted(await preview("guard"));
    expect(() => db.prepare("UPDATE checkout_quotes SET line_ref='other'").run()).toThrow("CHECKOUT_INTENT_FROZEN");
    expect(() => db.prepare("UPDATE checkout_quotes SET resolution_request_json='{}'").run()).toThrow("CHECKOUT_INTENT_FROZEN");
    expect(() => db.prepare("UPDATE checkout_quotes SET final_amount_kopecks=1,base_amount_kopecks=1,discount_kopecks=0").run()).toThrow("CHECKOUT_INTENT_FROZEN");
    expect(() => db.prepare("UPDATE checkout_quotes SET state='RESOLVING'").run()).toThrow("CHECKOUT_INTENT_TRANSITION_INVALID");
    expect(() => db.prepare("UPDATE checkout_quotes SET state='PAID'").run()).toThrow();
    expect(() => db.prepare(`INSERT INTO checkout_quotes(id,customer_id,offer_id,legal_release_id,storefront,order_public_id,line_ref,
      preview_idempotency_key,request_fingerprint,resolution_request_json,sale_mode_at_quote,catalog_amount_kopecks,line_snapshot_json,state)
      VALUES ('x','customer','offer','legal','COURSES','o','l','k',?,'{}','PUBLIC',1,'{}','REVIEW')`).run("a".repeat(64)))
      .toThrow("CHECKOUT_INTENT_DRAFT_REQUIRED");
  });

  it("converts quotes written before the migration without inventing a frozen request", () => {
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    const directory = join(process.cwd(), "commerce-v2", "migrations");
    const versions = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
    for (const version of versions.filter((name) => name < "0030")) applyV2Migration(legacy, version, readFileSync(join(directory, version), "utf8"));
    legacy.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    legacy.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
    legacy.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')").run();
    legacy.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','course:one','product',10000,'PUBLIC')").run();
    for (const [id, state] of [["review", "REVIEW"], ["expired", "EXPIRED"]]) {
      legacy.prepare(`INSERT INTO checkout_quotes(id,customer_id,offer_id,legal_release_id,order_public_id,line_ref,preview_idempotency_key,
        base_amount_kopecks,discount_kopecks,final_amount_kopecks,rail_quote_json,state,expires_at,catalog_amount_kopecks,line_snapshot_json)
        VALUES (?,?,?,?,?,?,?,10000,0,10000,'{}',?,?,10000,'{}')`).run(id, "customer", "offer", "legal", `order-${id}`, `line-${id}`, `key-${id}`, state, at(15));
    }
    applyV2Migration(legacy, "0030_checkout_intents.sql", readFileSync(join(directory, "0030_checkout_intents.sql"), "utf8"));
    expect(legacy.prepare(`SELECT id,state,storefront,sale_mode_at_quote,request_fingerprint,resolution_request_json,line_ref
      FROM checkout_quotes ORDER BY id`).all()).toEqual([
      { id: "expired", state: "EXPIRED", storefront: "COURSES", sale_mode_at_quote: "PUBLIC", request_fingerprint: null, resolution_request_json: null, line_ref: "line-expired" },
      { id: "review", state: "REVIEW", storefront: "COURSES", sale_mode_at_quote: "PUBLIC", request_fingerprint: null, resolution_request_json: null, line_ref: "line-review" },
    ]);
  });
});

describe("HTTP", () => {
  const app = (instant = T0, customerId = "customer") => createCommerceV2App({ db, config: testCheckoutConfig, serviceToken: "synthetic", sourceCommit: "a".repeat(40),
    paymentRail: rail, authenticateCustomer: async () => customerId, now: () => new Date(instant) });
  const post = (path: string, key: string, body: unknown, instant = T0, customerId = "customer") => app(instant, customerId).request(path, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });

  it.each(["stale", "cancelled", "expired"])("answers a final %s quote refusal with HTTP 409 and never starts payment", async reason => {
    addLab();
    const issued = await post("/v1/checkout/preview", "issued", { offerRef: "lab:november", storefront: "LAB" });
    expect(issued.status).toBe(200);
    const quote = await issued.json() as { quoteId: string };
    if (reason === "stale") db.exec("UPDATE lab_occurrences SET timezone='Europe/Moscow'");
    if (reason === "cancelled") cancelLabOccurrence(db, { occurrenceRef: "lab:november", actor: "owner", reason: "cancelled", expectedVersion: 1 }, T0);
    const create = vi.spyOn(rail, "create");
    const response = await post("/v1/checkout", "refused-pay", { quoteId: quote.quoteId, storefront: "LAB" }, reason === "expired" ? at(20) : T0);
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: reason === "stale" ? "CHECKOUT_QUOTE_STALE"
      : reason === "cancelled" ? "LAB_OCCURRENCE_CANCELLED" : "CHECKOUT_QUOTE_EXPIRED" });
    expect(create).not.toHaveBeenCalled();
    expect(count("orders")).toBe(0);
  });

  it("refuses the second last-seat preview with HTTP 409 while the held quote remains confirmable", async () => {
    addLab();
    db.exec("UPDATE lab_occurrences SET capacity=1");
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('second','second@example.com')").run();
    const one = await (await post("/v1/checkout/preview", "seat-one", { offerRef: "lab:november" })).json() as { quoteId: string };
    const create = vi.spyOn(rail, "create");
    for (let repeat = 0; repeat < 2; repeat++) {
      const refused = await post("/v1/checkout/preview", "seat-two", { offerRef: "lab:november" }, T0, "second");
      expect(refused.status).toBe(409);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(await refused.json()).toEqual({ code: "LAB_OCCURRENCE_SOLD_OUT" });
    }
    expect((await post("/v1/checkout", "pay-one", { quoteId: one.quoteId })).status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    expect(count("orders")).toBe(1);
    expect(count("checkout_attempts")).toBe(1);
  });

  it("answers a preview for a started LAB with HTTP 409", async () => {
    addLab();
    const create = vi.spyOn(rail, "create");
    const response = await post("/v1/checkout/preview", "started", { offerRef: "lab:november" }, "2026-11-01T09:00:00.000Z");
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "LAB_OCCURRENCE_STARTED" });
    expect(create).not.toHaveBeenCalled();
    expect(count("orders")).toBe(0);
  });

  it.each(["withdrawn", "fiscal-retired", "fiscal-replaced", "activation-revoked"])("answers %s admission as HTTP 409 before any payment", async reason => {
    addLab();
    const quote = await (await post("/v1/checkout/preview", "admitted", { offerRef: "lab:november" })).json() as { quoteId: string };
    if (reason === "withdrawn") db.prepare("UPDATE products SET withdrawn_at=?,withdrawn_reason='withdrawn',withdrawn_terms_ref='terms' WHERE id='lab-product'").run(T0);
    else if (reason === "activation-revoked") db.prepare("UPDATE sales_activation SET revoked_at=?,revocation_reason='stop' WHERE product_kind='LAB'").run(T0);
    else {
      const policy = db.prepare("SELECT id FROM fiscal_policy_versions WHERE offer_ref='lab:november' AND status='QUALIFIED'").get() as { id: string };
      retireFiscalPolicy(db, { policyId: policy.id, actor: "owner" }, T0);
      if (reason === "fiscal-replaced") qualifyTestFiscalPolicies(db);
    }
    const create = vi.spyOn(rail, "create");
    const response = await post("/v1/checkout", "refused", { quoteId: quote.quoteId });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: reason === "withdrawn" ? "OFFER_NOT_AVAILABLE"
      : reason === "activation-revoked" ? "SALES_ACTIVATION_REQUIRED" : "FISCAL_POLICY_NOT_QUALIFIED" });
    expect(create).not.toHaveBeenCalled();
    expect(count("orders")).toBe(0);
  });

  it("answers a disabled promotion on an issued quote as HTTP 409", async () => {
    const prefix = testCheckoutConfig.merchantPromotionPrefix;
    saveMerchantPromotion(db, { id: "http-promo", code: `${prefix}LAUNCH`, discountKind: "FIXED", discountValue: 1000,
      actor: "owner", expectedVersion: 0 }, prefix, T0);
    const quote = await (await post("/v1/checkout/preview", "promoted", { offerRef: "course:one", checkoutCode: `${prefix}LAUNCH` })).json() as { quoteId: string };
    db.exec("UPDATE merchant_promotion SET active=0");
    const create = vi.spyOn(rail, "create");
    const response = await post("/v1/checkout", "promo-refused", { quoteId: quote.quoteId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CHECKOUT_QUOTE_STALE" });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not turn an unexpected fiscal-policy DB fault into a checkout conflict", async () => {
    const quote = await quoted(await preview("db-fault"));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("FROM fiscal_policy_versions")) throw new Error("SQLITE_IOERR_TEST SELECT customer_secret token=private-test-token", { cause: new Error("private cause") });
      return prepare(sql);
    }) as typeof db.prepare);
    try {
      const response = await post("/v1/checkout", "fault", { quoteId: quote.quoteId });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "CHECKOUT_UNAVAILABLE" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "CHECKOUT_FAILURE", code: "CHECKOUT_UNAVAILABLE", errorKind: "ERROR" }));
    } finally { spy.mockRestore(); diagnostic.mockRestore(); }
    expect(count("orders")).toBe(0);
  });

  it.each([new Error("UPSTREAM_UNAVAILABLE token=private-test-token", { cause: new Error("private cause") }), { secret: "private-test-token" }, "private-test-token"])("sanitizes unknown upstream failures as HTTP 503 (%#)", async failure => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.spyOn(rail, "resolve").mockRejectedValue(failure);
      const response = await post("/v1/checkout/preview", "unavailable", { offerRef: "course:one" });
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "CHECKOUT_PREVIEW_UNAVAILABLE" });
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "CHECKOUT_FAILURE", code: "CHECKOUT_PREVIEW_UNAVAILABLE", errorKind: failure instanceof Error ? "ERROR" : "NON_ERROR" }));
    } finally { diagnostic.mockRestore(); }
  });

  it("keeps the sanitized 503 when the diagnostic transport fails", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("diagnostic transport failed"); });
    try {
      vi.spyOn(rail, "resolve").mockRejectedValue(new Error("private upstream detail"));
      const response = await post("/v1/checkout/preview", "diagnostic-fault", { offerRef: "course:one" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "CHECKOUT_PREVIEW_UNAVAILABLE" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally { diagnostic.mockRestore(); }
  });

  it("answers a lost resolution with 202, a changed repeat with 409, and an open payment with 409 naming the order", async () => {
    expect((await post("/v1/checkout/preview", "http", { offerRef: "course:one", mockScenario: "ambiguous_resolve" })).status).toBe(202);
    expect((await post("/v1/checkout/preview", "http", { offerRef: "course:one", mockScenario: "ambiguous_resolve" })).status).toBe(200);
    const changed = await post("/v1/checkout/preview", "http", { offerRef: "course:one", checkoutCode: "OTHER" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ code: "IDEMPOTENCY_KEY_REUSED" });

    const open = await (await post("/v1/checkout/preview", "open", { offerRef: "course:one", mockScenario: "customer_action" })).json() as { quoteId: string };
    const started = await (await post("/v1/checkout", "open-pay", { quoteId: open.quoteId })).json() as { orderPublicId: string };
    const refused = await post("/v1/checkout/preview", "after", { offerRef: "course:one" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: "CHECKOUT_PAYMENT_IN_PROGRESS", orderPublicId: started.orderPublicId });
  });
});

describe("review regressions", () => {
  it("rejects a changed supplied order ref before calling Refref again", async () => {
    const resolve = vi.spyOn(rail, "resolve");
    await quoted(await preview("same", { orderPublicId: "order-a" }));
    await expect(preview("same", { orderPublicId: "order-b" })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("replays a lost RC.2 HTTP resolution with the original token and byte-identical request", async () => {
    const committed = new Map<string, { body: string; response: unknown }>();
    let loseAnswer = true;
    const http = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = String(init?.body);
      const request = JSON.parse(body);
      const previous = committed.get(request.handoffToken);
      if (previous) {
        expect(body).toBe(previous.body);
        return Response.json(previous.response);
      }
      const response = { status: "RESOLVED", referralResolutionId: "resolution", termsVersionId: null,
        checkoutCodeOutcome: "NONE", expiresAt: at(5),
        lines: [{ lineRef: request.lines[0].lineRef, referralDiscountAmountKopecks: 0 }] };
      committed.set(request.handoffToken, { body, response });
      if (loseAnswer) { loseAnswer = false; throw new TypeError("answer lost after commit"); }
      return Response.json(response);
    });
    const real = new RefrefPaymentRail({ apiBaseUrl: "https://synthetic.test", apiKey: "test", merchantId: "test", fetch: http });
    const input = { ...customer, offerRef: "course:one", previewIdempotencyKey: "lost-token", handoffToken: "a".repeat(32) };
    expect(await prepareCheckout(db, real, testCheckoutConfig, input, T0)).toMatchObject({ state: "RESOLUTION_PENDING" });
    await expect(prepareCheckout(db, real, testCheckoutConfig, { ...input, handoffToken: "b".repeat(32) }, at(1)))
      .rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    const quote = await quoted(await prepareCheckout(db, real, testCheckoutConfig, input, at(1)));
    expect(quote.expiresAt).toBe(at(5));
    expect(committed.size).toBe(1);
    expect(http).toHaveBeenCalledTimes(2);
    expect(intent().resolution_sends).toBe(2);
  });
  it("uses the real Refref resolution deadline before any attempt or order exists", async () => {
    const http = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ status: "RESOLVED", referralResolutionId: "resolution", termsVersionId: null,
        checkoutCodeOutcome: "NONE", expiresAt: at(5), lines: [{ lineRef: body.lines[0].lineRef, referralDiscountAmountKopecks: 0 }] });
    });
    const real = new RefrefPaymentRail({ apiBaseUrl: "https://synthetic.test", apiKey: "test", merchantId: "test", fetch: http });
    const q = await quoted(await prepareCheckout(db, real, testCheckoutConfig,
      { ...customer, offerRef: "course:one", previewIdempotencyKey: "deadline", handoffToken: "h".repeat(32) }, T0));
    expect(q.expiresAt).toBe(at(5));
    await expect(confirmCheckout(db, real, testCheckoutConfig, { ...customer, quoteId: q.quoteId, idempotencyKey: "pay" }, at(6)))
      .rejects.toThrow("CHECKOUT_QUOTE_EXPIRED");
    expect(count("orders")).toBe(0);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it.each(["HANDOFF_TOKEN_INVALID", "HANDOFF_TOKEN_ALREADY_BOUND", "MULTI_CAMPAIGN_CART_REQUIRES_SPLIT"])(
    "replays definitive %s as a conflict instead of an unavailable service", async code => {
      const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code } }, { status: 422 }));
      const real = new RefrefPaymentRail({ apiBaseUrl: "https://synthetic.test", apiKey: "test", merchantId: "test", fetch: http });
      const server = createCommerceV2App({ db, config: testCheckoutConfig, serviceToken: "test", sourceCommit: "a".repeat(40),
        paymentRail: real, authenticateCustomer: async () => customer.customerId, now: () => new Date(T0) });
      for (let i = 0; i < 2; i++) {
        const r = await server.request("/v1/checkout/preview", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "refused" },
          body: JSON.stringify({ offerRef: "course:one", handoffToken: "h".repeat(32) }) });
        expect(r.status).toBe(409);
        expect(await r.json()).toMatchObject({ code: `REFREF_${code}` });
      }
      expect(intent().state).toBe("REFUSED");
      expect(http).toHaveBeenCalledTimes(1);
    });
  it("ends a proven attempt refusal durably and permits a fresh intent", async () => {
    const q = await quoted(await preview("attempt-refusal"));
    const http = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === "GET"
      ? Response.json({ error: { code: "ORDER_NOT_FOUND" } }, { status: 404 })
      : Response.json({ error: { code: "REFERRAL_RESOLUTION_NOT_USABLE" } }, { status: 422 }));
    const real = new RefrefPaymentRail({ apiBaseUrl: "https://synthetic.test", apiKey: "test", merchantId: "test", fetch: http });
    await expect(confirmCheckout(db, real, testCheckoutConfig, { ...customer, quoteId: q.quoteId, idempotencyKey: "pay" }, at(1)))
      .rejects.toThrow("REFREF_REFERRAL_RESOLUTION_NOT_USABLE");
    expect(intent().state).toBe("DECLINED");
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "CANCELLED" });
    expect(db.prepare("SELECT state,refref_attempt_id FROM checkout_attempts").get()).toEqual({ state: "DECLINED", refref_attempt_id: null });
    expect(await reconcileCheckout(db, real, intent().order_public_id, at(2))).toMatchObject({ state: "DECLINED" });
    expect(http).toHaveBeenCalledTimes(2);
    await quoted(await preview("fresh", {}, at(20)));
  });
  it("refuses cancelled LAB intent and preserves seats of an uncertain payment", async () => {
    addLab();
    const q = await quoted(await preview("cancelled", { offerRef: "lab:november" }));
    cancelLabOccurrence(db, { occurrenceRef: "lab:november", expectedVersion: 1, actor: "test", reason: "Cancelled" }, T0);
    await expect(confirm(q.quoteId, "pay")).rejects.toThrow("LAB_OCCURRENCE_CANCELLED");
    expect(count("orders")).toBe(0);
  });
  it("retains a LAB seat for an uncertain attempt after the quote deadline", async () => {
    addLab();
    const q = await quoted(await preview("uncertain-lab", { offerRef: "lab:november", scenario: "ambiguous_create" }));
    await confirm(q.quoteId, "pay");
    const row = db.prepare("SELECT occurrence_ref,capacity,admin_reserved_seats FROM lab_occurrences").get() as Pick<LabOccurrenceRow, "occurrence_ref" | "capacity" | "admin_reserved_seats">;
    expect(labSeatInventory(db, row)).toMatchObject({ pending: 1, available: 19 });
    expect(await preview("uncertain-lab", { offerRef: "lab:november", scenario: "ambiguous_create" }, at(20)))
      .toMatchObject({ orderPublicId: intent().order_public_id });
  });
});


describe("ART-200 merchant-local LAB holds", () => {
  const lab = (key: string, now = T0, extra: Partial<Parameters<typeof prepareCheckout>[3]> = {}) =>
    preview(key, { offerRef: "lab:november", ...extra }, now);
  const inventory = (now = T0) => labSeatInventory(db,
    db.prepare("SELECT * FROM lab_occurrences").get() as LabOccurrenceRow, now);
  const hold = (quoteId: string) => db.prepare("SELECT seat_hold_ref,seat_hold_expires_at,line_snapshot_json FROM checkout_quotes WHERE id=?")
    .get(quoteId) as { seat_hold_ref: string; seat_hold_expires_at: string; line_snapshot_json: string };

  it("reserves before resolution, reuses the same hold, freezes its deadline and converts it after commit", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    const resolve = rail.resolve.bind(rail);
    vi.spyOn(rail, "resolve").mockImplementation(async input => {
      expect(db.inTransaction).toBe(false);
      expect(inventory()).toMatchObject({ held: 1, pending: 1, available: 0 });
      return resolve(input);
    });
    const q = await quoted(await lab("held"));
    const first = hold(q.quoteId);
    expect(JSON.parse(first.line_snapshot_json).seatHold).toEqual({ ref: first.seat_hold_ref, expiresAt: at(15) });
    await lab("held", at(2));
    expect(hold(q.quoteId)).toEqual(first);
    expect(() => db.prepare("UPDATE checkout_quotes SET seat_hold_expires_at=?").run(at(30))).toThrow("CHECKOUT_SEAT_HOLD_FROZEN");
    const create = rail.create.bind(rail);
    vi.spyOn(rail, "create").mockImplementation(async input => {
      expect(db.inTransaction).toBe(false);
      expect(inventory(at(3))).toMatchObject({ held: 0, pending: 1, available: 0 });
      expect(count("orders")).toBe(1); expect(count("checkout_attempts")).toBe(1);
      expect(JSON.stringify(input)).not.toMatch(/inventoryReservation|latePaymentPolicy|seatHold/);
      return create(input);
    });
    db.exec("UPDATE offers SET sale_mode='CLOSED',price_kopecks=999999 WHERE id='lab-offer'");
    expect(await confirm(q.quoteId, "pay", at(3))).toMatchObject({ state: "PAID" });
    expect(inventory(at(4))).toMatchObject({ held: 0, pending: 0, sold: 1, available: 0 });
  });

  it("frees an expired unconfirmed hold and refuses its old quote after another buyer takes the seat", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    const old = await quoted(await lab("old"));
    expect(inventory(at(15))).toMatchObject({ held: 0, available: 1 });
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('second','second@example.com')").run();
    await quoted(await lab("second", at(15), { customerId: "second", customerEmail: "second@example.com" }));
    await expect(confirm(old.quoteId, "old-pay", at(16))).rejects.toThrow("CHECKOUT_QUOTE_EXPIRED");
    expect(count("orders")).toBe(0);
    expect(inventory(at(16))).toMatchObject({ held: 1, available: 0 });
  });

  it("replaces a hold atomically and rolls the replacement back if new admission fails", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    const old = await quoted(await lab("old"));
    db.exec("UPDATE offers SET sale_mode='CLOSED' WHERE id='lab-offer'");
    await expect(lab("failed", at(1))).rejects.toThrow("OFFER_CLOSED");
    expect(db.prepare("SELECT state FROM checkout_quotes WHERE id=?").get(old.quoteId)).toEqual({ state: "REVIEW" });
    db.exec("UPDATE offers SET sale_mode='PUBLIC' WHERE id='lab-offer'");
    const fresh = await quoted(await lab("new", at(2), { checkoutCode: "PARTNER" }));
    expect(fresh.quoteId).not.toBe(old.quoteId);
    expect(inventory(at(3))).toMatchObject({ held: 1, available: 0 });
    await expect(confirm(old.quoteId, "old-pay", at(3))).rejects.toThrow("CHECKOUT_INTENT_REPLACED");
    await expect(lab("old", at(3))).rejects.toThrow("CHECKOUT_INTENT_REPLACED");
    expect(await confirm(fresh.quoteId, "new-pay", at(3))).toMatchObject({ state: "PAID" });
  });

  it("inherits the original hold deadline through chained replacements and frees the last seat at minute 15", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    const original = await quoted(await lab("original"));
    const middle = await quoted(await lab("middle", at(7)));
    const replacement = await quoted(await lab("replacement", at(14), { checkoutCode: "PARTNER" }));
    expect(new Set([original.quoteId, middle.quoteId, replacement.quoteId]).size).toBe(3);
    const holds = [original, middle, replacement].map(q => hold(q.quoteId));
    expect(new Set(holds.map(row => row.seat_hold_ref)).size).toBe(3);
    for (const row of holds) {
      expect(row.seat_hold_expires_at).toBe(at(15));
      expect(JSON.parse(row.line_snapshot_json).seatHold.expiresAt).toBe(at(15));
    }
    expect(replacement.expiresAt).toBe(at(15));
    expect(inventory(at(14))).toMatchObject({ held: 1, available: 0 });
    expect(inventory(at(15))).toMatchObject({ held: 0, available: 1 });
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('second','second@example.com')").run();
    const second = await quoted(await lab("second", at(15), { customerId: "second", customerEmail: "second@example.com" }));
    expect(second.expiresAt).toBe(at(30));
    await expect(confirm(original.quoteId, "old-pay", at(15))).rejects.toThrow("CHECKOUT_INTENT_REPLACED");
    await expect(confirm(middle.quoteId, "middle-pay", at(15))).rejects.toThrow("CHECKOUT_INTENT_REPLACED");
    await expect(confirm(replacement.quoteId, "replacement-pay", at(15))).rejects.toThrow("CHECKOUT_QUOTE_EXPIRED");
    expect(await confirm(second.quoteId, "second-pay", at(15), { customerId: "second", customerEmail: "second@example.com" }))
      .toMatchObject({ state: "PAID" });
    expect(count("orders")).toBe(1);
  });

  it("retains a replacement's seat beyond its inherited deadline once an unanswered payment has started", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    await quoted(await lab("original"));
    const replacement = await quoted(await lab("replacement", at(14), { scenario: "ambiguous_create" }));
    expect(replacement.expiresAt).toBe(at(15));
    expect(await confirm(replacement.quoteId, "pay", at(14))).toMatchObject({ state: "CREATE_UNKNOWN" });
    expect(inventory(at(16))).toMatchObject({ held: 0, pending: 1, available: 0 });
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('second','second@example.com')").run();
    await expect(lab("second", at(16), { customerId: "second", customerEmail: "second@example.com" }))
      .rejects.toThrow("LAB_OCCURRENCE_SOLD_OUT");
    expect(await confirm(replacement.quoteId, "retry", at(16))).toMatchObject({ state: "PAID" });
    expect(count("orders")).toBe(1); expect(count("checkout_attempts")).toBe(1);
  });

  it("retains an unanswered attempt beyond TTL and recovers the same order and attempt without a new hold", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    const q = await quoted(await lab("uncertain", T0, { scenario: "ambiguous_create" }));
    const first = hold(q.quoteId);
    const create = vi.spyOn(rail, "create"), recover = vi.spyOn(rail, "recoverCreate");
    const result = await confirm(q.quoteId, "pay");
    expect(result.state).toBe("CREATE_UNKNOWN");
    expect(inventory(at(40))).toMatchObject({ held: 0, pending: 1, available: 0 });
    expect(await confirm(q.quoteId, "retry-key", at(40))).toMatchObject({ orderPublicId: result.orderPublicId, state: "PAID" });
    expect(create).toHaveBeenCalledTimes(1); expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0][0]).toEqual(create.mock.calls[0][0]);
    expect(hold(q.quoteId)).toEqual(first);
    expect(count("orders")).toBe(1); expect(count("checkout_attempts")).toBe(1);
    expect(inventory(at(40))).toMatchObject({ held: 0, sold: 1, available: 0 });
  });

  it("counts holds in operator capacity/reserve edits and releases a refused resolution", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    const original = rail.resolve.bind(rail);
    vi.spyOn(rail, "resolve").mockRejectedValueOnce(new RailRefusalError("REFUSED"));
    await expect(lab("refused")).rejects.toThrow("REFUSED");
    expect(inventory()).toMatchObject({ held: 0, available: 1 });
    vi.spyOn(rail, "resolve").mockImplementation(original);
    await quoted(await lab("held"));
    expect(() => editLabOccurrence(db, { occurrenceRef: "lab:november", expectedVersion: 1,
      patch: { adminReservedSeats: 1 }, actor: "owner", reason: "reserve" }, T0)).toThrow("LAB_RESERVE_EXCEEDS_AVAILABLE_CAPACITY");
  });

  it("confirms the same last-seat hold concurrently without seeking a second seat or attempt", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    const q = await quoted(await lab("one"));
    const create = vi.spyOn(rail, "create");
    const results = await Promise.all([confirm(q.quoteId, "one-pay"), confirm(q.quoteId, "two-pay")]);
    expect(new Set(results.map(result => result.orderPublicId)).size).toBe(1);
    expect(count("orders")).toBe(1); expect(count("checkout_attempts")).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(inventory(at(2))).toMatchObject({ held: 0, sold: 1, available: 0 });
  });

  it("reuses a single hold for two overlapping requests with the same key", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    const results = await Promise.all([lab("same"), lab("same")]);
    expect(results.map(result => result.state)).toEqual(["PRICE_REVIEW_REQUIRED", "PRICE_REVIEW_REQUIRED"]);
    expect(count("checkout_quotes")).toBe(1);
    expect(inventory()).toMatchObject({ held: 1, available: 0 });
  });

  it("upgrades old LAB quotes by expiring only unconfirmed intents, preserving started payments", () => {
    addLab();
    const legacy = new Database(":memory:"); legacy.pragma("foreign_keys=ON");
    try {
      const directory = join(process.cwd(), "commerce-v2/migrations");
      for (const version of readdirSync(directory).filter(name => name.endsWith(".sql") && name < "0033").sort()) {
        applyV2Migration(legacy, version, readFileSync(join(directory, version), "utf8"));
      }
      for (const table of ["customers", "legal_releases", "cities", "lab_occurrences", "products", "offers"]) {
        for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
          const columns = Object.keys(row);
          legacy.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
        }
      }
      for (const id of ["unconfirmed", "started"]) {
        legacy.prepare(`INSERT INTO checkout_quotes(id,customer_id,offer_id,legal_release_id,storefront,order_public_id,
          line_ref,preview_idempotency_key,request_fingerprint,resolution_request_json,sale_mode_at_quote,
          catalog_amount_kopecks,line_snapshot_json,state,created_at,updated_at)
          VALUES (?,'customer','lab-offer','lab-legal','LAB',?,?,?,?, '{}','PUBLIC',250000,'{}','DRAFT',?,?)`)
          .run(id, `order-${id}`, `line-${id}`, `key-${id}`, "a".repeat(64), T0, T0);
        legacy.prepare("UPDATE checkout_quotes SET state='RESOLVING' WHERE id=?").run(id);
        legacy.prepare(`UPDATE checkout_quotes SET state='REVIEW',rail_quote_json='{}',base_amount_kopecks=250000,
          discount_kopecks=0,final_amount_kopecks=250000,expires_at=? WHERE id=?`).run(at(15), id);
      }
      legacy.prepare("UPDATE checkout_quotes SET state='PAYMENT_CREATING',consumed_at=? WHERE id='started'").run(at(1));
      legacy.exec("UPDATE checkout_quotes SET state='UNCERTAIN' WHERE id='started'");
      const started = legacy.prepare("SELECT * FROM checkout_quotes WHERE id='started'").get();
      migrateV2(legacy);
      expect(legacy.prepare("SELECT state,failure_code FROM checkout_quotes WHERE id='unconfirmed'").get())
        .toEqual({ state: "EXPIRED", failure_code: "CHECKOUT_QUOTE_EXPIRED" });
      expect(legacy.prepare("SELECT * FROM checkout_quotes WHERE id='started'").get())
        .toEqual({ ...started as object, seat_hold_ref: null, seat_hold_expires_at: null });
      expect(legacy.pragma("foreign_key_check")).toEqual([]);
    } finally { legacy.close(); }
  });

  it("serializes two independent SQLite processes quoting the last seat", async () => {
    addLab(); db.exec("UPDATE lab_occurrences SET capacity=1");
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('second','second@example.com')").run();
    const directory = mkdtempSync(join(tmpdir(), "lab-hold-race-"));
    const filename = join(directory, "commerce.sqlite");
    const children: ReturnType<typeof fork>[] = [];
    try {
      await db.backup(filename);
      const runs = ["customer", "second"].map(customerId => {
        const child = fork(join(process.cwd(), "commerce-v2/test/fixtures/lab-seat-quote-worker.ts"), [], {
          execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, NODE_ENV: "test" },
        });
        children.push(child);
        let stderr = ""; child.stderr?.on("data", data => { stderr += data; });
        const ready = new Promise<void>((resolve, reject) => {
          child.once("message", () => resolve()); child.once("error", reject);
          child.once("exit", code => { if (code) reject(new Error(stderr)); });
        });
        const result = new Promise<{ state?: string; error?: string }>((resolve, reject) => {
          child.on("message", message => { if (message !== "ready") resolve(message as { state?: string; error?: string }); });
          child.once("error", reject); child.once("exit", code => { if (code) reject(new Error(stderr)); });
        });
        return { child, ready, result, customerId };
      });
      await Promise.all(runs.map(run => run.ready));
      for (const run of runs) run.child.send({ filename, customerId: run.customerId, key: run.customerId, now: T0 });
      const results = await Promise.all(runs.map(run => run.result));
      expect(results.filter(result => result.state === "PRICE_REVIEW_REQUIRED")).toHaveLength(1);
      expect(results.filter(result => result.error === "LAB_OCCURRENCE_SOLD_OUT")).toHaveLength(1);
      const disk = new Database(filename);
      try {
        expect(disk.prepare("SELECT COUNT(*) AS n FROM checkout_quotes WHERE seat_hold_ref IS NOT NULL").get()).toEqual({ n: 1 });
      } finally { disk.close(); }
    } finally { for (const child of children) child.kill(); rmSync(directory, { recursive: true, force: true }); }
  });
});
