import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertOfferSaleModeAllowed, type CommerceRuntimeConfig, type SaleMode, type SaleModePolicyConfig } from "./payment-mode";

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
  actor: string;
  expectedVersion: number;
};

const activeSalesActivation = (db: Database.Database, kind: ProductCommand["kind"]) => Boolean(
  db.prepare("SELECT 1 FROM sales_activation WHERE product_kind=? AND revoked_at IS NULL").get(kind),
);

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
    if (existing) {
      const update = db.prepare(`UPDATE products SET access_model=?,updated_at=?,version=version+1
        WHERE id=? AND version=?`).run(command.accessModel, now, productId, command.expectedVersion);
      if (update.changes !== 1) throw new Error("CATALOG_VERSION_CONFLICT");
    } else {
      db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref,occurrence_ref,created_at,updated_at,version)
        VALUES (?,?,?,?,?,?,?,?,1)`).run(productId, command.productRef, command.kind, command.accessModel,
          command.courseRef ?? null, command.occurrenceRef ?? null, now, now);
    }
    const offer = db.prepare("SELECT id FROM offers WHERE product_id=?").get(productId) as { id: string } | undefined;
    if (offer) {
      db.prepare(`UPDATE offers SET price_kopecks=?,sale_mode=?,acceptance_allowlist_json=?,updated_at=? WHERE id=?`)
        .run(command.priceKopecks, command.saleMode,
          JSON.stringify((command.acceptanceAllowlist ?? []).map((email) => email.trim().toLowerCase())), now, offer.id);
    } else {
      db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode,acceptance_allowlist_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), command.offerRef, productId, command.priceKopecks, command.saleMode,
          JSON.stringify((command.acceptanceAllowlist ?? []).map((email) => email.trim().toLowerCase())), now, now);
    }
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), command.actor, "PRODUCT_CONFIGURED", "PRODUCT", command.productRef,
        JSON.stringify({ accessModel: command.accessModel, priceKopecks: command.priceKopecks, saleMode: command.saleMode }), now);
  });
  apply.immediate();
  const version = (db.prepare("SELECT version FROM products WHERE product_ref=?").get(command.productRef) as { version: number }).version;
  return { productRef: command.productRef, offerRef: command.offerRef, version };
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

export function activateSales(
  db: Database.Database,
  command: { kind: ProductCommand["kind"]; evidenceIssue: string; evidenceSha256: string; actor: string },
  now = new Date().toISOString(),
) {
  if (!/^ART-\d+$/.test(command.evidenceIssue) || !/^[a-f0-9]{64}$/.test(command.evidenceSha256)) throw new Error("SALES_ACTIVATION_EVIDENCE_INVALID");
  db.prepare(`INSERT INTO sales_activation(id,product_kind,evidence_issue,evidence_sha256,activated_by,activated_at)
    VALUES (?,?,?,?,?,?)`).run(randomUUID(), command.kind, command.evidenceIssue, command.evidenceSha256, command.actor, now);
  return { kind: command.kind, activatedAt: now };
}
