import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { checkout, confirmCheckout, MockPaymentRail, prepareCheckout, reconcileCheckout, reconcilePendingCheckouts } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { stageALegalManifestJson } from "./fixtures/legal";

let db: Database.Database;
let rail: MockPaymentRail;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  rail = new MockPaymentRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
    VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
    VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
});

const input = { customerId: "customer", customerEmail: "student@example.com", offerRef: "course:one", idempotencyKey: "checkout-one" };

describe("scripted mock checkout orchestration", () => {
  it("shows the final price before freezing the order snapshot", async () => {
    const prepared = await prepareCheckout(db, rail, { ...input, previewIdempotencyKey: "preview-one" }, "2026-09-30T10:00:00Z");
    expect(prepared).toMatchObject({ state: "PRICE_REVIEW_REQUIRED", baseAmountKopecks: 10000, discountKopecks: 0, finalAmountKopecks: 10000 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM checkout_quotes WHERE state='REVIEW'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");
    const confirmed = await confirmCheckout(db, rail, {
      customerId: input.customerId, customerEmail: input.customerEmail, quoteId: prepared.quoteId, idempotencyKey: input.idempotencyKey,
    }, "2026-09-30T10:01:00Z");
    expect(confirmed.state).toBe("PAID");
    expect(db.prepare("SELECT state,total_kopecks FROM orders").get()).toEqual({ state: "FULFILLED", total_kopecks: 10000 });
    expect(db.prepare("SELECT state FROM checkout_quotes").get()).toEqual({ state: "CONSUMED" });
  });

  it("refuses a handoff storefront that does not own the offer", async () => {
    await expect(prepareCheckout(db, rail, {
      ...input,
      previewIdempotencyKey: "wrong-storefront",
      storefront: "LAB",
    }, "2026-09-30T10:00:00Z")).rejects.toThrow("CHECKOUT_STOREFRONT_MISMATCH");
  });

  it("binds confirmation and the persisted provider return URL to the signed order", async () => {
    const prepared = await prepareCheckout(db, rail, {
      ...input, previewIdempotencyKey: "preview-return", orderPublicId: "signed-order",
    }, "2026-09-30T10:00:00Z");
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");

    await expect(confirmCheckout(db, rail, {
      customerId: input.customerId,
      customerEmail: input.customerEmail,
      quoteId: prepared.quoteId,
      idempotencyKey: "mismatched-return",
      expectedOrderPublicId: "different-order",
      successUrl: "https://flexperiment.ru/checkout/return?state=signed",
    }, "2026-09-30T10:01:00Z")).rejects.toThrow("CHECKOUT_STATE_INVALID");

    await confirmCheckout(db, rail, {
      customerId: input.customerId,
      customerEmail: input.customerEmail,
      quoteId: prepared.quoteId,
      idempotencyKey: "matched-return",
      expectedOrderPublicId: "signed-order",
      successUrl: "https://flexperiment.ru/checkout/return?state=signed",
    }, "2026-09-30T10:01:00Z");

    await expect(confirmCheckout(db, rail, {
      customerId: input.customerId,
      customerEmail: input.customerEmail,
      quoteId: prepared.quoteId,
      idempotencyKey: "matched-return",
      expectedOrderPublicId: "different-order",
    }, "2026-09-30T10:02:00Z")).rejects.toThrow("CHECKOUT_STATE_INVALID");

    const stored = db.prepare("SELECT request_payload_json FROM checkout_attempts").get() as { request_payload_json: string };
    expect(JSON.parse(stored.request_payload_json)).toMatchObject({
      orderPublicId: "signed-order",
      successUrl: "https://flexperiment.ru/checkout/return?state=signed",
    });
  });

  it("snapshots the live offer and grants exactly once across a duplicate request", async () => {
    const first = await checkout(db, rail, input, "2026-09-30T10:00:00Z");
    const duplicate = await checkout(db, rail, input, "2026-09-30T10:00:01Z");
    expect(first).toMatchObject({ state: "PAID" });
    expect(duplicate).toMatchObject({ orderPublicId: first.orderPublicId, state: "PAID" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM course_entitlements").get()).toEqual({ count: 1 });
    const order = db.prepare("SELECT total_kopecks,checkout_snapshot_json,snapshot_hash FROM orders").get() as {
      total_kopecks: number; checkout_snapshot_json: string; snapshot_hash: string;
    };
    expect(order).toMatchObject({ total_kopecks: 10_000, snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const attempt = JSON.parse((db.prepare("SELECT request_payload_json FROM checkout_attempts").get() as { request_payload_json: string }).request_payload_json);
    expect(attempt.snapshot).toEqual(JSON.parse(order.checkout_snapshot_json));
    expect(attempt.snapshotHash).toBe(`refref-jcs-1:${order.snapshot_hash}`);
    expect(db.prepare(`SELECT merchant_amount_kopecks,unit_amount_kopecks,legal_release_ref,legal_release_hash,
      json_extract(fiscal_item_json,'$.amountKopecks') AS fiscal_amount FROM order_lines`).get()).toEqual({
      merchant_amount_kopecks: 10_000,
      unit_amount_kopecks: 10_000,
      legal_release_ref: "stage-a-v1",
      legal_release_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      fiscal_amount: 10_000,
    });
    expect(() => db.prepare("UPDATE orders SET snapshot_hash=?").run("b".repeat(64)))
      .toThrow("ORDER_CANONICAL_SNAPSHOT_IMMUTABLE");
    expect(() => db.prepare("UPDATE order_lines SET merchant_amount_kopecks=1").run())
      .toThrow("ORDER_LINE_CANONICAL_SNAPSHOT_IMMUTABLE");
  });

  it("persists an ambiguous create and reconciles before any retry", async () => {
    const created = await checkout(db, rail, { ...input, scenario: "ambiguous_create" });
    expect(created.state).toBe("CREATE_UNKNOWN");
    const resolved = await reconcileCheckout(db, rail, created.orderPublicId);
    expect(resolved.state).toBe("PAID");
    expect(db.prepare("SELECT COUNT(*) AS count FROM course_entitlements").get()).toEqual({ count: 1 });
  });

  it("freezes LAB occurrence times into the priced line and order evidence", async () => {
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('lab-legal','LAB','lab-stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
    db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
    db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,sales_status)
      VALUES ('occurrence','lab:november','city','LAB в ноябре','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'PUBLIC')`).run();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref)
      VALUES ('lab-product','lab:november','LAB','PAID','lab:november')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('lab-offer','lab:november','lab-product',250000,'PUBLIC')`).run();

    await checkout(db, rail, {
      customerId: "customer",
      customerEmail: "student@example.com",
      offerRef: "lab:november",
      idempotencyKey: "lab-checkout",
    }, "2026-09-30T10:00:00Z");

    const snapshot = JSON.parse((db.prepare("SELECT checkout_snapshot_json FROM orders WHERE public_id<>'missing'").get() as { checkout_snapshot_json: string }).checkout_snapshot_json);
    expect(snapshot.lines[0]).toMatchObject({
      unitRef: "lab:november",
      serviceStartsAt: "2026-11-01T09:00:00Z",
      serviceEndsAt: "2026-11-01T17:00:00Z",
    });
    expect(JSON.parse((db.prepare("SELECT occurrence_snapshot_json FROM order_lines WHERE product_id='lab-product'").get() as { occurrence_snapshot_json: string }).occurrence_snapshot_json)).toEqual({
      occurrenceRef: "lab:november",
      title: "LAB в ноябре",
      startsAt: "2026-11-01T09:00:00Z",
      endsAt: "2026-11-01T17:00:00Z",
      timezone: "Asia/Novosibirsk",
      cityId: "city",
    });
    expect(db.prepare("SELECT legal_release_ref FROM order_lines WHERE product_id='lab-product'").get())
      .toEqual({ legal_release_ref: "lab-stage-a-v1" });
  });

  it.each([
    ["decline", "DECLINED"], ["customer_action", "CUSTOMER_ACTION_REQUIRED"], ["expiry", "EXPIRED"],
  ] as const)("reproduces the %s scenario", async (scenario, state) => {
    expect((await checkout(db, rail, { ...input, idempotencyKey: `checkout-${scenario}`, scenario })).state).toBe(state);
  });

  it("turns a late payment into one grant on reconciliation", async () => {
    const created = await checkout(db, rail, { ...input, scenario: "late_payment" });
    expect(created.state).toBe("PENDING");
    expect((await reconcileCheckout(db, rail, created.orderPublicId)).state).toBe("PAID");
    expect(db.prepare("SELECT COUNT(*) AS count FROM course_entitlements").get()).toEqual({ count: 1 });
  });

  it("lets the background sweep recover unfinished payment state", async () => {
    await checkout(db, rail, { ...input, idempotencyKey: "background", scenario: "late_payment" });
    expect(await reconcilePendingCheckouts(db, rail)).toEqual({ selected: 1, reconciled: 1, failed: 0 });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "FULFILLED" });
  });
});
