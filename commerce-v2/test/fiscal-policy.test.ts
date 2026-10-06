import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmCheckout, MockPaymentRail, prepareCheckout } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { draftFiscalPolicy, qualifiedFiscalPolicy, qualifyFiscalPolicy, retireFiscalPolicy } from "../src/fiscal-policy";
import { legalManifestHash } from "../src/legal-control";
import { stageALegalManifestJson } from "./fixtures/legal";
import { activatePublicSales, testCheckoutConfig } from "./fixtures/sales";

let db: Database.Database;
let rail: MockPaymentRail;
const T0 = "2026-09-30T10:00:00Z";
const basis = { offerTermsRef: "offer-v3#refunds (ART-231)", counselRef: "counsel-2026-10 (ART-234)", evidenceSha256: "e".repeat(64) };
const semantics = { taxSystem: "USN_INCOME", vatCode: "NONE", paymentMethod: "FULL_PREPAYMENT", paymentObject: "SERVICE" } as const;
const draft = (offerRef: string, kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB", itemName: string, paymentMethod: "FULL_PREPAYMENT" | "ADVANCE" = "FULL_PREPAYMENT") =>
  draftFiscalPolicy(db, { offerRef, kind, itemName, ...semantics, paymentMethod, actor: "owner" }, T0).policyId;
const qualify = (policyId: string) => qualifyFiscalPolicy(db, { policyId, actor: "owner", legalBasis: basis }, T0);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  rail = new MockPaymentRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model) VALUES ('bundle','bundle:all-courses','COURSE_BUNDLE','PAID')`).run();
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('bundle-offer','bundle:all-courses','bundle',50000,'CLOSED')`).run();
  activatePublicSales(db);
});

const input = { customerId: "customer", customerEmail: "student@example.com", offerRef: "course:one", idempotencyKey: "checkout-one" };
const preview = (key: string) => prepareCheckout(db, rail, testCheckoutConfig, { ...input, previewIdempotencyKey: key }, T0);
const confirm = (quoteId: string, idempotencyKey = input.idempotencyKey) => confirmCheckout(db, rail, testCheckoutConfig, {
  customerId: input.customerId, customerEmail: input.customerEmail, quoteId, idempotencyKey,
}, "2026-09-30T10:01:00Z");
const orderLine = () => db.prepare("SELECT fiscal_item_json,fiscal_policy_id,legal_release_hash FROM order_lines").get() as
  { fiscal_item_json: string; fiscal_policy_id: string; legal_release_hash: string };

describe("product-specific fiscal authority (ART-233)", () => {
  it("a paid offer sells only under a QUALIFIED policy: no policy and a DRAFT both refuse before any quote", async () => {
    await expect(preview("none")).rejects.toThrow("FISCAL_POLICY_NOT_QUALIFIED");
    draft("course:one", "ONLINE_COURSE", "Онлайн-курс «Первый»");
    await expect(preview("draft")).rejects.toThrow("FISCAL_POLICY_NOT_QUALIFIED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM checkout_quotes").get()).toEqual({ count: 0 });
  });

  it("the receipt says what the policy says — not the product ref or the CMS — and the order line keeps which policy, outside the legal hash", async () => {
    const policyId = draft("course:one", "ONLINE_COURSE", "Онлайн-курс «Первый»");
    qualify(policyId);
    const prepared = await preview("one");
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");
    await confirm(prepared.quoteId);
    const line = orderLine();
    expect(JSON.parse(line.fiscal_item_json)).toMatchObject({ name: "Онлайн-курс «Первый»", paymentMethod: "FULL_PREPAYMENT", vatCode: "NONE", paymentObject: "SERVICE" });
    expect(line.fiscal_policy_id).toBe(policyId);
    const snapshot = JSON.parse((db.prepare("SELECT checkout_snapshot_json AS s FROM orders").get() as { s: string }).s);
    expect(snapshot.paymentObligations[0].fiscal.taxSystem).toBe("USN_INCOME");
    expect(JSON.stringify(snapshot)).not.toContain(policyId);
    expect(line.legal_release_hash).toBe(legalManifestHash(JSON.parse(stageALegalManifestJson)));
  });

  it("a policy changed after the quote makes it stale; an order already made keeps the receipt it froze", async () => {
    const v1 = draft("course:one", "ONLINE_COURSE", "Курс v1");
    qualify(v1);
    const first = await preview("first");
    if (first.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");
    await confirm(first.quoteId);
    const frozen = orderLine().fiscal_item_json;

    // Another customer's quote, priced under v1 and confirmed after v2 is qualified.
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('second','second@example.com')").run();
    const second = { customerId: "second", customerEmail: "second@example.com" };
    const pending = await prepareCheckout(db, rail, testCheckoutConfig, { ...input, ...second, previewIdempotencyKey: "pending" }, T0);
    if (pending.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");
    const v2 = draft("course:one", "ONLINE_COURSE", "Курс v2", "ADVANCE");
    qualify(v2);
    await expect(confirmCheckout(db, rail, testCheckoutConfig, { ...second, quoteId: pending.quoteId, idempotencyKey: "checkout-two" },
      "2026-09-30T10:01:00Z")).rejects.toThrow("CHECKOUT_QUOTE_STALE");
    expect(db.prepare("SELECT fiscal_item_json AS f FROM order_lines").all()).toEqual([{ f: frozen }]);
    expect(db.prepare("SELECT status FROM fiscal_policy_versions ORDER BY version").all()).toEqual([{ status: "RETIRED" }, { status: "QUALIFIED" }]);
  });

  it("an ONLINE_COURSE qualification qualifies nothing else: not the bundle, not a LAB, not an unpublished offer", () => {
    qualify(draft("course:one", "ONLINE_COURSE", "Курс"));
    expect(() => qualifiedFiscalPolicy(db, "bundle:all-courses", "COURSE_BUNDLE")).toThrow("FISCAL_POLICY_NOT_QUALIFIED");
    // A policy claiming another kind for the course offer, and one for an offer no release published.
    expect(() => qualify(draft("course:one", "LAB", "Мастер-класс"))).toThrow("FISCAL_POLICY_OFFER_MISMATCH");
    expect(() => qualify(draft("course:unknown", "ONLINE_COURSE", "Курс"))).toThrow("FISCAL_POLICY_OFFER_MISMATCH");
    expect(() => qualifiedFiscalPolicy(db, "course:one", "LAB")).toThrow("FISCAL_POLICY_NOT_QUALIFIED");
  });

  it("qualification needs its legal basis, and is final", () => {
    const policyId = draft("course:one", "ONLINE_COURSE", "Курс");
    for (const legalBasis of [{ ...basis, offerTermsRef: " " }, { ...basis, counselRef: "" }, { ...basis, evidenceSha256: "short" }]) {
      expect(() => qualifyFiscalPolicy(db, { policyId, actor: "owner", legalBasis }, T0)).toThrow("FISCAL_POLICY_LEGAL_BASIS_REQUIRED");
    }
    qualify(policyId);
    expect(() => qualify(policyId)).toThrow("FISCAL_POLICY_TRANSITION_INVALID");
    retireFiscalPolicy(db, { policyId, actor: "owner" }, T0);
    expect(() => qualify(policyId)).toThrow("FISCAL_POLICY_TRANSITION_INVALID");
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE subject_type='FISCAL_POLICY'").get()).toEqual({ count: 3 });
  });

  it("the table holds the rules whoever writes: born a draft, content immutable, transitions closed, never deleted", () => {
    const policyId = draft("course:one", "ONLINE_COURSE", "Курс");
    expect(() => db.prepare(`INSERT INTO fiscal_policy_versions(id,offer_ref,product_kind,version,item_name,tax_system,vat_code,
      payment_method,payment_object,status,legal_basis_json,qualified_by,qualified_at,created_by,created_at)
      VALUES ('direct','course:one','ONLINE_COURSE',9,'Курс','USN_INCOME','NONE','FULL_PREPAYMENT','SERVICE','QUALIFIED','{}','x',?, 'x',?)`).run(T0, T0))
      .toThrow("FISCAL_POLICY_BORN_DRAFT");
    expect(() => db.prepare("INSERT INTO fiscal_policy_versions(id,offer_ref,product_kind,version,item_name,tax_system,vat_code,payment_method,payment_object,created_by,created_at) VALUES ('bad','course:one','ONLINE_COURSE',9,'Курс','USN_INCOME','NONE','full_prepayment','SERVICE','x',?)").run(T0))
      .toThrow(/CHECK constraint failed/);
    expect(() => db.prepare("UPDATE fiscal_policy_versions SET item_name='Другое' WHERE id=?").run(policyId)).toThrow("FISCAL_POLICY_IMMUTABLE");
    qualify(policyId);
    expect(() => db.prepare("UPDATE fiscal_policy_versions SET status='DRAFT',legal_basis_json=NULL,qualified_by=NULL,qualified_at=NULL WHERE id=?").run(policyId))
      .toThrow("FISCAL_POLICY_TRANSITION_INVALID");
    expect(() => db.prepare("UPDATE fiscal_policy_versions SET legal_basis_json='{}' WHERE id=?").run(policyId)).toThrow("FISCAL_POLICY_TRANSITION_INVALID");
    expect(() => db.prepare("DELETE FROM fiscal_policy_versions WHERE id=?").run(policyId)).toThrow("FISCAL_POLICY_APPEND_ONLY");
    // Two qualified for one offer cannot exist, even written directly.
    const second = draft("course:one", "ONLINE_COURSE", "Курс 2");
    expect(() => db.prepare(`UPDATE fiscal_policy_versions SET status='QUALIFIED',legal_basis_json='{}',qualified_by='x',qualified_at=? WHERE id=?`).run(T0, second))
      .toThrow(/UNIQUE constraint failed/);
  });
});
