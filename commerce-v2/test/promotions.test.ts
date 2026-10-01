import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmCheckout, prepareCheckout, type PaymentCreateInput, type PaymentRail, type PaymentResolveInput, type RailProjection, type RailResolution } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { resolveCheckoutCode, saveMerchantPromotion } from "../src/promotions";
import { stageBLegalManifestJson } from "./fixtures/legal";

class CapturingRail implements PaymentRail {
  readonly checkoutSnapshotConfig = {
    merchantId: "00000000-0000-4000-8000-000000000001",
    fiscalizationMode: "PROVIDER" as const,
    taxSystem: "USN_INCOME" as const,
    vatCode: "NONE" as const,
    paymentMethod: "FULL_PREPAYMENT",
    paymentObject: "SERVICE" as const,
  };
  resolveInput: PaymentResolveInput | null = null;
  outcome: "NONE" | "APPLIED" | "NOT_RECOGNIZED" = "NONE";
  snapshotHash: string | undefined;

  async resolve(input: PaymentResolveInput): Promise<RailResolution> {
    this.resolveInput = input;
    return { state: "PRICE_REVIEW_REQUIRED", quote: {
      resolutionId: "resolution",
      termsVersionId: null,
      baseAmountKopecks: input.amountKopecks,
      discountKopecks: 0,
      finalAmountKopecks: input.amountKopecks,
      checkoutCodeOutcome: this.outcome,
    } };
  }

  async create(input: PaymentCreateInput): Promise<RailProjection> {
    this.snapshotHash = input.snapshotHash;
    return { attemptId: "attempt", state: "PAID", snapshotHash: input.snapshotHash };
  }

  async reconcile(): Promise<RailProjection> { return { attemptId: "attempt", state: "PAID", snapshotHash: this.snapshotHash }; }
  async acknowledgeFulfillment(): Promise<void> {}
  async refund(): Promise<RailProjection> { return { attemptId: "attempt", state: "REFUNDED" }; }
}

let db: Database.Database;
let rail: CapturingRail;
const now = "2026-09-30T10:00:00.000Z";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  rail = new CapturingRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
    VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
    VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
});

const preview = (checkoutCode: string, key = checkoutCode) => prepareCheckout(db, rail, {
  customerId: "customer",
  customerEmail: "student@example.com",
  offerRef: "course:one",
  previewIdempotencyKey: key,
  checkoutCode,
}, now, "FX-");

describe("merchant promotion namespace", () => {
  it("applies a reserved-prefix promotion before Refref and freezes the breakdown", async () => {
    saveMerchantPromotion(db, {
      id: "promotion",
      code: "fx-launch",
      discountKind: "FIXED",
      discountValue: 1_500,
      eligibleOfferRef: "course:one",
      actor: "operator",
      expectedVersion: 0,
    }, "FX-", now);

    const quote = await preview(" FX-LAUNCH ");
    expect(rail.resolveInput).toMatchObject({ amountKopecks: 8_500, checkoutCode: undefined });
    expect(quote).toMatchObject({
      baseAmountKopecks: 10_000,
      merchantDiscountKopecks: 1_500,
      referralDiscountKopecks: 0,
      discountKopecks: 1_500,
      finalAmountKopecks: 8_500,
      merchantPromotionCode: "FX-LAUNCH",
    });
    if (quote.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");
    await confirmCheckout(db, rail, {
      customerId: "customer",
      customerEmail: "student@example.com",
      quoteId: quote.quoteId,
      idempotencyKey: "payment",
    }, "2026-09-30T10:01:00.000Z");
    const frozen = JSON.parse((db.prepare("SELECT checkout_snapshot_json FROM orders").get() as { checkout_snapshot_json: string }).checkout_snapshot_json);
    expect(frozen).toMatchObject({
      schema: "refref.shared-checkout-snapshot/1",
      lines: [{ merchantOfferAmountKopecks: 8_500, referralDiscountAmountKopecks: 0, finalAmountKopecks: 8_500 }],
      totalContractAmountKopecks: 8_500,
    });
    const line = db.prepare(`SELECT catalog_amount_kopecks,merchant_discount_kopecks,merchant_amount_kopecks,
      merchant_promotion_snapshot_json FROM order_lines`).get() as {
        catalog_amount_kopecks: number; merchant_discount_kopecks: number; merchant_amount_kopecks: number;
        merchant_promotion_snapshot_json: string;
      };
    expect(line).toMatchObject({ catalog_amount_kopecks: 10_000, merchant_discount_kopecks: 1_500, merchant_amount_kopecks: 8_500 });
    expect(JSON.parse(line.merchant_promotion_snapshot_json)).toMatchObject({ id: "promotion", code: "FX-LAUNCH" });
  });

  it("passes a code outside the merchant namespace to Refref and exposes its outcome", async () => {
    rail.outcome = "NOT_RECOGNIZED";
    const quote = await preview("REF-CODE");
    expect(rail.resolveInput).toMatchObject({ amountKopecks: 10_000, checkoutCode: "REF-CODE" });
    expect(quote).toMatchObject({ checkoutCodeOutcome: "NOT_RECOGNIZED", discountKopecks: 0, finalAmountKopecks: 10_000 });
  });

  it("never leaks an unknown reserved-prefix code to Refref", async () => {
    await expect(preview("FX-UNKNOWN")).rejects.toThrow("MERCHANT_PROMOTION_NOT_RECOGNIZED");
    expect(rail.resolveInput).toBeNull();
  });

  it("binds the preview idempotency key to the entered code", async () => {
    await preview("REF-ONE", "same-preview-key");
    await expect(preview("REF-TWO", "same-preview-key")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects inactive, out-of-window and wrong-offer merchant promotions", () => {
    saveMerchantPromotion(db, { id: "inactive", code: "FX-INACTIVE", discountKind: "FIXED", discountValue: 100,
      active: false, actor: "operator", expectedVersion: 0 }, "FX-", now);
    saveMerchantPromotion(db, { id: "future", code: "FX-FUTURE", discountKind: "FIXED", discountValue: 100,
      startsAt: "2026-10-01T00:00:00.000Z", actor: "operator", expectedVersion: 0 }, "FX-", now);
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p2','course:two','ONLINE_COURSE','PAID','course-two')").run();
    db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('o2','course:two','p2',10000,'PUBLIC')").run();
    saveMerchantPromotion(db, { id: "other", code: "FX-OTHER", discountKind: "FIXED", discountValue: 100,
      eligibleOfferRef: "course:two", actor: "operator", expectedVersion: 0 }, "FX-", now);

    expect(() => resolveCheckoutCode(db, "FX-INACTIVE", "course:one", 10_000, "FX-", now)).toThrow("MERCHANT_PROMOTION_INACTIVE");
    expect(() => resolveCheckoutCode(db, "FX-FUTURE", "course:one", 10_000, "FX-", now)).toThrow("MERCHANT_PROMOTION_NOT_STARTED");
    expect(() => resolveCheckoutCode(db, "FX-OTHER", "course:one", 10_000, "FX-", now)).toThrow("MERCHANT_PROMOTION_NOT_APPLICABLE");
  });

  it("invalidates an unconfirmed quote when its promotion is disabled", async () => {
    saveMerchantPromotion(db, { id: "promotion", code: "FX-LAUNCH", discountKind: "PERCENT_BPS", discountValue: 1_000,
      actor: "operator", expectedVersion: 0 }, "FX-", now);
    const quote = await preview("FX-LAUNCH");
    db.prepare("UPDATE merchant_promotion SET active=0 WHERE id='promotion'").run();
    if (quote.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");
    await expect(confirmCheckout(db, rail, { customerId: "customer", customerEmail: "student@example.com",
      quoteId: quote.quoteId, idempotencyKey: "payment" }, "2026-09-30T10:01:00.000Z")).rejects.toThrow("CHECKOUT_QUOTE_STALE");
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
  });
});
