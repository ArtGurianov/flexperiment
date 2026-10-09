import Database from "better-sqlite3";
import { readFileSync,readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { applyV2Migration,migrateV2 } from "../src/db";
import { configureProduct,setCoursePaymentPurpose } from "../src/catalog-control";
import { buildCheckoutSnapshot,checkoutSnapshotHash } from "../src/checkout-snapshot";
import { checkout,confirmCheckout,MockPaymentRail,prepareCheckout,reconcileCheckout } from "../src/checkout";
import { validPaymentPurpose } from "../src/payment-purpose";
import { activatePublicSales,qualifyTestFiscalPolicies,testCheckoutConfig } from "./fixtures/sales";
import { stageALegalManifestJson } from "./fixtures/legal";

let db: Database.Database;
let rail: MockPaymentRail;
const input={customerId:"customer",customerEmail:"student@example.com",offerRef:"course:one",idempotencyKey:"one"};
beforeEach(()=>{
  db=new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db); rail=new MockPaymentRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('legal','COURSES','v1',?,'2026-09-30T00:00:00Z',1)").run(stageALegalManifestJson);
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','one')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','course:one','product',10000,'PUBLIC')").run();
  qualifyTestFiscalPolicies(db); activatePublicSales(db);
  db.prepare("UPDATE offers SET payment_purpose=?").run("Оплата онлайн-курса «Глайдинг»");
});

describe("catalog-owned payment purpose",()=>{
  it.each([null,""," leading","bad\u0080","\ud800","🚀".repeat(257)])("refuses invalid/missing purpose before any rail/quote/order",async value=>{
    // Store representable corruption directly; a driver replaces lone surrogates, so validate that
    // case at the public catalog command rather than pretend SQLite preserves it.
    if(value==="\ud800"){
      expect(()=>setCoursePaymentPurpose(db,{courseRef:"one",paymentPurpose:value,expectedVersion:1,actor:"owner"})).toThrow("PAYMENT_PURPOSE_REQUIRED");return;
    }
    db.prepare("UPDATE offers SET payment_purpose=?").run(value);
    const resolve=vi.spyOn(rail,"resolve"); const create=vi.spyOn(rail,"create");
    await expect(checkout(db,rail,testCheckoutConfig,input)).rejects.toThrow("PAYMENT_PURPOSE_REQUIRED");
    expect(resolve).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) n FROM checkout_quotes").get()).toEqual({n:0});
    expect(db.prepare("SELECT count(*) n FROM checkout_attempts").get()).toEqual({n:0});
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({n:0});
  });
  it("freezes exact V2 purpose independently of fiscal names, immutably across catalog edits/replay",async()=>{
    const first=await checkout(db,rail,testCheckoutConfig,input);
    const old=(db.prepare("SELECT checkout_snapshot_json,snapshot_hash FROM orders").get()) as {checkout_snapshot_json:string;snapshot_hash:string};
    const snapshot=JSON.parse(old.checkout_snapshot_json);
    expect(snapshot.schema).toBe("refref.shared-checkout-snapshot/2");
    expect(snapshot.paymentPurpose).toBe("Оплата онлайн-курса «Глайдинг»");
    expect(snapshot.paymentObligations[0].fiscal.items[0].name).not.toBe(snapshot.paymentPurpose);
    expect(checkoutSnapshotHash(snapshot)).toBe(`refref-jcs-1:${old.snapshot_hash}`);
    setCoursePaymentPurpose(db,{courseRef:"one",paymentPurpose:"Новое назначение 🚀",expectedVersion:1,actor:"payload:owner"});
    await reconcileCheckout(db,rail,first.orderPublicId);
    expect(db.prepare("SELECT checkout_snapshot_json,snapshot_hash FROM orders").get()).toEqual(old);
    expect(()=>db.prepare("UPDATE orders SET checkout_snapshot_json=?").run(JSON.stringify({...snapshot,paymentPurpose:"changed"}))).toThrow("ORDER_CANONICAL_SNAPSHOT_IMMUTABLE");
    expect(()=>db.prepare("UPDATE orders SET snapshot_hash=?").run("f".repeat(64))).toThrow("ORDER_CANONICAL_SNAPSHOT_IMMUTABLE");
    expect(()=>db.prepare("DELETE FROM order_lines").run()).toThrow("ORDER_LINE_CANONICAL_SNAPSHOT_IMMUTABLE");
  });
  it("purpose changes make a pending quote stale before provider creation",async()=>{
    const quote=await prepareCheckout(db,rail,testCheckoutConfig,{...input,previewIdempotencyKey:"preview"});
    if (!("quoteId" in quote)) throw new Error("EXPECTED_QUOTE");
    setCoursePaymentPurpose(db,{courseRef:"one",paymentPurpose:"Changed explicitly",expectedVersion:1,actor:"owner"});
    const create=vi.spyOn(rail,"create");
    await expect(confirmCheckout(db,rail,testCheckoutConfig,{...input,quoteId:quote.quoteId})).rejects.toThrow("CHECKOUT_QUOTE_STALE");
    expect(create).not.toHaveBeenCalled();
  });
  it("opening a paid offer requires explicit text, without title/fiscal defaults",()=>{
    const command={productRef:"course:two",offerRef:"course:two",kind:"ONLINE_COURSE" as const,courseRef:"two",
      accessModel:"PAID" as const,priceKopecks:10000,saleMode:"PUBLIC" as const,actor:"owner",expectedVersion:0};
    expect(()=>configureProduct(db,testCheckoutConfig,command)).toThrow("PAYMENT_PURPOSE_REQUIRED");
    expect(db.prepare("SELECT 1 FROM products WHERE product_ref='course:two'").get()).toBeUndefined();
    configureProduct(db,testCheckoutConfig,{...command,paymentPurpose:"Explicit offer purpose"});
    expect(db.prepare("SELECT payment_purpose FROM offers WHERE offer_ref='course:two'").get()).toEqual({payment_purpose:"Explicit offer purpose"});
  });
  it("CMS edit is versioned/audited and cannot change pricing or sales",()=>{
    const before=db.prepare("SELECT price_kopecks,sale_mode FROM offers").get();
    expect(setCoursePaymentPurpose(db,{courseRef:"one",paymentPurpose:"Cafe\u0301 🚀",expectedVersion:1,actor:"payload:owner"}).version).toBe(2);
    expect(db.prepare("SELECT price_kopecks,sale_mode FROM offers").get()).toEqual(before);
    expect(()=>setCoursePaymentPurpose(db,{courseRef:"one",paymentPurpose:"stale",expectedVersion:1,actor:"owner"})).toThrow("CATALOG_VERSION_CONFLICT");
    expect(db.prepare("SELECT action,actor FROM audit_log WHERE action='OFFER_PAYMENT_PURPOSE_CHANGED'").get()).toEqual({action:"OFFER_PAYMENT_PURPOSE_CHANGED",actor:"payload:owner"});
  });
  it("the order builder requires explicit order-level purpose, never joins/inherits offer names",()=>{
    const args={config:{merchantId:"merchant",fiscalizationMode:"PROVIDER" as const,taxSystem:"USN_INCOME" as const,vatCode:"NONE" as const,
      paymentMethod:"FULL_PAYMENT",paymentObject:"SERVICE" as const},merchantOrderRef:"order",paymentPurpose:"Explicit order purpose",
      line:{lineRef:"L1",offerRef:"offer",merchantOfferAmountKopecks:100,referralDiscountAmountKopecks:0,fiscalName:"Independent fiscal item"},
      referralResolutionId:"resolution",termsVersionId:null,legalReleaseRef:"legal",legalReleaseHash:"a".repeat(64)};
    const built=buildCheckoutSnapshot(args);
    expect(built.snapshot.paymentPurpose).toBe(args.paymentPurpose);
    expect(()=>buildCheckoutSnapshot({...args,paymentPurpose:undefined as unknown as string})).toThrow("PAYMENT_PURPOSE_REQUIRED");
    expect(validPaymentPurpose("🚀".repeat(256))).toBe(true); expect(validPaymentPurpose("🚀".repeat(257))).toBe(false);
  });
  it("migration0021 leaves historical orders and V1 hashes byte-identical; no offer backfill",()=>{
    const legacy=new Database(":memory:");
    const dir=join(process.cwd(),"commerce-v2/migrations");
    for(const file of readdirSync(dir).filter(file=>file.endsWith(".sql")&&file<"0021").sort()){
      applyV2Migration(legacy,file,readFileSync(join(dir,file),"utf8"));
    }
    legacy.prepare("INSERT INTO customers(id,email_normalized) VALUES ('c','c@example.test')").run();
    legacy.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:x','ONLINE_COURSE','PAID','x')").run();
    legacy.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('o','course:x','p',100,'CLOSED')").run();
    legacy.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('l','COURSES','v1',?,'2026-09-30T00:00:00Z',1)").run(stageALegalManifestJson);
    legacy.prepare("INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id) VALUES ('old','old','c','PAYMENT_PENDING',100,?,?,'l')")
      .run('{"schema":"refref.shared-checkout-snapshot/1","frozen":"historical"}',"a".repeat(64));
    const before=legacy.prepare("SELECT * FROM orders").get();
    migrateV2(legacy); expect(legacy.prepare("SELECT * FROM orders").get()).toEqual(before);
    expect(legacy.prepare("SELECT payment_purpose FROM offers").get()).toEqual({payment_purpose:null});
    expect(()=>legacy.prepare("UPDATE orders SET snapshot_hash=?").run("b".repeat(64))).toThrow("ORDER_CANONICAL_SNAPSHOT_IMMUTABLE");
    legacy.close();
  });
});
