import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthRuntime } from "../src/auth";
import { bindVerifiedAuthUser, getOrCreateCustomer } from "../src/customers";
import { migrateV2 } from "../src/db";
import { customerCanAccessCourse, grantEntitlement, revokeEntitlementForOrderLine } from "../src/entitlements";
import { listCustomerOrderHistory } from "../src/library";
import { playbackResumeAt, saveResumePosition } from "../src/resume";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
});

describe("customer identity", () => {
  it("binds a verified account to an existing guest customer by normalized email", () => {
    const guest = getOrCreateCustomer(db, " Guest@Example.COM ");
    db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,?,?,1)').run("auth-user", "Guest", "guest@example.com");
    expect(bindVerifiedAuthUser(db, { id: "auth-user", email: "guest@example.com", name: "Guest" })).toBe(guest.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM customers").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT auth_user_id FROM customers WHERE id=?").get(guest.id)).toEqual({ auth_user_id: "auth-user" });
  });

  it("keeps a guest LAB purchase on the one customer after verified registration", () => {
    const guest = getOrCreateCustomer(db, " Guest@Example.COM ");
    db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','moscow','Москва')").run();
    db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity)
      VALUES ('occurrence','lab:moscow:2026-10-10','city','Практикум','2026-10-10T07:00:00Z','2026-10-10T10:00:00Z','Europe/Moscow',12)`).run();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref)
      VALUES ('lab-product','lab:moscow:2026-10-10','LAB','PAID','lab:moscow:2026-10-10')`).run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('lab-legal','LAB','lab-v1','{}','2026-09-30T00:00:00Z',1)`).run();
    db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
      VALUES ('lab-order','FX-LAB-1',?,'FULFILLED',250000,'{}',?,'lab-legal')`).run(guest.id, "a".repeat(64));
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref)
      VALUES ('lab-line','lab-order','lab-product','lab:moscow:2026-10-10','Практикум',250000,'lab-v1')`).run();
    db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,?,?,1)').run("auth-user", "Guest", "guest@example.com");

    const customerId = bindVerifiedAuthUser(db, { id: "auth-user", email: "guest@example.com", name: "Guest" });

    expect(customerId).toBe(guest.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM customers").get()).toEqual({ count: 1 });
    expect(listCustomerOrderHistory(db, customerId)).toEqual([expect.objectContaining({
      orderPublicId: "FX-LAB-1",
      state: "FULFILLED",
      productKind: "LAB",
      offerRef: "lab:moscow:2026-10-10",
    })]);
  });

  it("runs magic-link auth at /v1/auth, records consent, and binds the customer after verification", async () => {
    let link = "";
    const send = vi.fn(async ({ url }: { url: string }) => { link = url; });
    const runtime = createAuthRuntime({
      db,
      sendMagicLinkEmail: send,
      environment: {
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "a-test-secret-that-is-long-enough-for-auth",
        PUBLIC_COMMERCE_ORIGIN: "http://localhost:3002",
      },
    });
    runtime.prepareMagicLinkInitiation({
      email: "student@example.com",
      personalDataConsent: true,
      personalDataVersion: "privacy-v1",
      accountTermsVersion: "account-v1",
      marketingConsent: false,
    });
    const response = await runtime.auth.handler(new Request("http://localhost:3002/v1/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3002" },
      body: JSON.stringify({ email: "student@example.com", callbackURL: "/courses" }),
    }));
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT state FROM auth_email_outbox").get()).toEqual({ state: "SENT" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_consents").get()).toEqual({ count: 2 });

    const verify = await runtime.auth.handler(new Request(link, { headers: { origin: "http://localhost:3002" }, redirect: "manual" }));
    expect([200, 302]).toContain(verify.status);
    expect(db.prepare("SELECT auth_user_id IS NOT NULL AS bound FROM customers WHERE email_normalized='student@example.com'").get()).toEqual({ bound: 1 });
  });
});

describe("durable access grants", () => {
  const seedOrderLine = () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','c@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','v1','{}','2026-09-30T00:00:00Z',1)`).run();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
      VALUES ('order','public','customer','FULFILLED',100,'{}',?,'legal')`).run("a".repeat(64));
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref)
      VALUES ('line','order','product','course:one','One',100,'terms-v1')`).run();
  };

  it("revokes only the refunded line while another all-courses grant still grants access", () => {
    seedOrderLine();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model) VALUES ('bundle','bundle:all-courses','COURSE_BUNDLE','PAID')`).run();
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref)
      VALUES ('bundle-line','order','bundle','bundle:all-courses','All',100,'terms-v1')`).run();
    grantEntitlement(db, { customerId: "customer", scope: "COURSE", courseRef: "course-one", sourceOrderLineId: "line" });
    grantEntitlement(db, { customerId: "customer", scope: "ALL_COURSES", sourceOrderLineId: "bundle-line" });
    revokeEntitlementForOrderLine(db, "line", "REFUNDED");
    expect(customerCanAccessCourse(db, "customer", "course-one")).toBe(true);
    expect(customerCanAccessCourse(db, "customer", "future-course")).toBe(true);
  });
});

describe("resume ordering", () => {
  it("never lets an older browser update replace a newer position", () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','c@example.com')").run();
    expect(saveResumePosition(db, { customerId: "customer", lessonRef: "lesson", seconds: 90, clientSeq: 2, clientTs: "2026-09-30T10:00:02Z" }).accepted).toBe(true);
    expect(saveResumePosition(db, { customerId: "customer", lessonRef: "lesson", seconds: 30, clientSeq: 99, clientTs: "2026-09-30T10:00:01Z" }).accepted).toBe(false);
    expect(db.prepare("SELECT seconds FROM lesson_resume_positions").get()).toEqual({ seconds: 90 });
    expect(playbackResumeAt(90, 100)).toBe(0);
    expect(playbackResumeAt(60, 100)).toBe(60);
  });
});
