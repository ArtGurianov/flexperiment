import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { migrateV2 } from "../src/db";
import { applyV2Seed } from "../src/seed";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");migrateV2(db);
  applyV2Seed(db, {
    cities: [{ slug: "fixture-city", title: "Isolated fixture city" }],
    labOccurrences: [{ occurrenceRef: "fixture-event", citySlug: "fixture-city", title: "Isolated fixture event", startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-01T12:00:00Z", timezone: "Europe/Moscow", capacity: 7 }],
    products: [{ productRef: "lab:fixture-event", occurrenceRef: "fixture-event", kind: "LAB", accessModel: "PAID", offerRef: "lab:fixture-event", priceKopecks: 12345, saleMode: "CLOSED" }],
  });
});
afterEach(() => db.close());
const server = () => createCommerceV2App({ db, config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "disabled" }), sourceCommit: "a".repeat(40), serviceToken: "isolated-fixture", now: () => new Date("2026-10-11T00:00:00Z") });
const publish = () => {
  db.prepare("UPDATE lab_occurrences SET sales_status='PUBLIC'").run();
  db.prepare("UPDATE offers SET sale_mode='PUBLIC', acceptance_allowlist_json='[\"secret-fixture-owner@example.invalid\"]'").run();
};

describe("LAB V2 public read model", () => {
  it("returns actual cities but never invents or exposes a CLOSED occurrence", async () => {
    const response = await server().request("/v1/lab/catalogue");
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ schema: "flexperiment.lab-catalogue/1", paymentMode: "disabled", cities: [{ title: "Isolated fixture city" }], occurrences: [] });
  });
  it("projects exact published facts without PII, allowlists, internal IDs or guessed availability", async () => {
    publish();const before = db.prepare("SELECT total_changes() AS changes").get();
    const response = await server().request("/v1/lab/catalogue");const body = await response.json();
    expect(body.occurrences).toEqual([{ occurrenceRef: "fixture-event", offerRef: "lab:fixture-event", cityId: body.cities[0].cityId, title: "Isolated fixture event", startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-01T12:00:00Z", timezone: "Europe/Moscow", amountKopecks: 12345, currency: "RUB" }]);
    expect(JSON.stringify(body)).not.toMatch(/secret-fixture|allowlist|capacity|checkoutEnabled/);
    expect(db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    expect((await server().request("/v1/checkout", { method: "POST" })).status).toBe(503);
  });
  it.each(["ACCEPTANCE_ONLY", "CLOSED"])("does not expose %s offers", async (mode) => {
    publish();db.prepare("UPDATE offers SET sale_mode=?").run(mode);
    expect((await (await server().request("/v1/lab/catalogue")).json()).occurrences).toEqual([]);
  });
  it("refuses ended or withdrawn products independently of publication", async () => {
    publish();db.prepare("UPDATE lab_occurrences SET starts_at='2026-10-01T10:00:00Z',ends_at='2026-10-01T12:00:00Z'").run();
    expect((await (await server().request("/v1/lab/catalogue")).json()).occurrences).toEqual([]);
    db.prepare("UPDATE lab_occurrences SET ends_at='2026-11-01T12:00:00Z'").run();
    db.prepare("UPDATE products SET withdrawn_at='2026-10-10',withdrawn_reason='fixture',withdrawn_terms_ref='fixture-terms'").run();
    expect((await (await server().request("/v1/lab/catalogue")).json()).occurrences).toEqual([]);
  });
  it("keeps legacy public and customer-owned endpoints protected", async () => {
    expect((await server().request("/v1/public/tour")).status).toBe(404);
    expect((await server().request("/v1/me/orders")).status).toBe(401);
  });
  it("fails closed on invalid published facts without returning raw validation diagnostics", async () => {
    publish();db.prepare("UPDATE lab_occurrences SET timezone='invalid-fixture-timezone'").run();
    const response = await server().request("/v1/lab/catalogue");
    expect(response.status).toBe(503);expect(await response.json()).toEqual({ code: "LAB_CATALOGUE_UNAVAILABLE" });
  });
});
