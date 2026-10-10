import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertOfferSaleModeAllowed, type CommerceRuntimeConfig, type SaleMode, type SaleModePolicyConfig } from "./payment-mode";
import { validPaymentPurpose } from "./payment-purpose";

export type ProductCommand = {
  productRef: string;
  offerRef: string;
  kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
  accessModel: "FREE" | "PAID";
  courseRef?: string;
  occurrenceRef?: string;
  priceKopecks: number;
  saleMode: SaleMode;
  acceptanceAllowlist?: string[];
  paymentPurpose?: string | null;
  actor: string;
  expectedVersion: number;
};

/**
 * An activation counts only while its evidence still qualifies its kind. A row that predates a
 * narrowing (a COURSE_BUNDLE activation on ART-240) authorizes nothing, revoked or not.
 */
const activeSalesActivation = (db: Database.Database, kind: ProductCommand["kind"]) => {
  const evidenceIssue = salesActivationEvidenceIssue[kind];
  return evidenceIssue !== undefined && Boolean(db.prepare(
    "SELECT 1 FROM sales_activation WHERE product_kind=? AND evidence_issue=? AND revoked_at IS NULL").get(kind, evidenceIssue));
};

/**
 * The one sale-mode gate. Control Room writes and every checkout step evaluate it against the live
 * payment mode and the current activation row, so a PUBLIC offer stops selling the moment its
 * activation is revoked even though the stored sale mode still says PUBLIC.
 */
export function assertLiveOfferSaleMode(
  db: Database.Database,
  config: SaleModePolicyConfig,
  offer: Pick<ProductCommand, "kind" | "accessModel" | "saleMode">,
) {
  assertOfferSaleModeAllowed(config, offer, activeSalesActivation(db, offer.kind));
}

export function configureProduct(db: Database.Database, config: CommerceRuntimeConfig, command: ProductCommand, now = new Date().toISOString()) {
  if (!command.productRef || !command.offerRef || !command.actor || !Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) throw new Error("PRODUCT_COMMAND_INVALID");
  if (!Number.isInteger(command.priceKopecks) || command.priceKopecks < 0) throw new Error("PRICE_INVALID");
  if (command.kind === "ONLINE_COURSE" && !command.courseRef) throw new Error("COURSE_REF_REQUIRED");
  if (command.kind !== "ONLINE_COURSE" && command.courseRef) throw new Error("COURSE_REF_FORBIDDEN");
  if (command.kind === "COURSE_BUNDLE" && command.productRef !== "bundle:all-courses") throw new Error("ALL_COURSES_BUNDLE_REF_INVALID");
  if (command.kind === "LAB" && !command.occurrenceRef) throw new Error("OCCURRENCE_REF_REQUIRED");
  if (command.kind !== "LAB" && command.occurrenceRef) throw new Error("OCCURRENCE_REF_FORBIDDEN");
  if (command.occurrenceRef && !db.prepare("SELECT 1 FROM lab_occurrences WHERE occurrence_ref=?").get(command.occurrenceRef)) {
    throw new Error("LAB_OCCURRENCE_NOT_FOUND");
  }
  assertLiveOfferSaleMode(db, config, command);
  const apply = db.transaction(() => {
    const existing = db.prepare(`SELECT product.id,product.withdrawn_at,product.version,product.kind,product.course_ref,
      product.occurrence_ref,offer.offer_ref FROM products product LEFT JOIN offers offer ON offer.product_id=product.id
      WHERE product.product_ref=?`).get(command.productRef) as {
        id: string; withdrawn_at: string | null; version: number;
        kind: ProductCommand["kind"]; course_ref: string | null; occurrence_ref: string | null; offer_ref: string | null;
      } | undefined;
    if (existing?.withdrawn_at) throw new Error("WITHDRAWN_PRODUCT_IMMUTABLE");
    if ((!existing && command.expectedVersion !== 0) || (existing && existing.version !== command.expectedVersion)) throw new Error("CATALOG_VERSION_CONFLICT");
    // Orders, entitlements and payment snapshots point at what a product is; only its terms may change.
    if (existing && (existing.kind !== command.kind || existing.course_ref !== (command.courseRef ?? null)
      || existing.occurrence_ref !== (command.occurrenceRef ?? null)
      || (existing.offer_ref !== null && existing.offer_ref !== command.offerRef))) throw new Error("PRODUCT_IDENTITY_IMMUTABLE");
    const productId = existing?.id ?? randomUUID();
    const priorOffer = db.prepare("SELECT id,payment_purpose FROM offers WHERE product_id=?").get(productId) as
      { id: string; payment_purpose: string | null } | undefined;
    const paymentPurpose = command.paymentPurpose === undefined ? priorOffer?.payment_purpose ?? null : command.paymentPurpose;
    if ((paymentPurpose !== null && !validPaymentPurpose(paymentPurpose))
      || (command.accessModel === "PAID" && command.saleMode !== "CLOSED" && !validPaymentPurpose(paymentPurpose))) {
      throw new Error("PAYMENT_PURPOSE_REQUIRED");
    }
    if (existing) {
      const update = db.prepare(`UPDATE products SET access_model=?,updated_at=?,version=version+1
        WHERE id=? AND version=?`).run(command.accessModel, now, productId, command.expectedVersion);
      if (update.changes !== 1) throw new Error("CATALOG_VERSION_CONFLICT");
    } else {
      db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref,occurrence_ref,created_at,updated_at,version)
        VALUES (?,?,?,?,?,?,?,?,1)`).run(productId, command.productRef, command.kind, command.accessModel,
          command.courseRef ?? null, command.occurrenceRef ?? null, now, now);
    }
    const offer = priorOffer;
    if (offer) {
      db.prepare(`UPDATE offers SET price_kopecks=?,sale_mode=?,acceptance_allowlist_json=?,updated_at=?,payment_purpose=? WHERE id=?`)
        .run(command.priceKopecks, command.saleMode,
          JSON.stringify((command.acceptanceAllowlist ?? []).map((email) => email.trim().toLowerCase())), now, paymentPurpose, offer.id);
    } else {
      db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode,acceptance_allowlist_json,created_at,updated_at,payment_purpose)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(), command.offerRef, productId, command.priceKopecks, command.saleMode,
          JSON.stringify((command.acceptanceAllowlist ?? []).map((email) => email.trim().toLowerCase())), now, now, paymentPurpose);
    }
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), command.actor, "PRODUCT_CONFIGURED", "PRODUCT", command.productRef,
        JSON.stringify({ accessModel: command.accessModel, priceKopecks: command.priceKopecks, saleMode: command.saleMode, paymentPurpose }), now);
  });
  apply.immediate();
  const version = (db.prepare("SELECT version FROM products WHERE product_ref=?").get(command.productRef) as { version: number }).version;
  return { productRef: command.productRef, offerRef: command.offerRef, version };
}

/** Payload edits only this commerce-owned field, never price/sales/identity through this command. */
export function setCoursePaymentPurpose(db: Database.Database, command: {
  courseRef: string; paymentPurpose: string; expectedVersion: number; actor: string;
}, now = new Date().toISOString()) {
  if (!command.courseRef || !command.actor || !Number.isInteger(command.expectedVersion)
    || !validPaymentPurpose(command.paymentPurpose)) throw new Error("PAYMENT_PURPOSE_REQUIRED");
  return db.transaction(() => {
    const product = db.prepare(`SELECT p.id,p.product_ref,p.version,p.withdrawn_at,o.id AS offer_id
      FROM products p JOIN offers o ON o.product_id=p.id WHERE p.kind='ONLINE_COURSE' AND p.course_ref=?`)
      .get(command.courseRef) as { id: string; product_ref: string; version: number; withdrawn_at: string | null; offer_id: string } | undefined;
    if (!product) throw new Error("OFFER_NOT_AVAILABLE");
    if (product.withdrawn_at) throw new Error("WITHDRAWN_PRODUCT_IMMUTABLE");
    if (product.version !== command.expectedVersion) throw new Error("CATALOG_VERSION_CONFLICT");
    db.prepare("UPDATE products SET version=version+1,updated_at=? WHERE id=? AND version=?").run(now,product.id,command.expectedVersion);
    db.prepare("UPDATE offers SET payment_purpose=?,updated_at=? WHERE id=?").run(command.paymentPurpose,now,product.offer_id);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(),command.actor,"OFFER_PAYMENT_PURPOSE_CHANGED","PRODUCT",product.product_ref,
        JSON.stringify({ paymentPurpose: command.paymentPurpose, version: product.version+1 }),now);
    return { paymentPurpose: command.paymentPurpose, version: product.version+1 };
  }).immediate();
}

export function withdrawProduct(
  db: Database.Database,
  command: { productRef: string; reason: string; termsRef: string; actor: string; expectedVersion: number },
  now = new Date().toISOString(),
) {
  if (!command.reason.trim() || !command.termsRef.trim() || !command.actor.trim()) throw new Error("WITHDRAWAL_EVIDENCE_REQUIRED");
  const apply = db.transaction(() => {
    const result = db.prepare(`UPDATE products SET withdrawn_at=?,withdrawn_reason=?,withdrawn_terms_ref=?,updated_at=?,version=version+1
      WHERE product_ref=? AND withdrawn_at IS NULL AND version=?`).run(now, command.reason.trim(), command.termsRef.trim(), now, command.productRef, command.expectedVersion);
    if (result.changes !== 1) {
      const current = db.prepare("SELECT version,withdrawn_at FROM products WHERE product_ref=?").get(command.productRef) as { version: number; withdrawn_at: string | null } | undefined;
      if (current && !current.withdrawn_at && current.version !== command.expectedVersion) throw new Error("CATALOG_VERSION_CONFLICT");
      throw new Error("PRODUCT_NOT_WITHDRAWABLE");
    }
    db.prepare("UPDATE offers SET sale_mode='CLOSED',updated_at=? WHERE product_id=(SELECT id FROM products WHERE product_ref=?)")
      .run(now, command.productRef);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), command.actor, "PRODUCT_WITHDRAWN", "PRODUCT", command.productRef,
        JSON.stringify({ reason: command.reason.trim(), termsRef: command.termsRef.trim() }), now);
  });
  apply.immediate();
  const version = (db.prepare("SELECT version FROM products WHERE product_ref=?").get(command.productRef) as { version: number }).version;
  return { productRef: command.productRef, withdrawnAt: now, version };
}

/**
 * The acceptance run whose evidence may open public sales for each product kind. ART-240 qualifies
 * one ONLINE_COURSE, never COURSE_BUNDLE: a bundle has no acceptance yet, so nothing opens it
 * (migration 0016 holds the same rule).
 */
export const salesActivationEvidenceIssue: Readonly<Partial<Record<ProductCommand["kind"], string>>> = {
  ONLINE_COURSE: "ART-240",
  LAB: "ART-243",
};

export function activateSales(
  db: Database.Database,
  command: { kind: ProductCommand["kind"]; evidenceIssue: string; evidenceSha256: string; actor: string },
  now = new Date().toISOString(),
) {
  if (!["ONLINE_COURSE", "COURSE_BUNDLE", "LAB"].includes(command.kind)) throw new Error("SALES_ACTIVATION_KIND_INVALID");
  if (!Object.hasOwn(salesActivationEvidenceIssue, command.kind)) throw new Error("SALES_ACTIVATION_NOT_QUALIFIED");
  if (command.evidenceIssue !== salesActivationEvidenceIssue[command.kind] || !/^[a-f0-9]{64}$/.test(command.evidenceSha256)
    || !command.actor?.trim()) throw new Error("SALES_ACTIVATION_EVIDENCE_INVALID");
  db.prepare(`INSERT INTO sales_activation(id,product_kind,evidence_issue,evidence_sha256,activated_by,activated_at)
    VALUES (?,?,?,?,?,?)`).run(randomUUID(), command.kind, command.evidenceIssue, command.evidenceSha256, command.actor, now);
  return { kind: command.kind, activatedAt: now };
}
