import Database from "better-sqlite3";
import { scryptSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { migrateV2 } from "../src/db";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { withTestStorefrontSwitch } from "./fixtures/sales";
import { enrolledTotp, testTotpKey } from "./fixtures/control-room-totp";

// FLEX-70: app.ts' notifyPublicCourseChange block. Same Control Room fixtures as app.test.ts.
const adminPassword = "correct horse battery staple";
const adminSalt = Buffer.alloc(16, 7);
const adminPasswordScrypt = ["scrypt", "v1", "16384", "8", "1", adminSalt.toString("base64url"),
  scryptSync(adminPassword, adminSalt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")].join(":");
const origin = "https://admin.flexperiment.ru";

let db: Database.Database;
let totpCode: () => string;
const freshDatabase = () => {
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db);
  totpCode = enrolledTotp(db, new Date("2026-09-30T12:00:00.000Z")).next;
};
beforeEach(freshDatabase);

type Deps = Parameters<typeof createCommerceV2App>[0];
const app = (overrides: Partial<Deps> = {}) => createCommerceV2App({
  db,
  config: withTestStorefrontSwitch(loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "open", MERCHANT_PROMOTION_PREFIX: "FX-" })),
  sourceCommit: "a".repeat(40),
  serviceToken: "test-service-token-with-enough-entropy",
  refundEnvelopeKeys: { currentKeyId: "test", keys: { test: Buffer.alloc(32, 5) } },
  now: () => new Date("2026-09-30T12:00:00.000Z"),
  controlRoomAuth: { origin, sessionSecret: "test-control-room-secret", passwordScrypt: adminPasswordScrypt, trustedProxyIps: ["127.0.0.1"], totpKey: testTotpKey },
  controlRoomPeerAddress: () => "127.0.0.1",
  ...overrides,
});

const document = { courseRef: "course", title: "Курс", slug: "course", summary: "Описание", visibility: "LISTED",
  sections: [{ sectionRef: "section", title: "Раздел", position: 0, visibility: "LISTED" }],
  lessons: [{ lessonRef: "lesson", sectionRef: "section", title: "Урок", slug: "lesson", position: 0, visibility: "LISTED", freePreview: false }] };

/** One owner session through configure → draft → publish → unlist → relist → product withdrawal. */
async function ownerSession(server: ReturnType<typeof app>) {
  const login = await server.request("/v1/admin/login", { method: "POST",
    headers: { origin, "content-type": "application/json", "x-real-ip": "203.0.113.10" },
    body: JSON.stringify({ password: adminPassword, code: totpCode() }) });
  expect(login.status).toBe(200);
  const headers = { cookie: login.headers.get("set-cookie")!, origin, "content-type": "application/json" };
  const call = async (path: string, body: unknown, method = "POST") => {
    const response = await server.request(path, { method, headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as unknown };
  };
  return [
    await call("/v1/admin/v2/catalogue/products", { productRef: "course:course", offerRef: "course:course", kind: "ONLINE_COURSE",
      courseRef: "course", accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED", expectedVersion: 0 }),
    await call("/v1/admin/v2/courses/course/draft", { document, expectedRevision: 0 }, "PUT"),
    await call("/v1/admin/v2/courses/course/publish", { expectedRevision: 1, expectedPublishedVersion: 0, idempotencyKey: "publish-1" }),
    await call("/v1/admin/v2/courses/course/unlist", { expectedPublishedVersion: 1, idempotencyKey: "unlist-1" }),
    await call("/v1/admin/v2/courses/course/relist", { expectedPublishedVersion: 2, idempotencyKey: "relist-1", reason: "Back on sale" }),
    await call("/v1/admin/v2/catalogue/products/course:course/withdraw", { reason: "Rights expired", termsRef: "offer-v1#withdrawal", expectedVersion: 1 }),
  ];
}

describe("notifyPublicCourseChange", () => {
  it("fires after publish, unlist, relist and product withdrawal, but not after a commercial edit", async () => {
    const notifyPublicCourseChange = vi.fn();
    const results = await ownerSession(app({ notifyPublicCourseChange }));
    expect(results.map(({ status }) => status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(notifyPublicCourseChange.mock.calls).toEqual([["course"], ["course"], ["course"], ["course"]]);
  });

  it("leaves every response unchanged without the dependency, or when the notifier throws", async () => {
    const baseline = await ownerSession(app());
    freshDatabase();
    const throwing = await ownerSession(app({ notifyPublicCourseChange: () => { throw new Error("notifier bug"); } }));
    expect(throwing).toEqual(baseline);
  });
});

