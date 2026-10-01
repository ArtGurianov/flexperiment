import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { auditControlRoom } from "./control-room-auth";

export type EntitlementGrant = {
  readonly customerId: string;
  readonly scope: "COURSE" | "ALL_COURSES";
  readonly courseRef?: string;
  readonly sourceOrderLineId: string;
};

export type ManualEntitlementGrant = {
  readonly customerId: string;
  readonly scope: "COURSE" | "ALL_COURSES";
  readonly courseRef?: string;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly legalTermsRef: string;
  readonly idempotencyKey: string;
  readonly actor: string;
};

const requiredText = (value: string, code: string, maximum = 240) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  if (normalized.length > maximum) throw new Error(`${code}_TOO_LONG`);
  return normalized;
};

const manualOrderPublicId = (idempotencyKey: string) =>
  `FX-MANUAL-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24).toUpperCase()}`;

export function grantEntitlement(db: Database.Database, grant: EntitlementGrant, now = new Date().toISOString()) {
  if (grant.scope === "COURSE" && !grant.courseRef) throw new Error("COURSE_REF_REQUIRED");
  if (grant.scope === "ALL_COURSES" && grant.courseRef) throw new Error("BUNDLE_COURSE_REF_FORBIDDEN");
  db.prepare(`INSERT INTO course_entitlements(id,customer_id,scope,course_ref,source_order_line_id,granted_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(source_order_line_id) DO NOTHING`)
    .run(randomUUID(), grant.customerId, grant.scope, grant.courseRef ?? null, grant.sourceOrderLineId, now);
}

export function revokeEntitlementForOrderLine(
  db: Database.Database,
  sourceOrderLineId: string,
  reason: string,
  now = new Date().toISOString(),
) {
  if (!reason.trim()) throw new Error("REVOCATION_REASON_REQUIRED");
  return db.prepare(`UPDATE course_entitlements SET revoked_at=?,revocation_reason=?
    WHERE source_order_line_id=? AND revoked_at IS NULL`).run(now, reason, sourceOrderLineId).changes;
}

export function customerCanAccessCourse(db: Database.Database, customerId: string, courseRef: string) {
  return Boolean(db.prepare(`SELECT 1 FROM course_entitlements WHERE customer_id=? AND revoked_at IS NULL
    AND (scope='ALL_COURSES' OR (scope='COURSE' AND course_ref=?)) LIMIT 1`).get(customerId, courseRef));
}

export function grantManualEntitlement(
  db: Database.Database,
  input: ManualEntitlementGrant,
  now = new Date().toISOString(),
) {
  const reason = requiredText(input.reason, "MANUAL_GRANT_REASON_REQUIRED", 1000);
  const evidenceRef = requiredText(input.evidenceRef, "MANUAL_GRANT_EVIDENCE_REQUIRED");
  const legalTermsRef = requiredText(input.legalTermsRef, "MANUAL_GRANT_TERMS_REQUIRED");
  const actor = requiredText(input.actor, "MANUAL_GRANT_ACTOR_REQUIRED");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) throw new Error("MANUAL_GRANT_IDEMPOTENCY_KEY_INVALID");
  if (input.scope === "COURSE" && !input.courseRef) throw new Error("COURSE_REF_REQUIRED");
  if (input.scope === "ALL_COURSES" && input.courseRef) throw new Error("BUNDLE_COURSE_REF_FORBIDDEN");

  const command = db.transaction(() => {
    const customer = db.prepare("SELECT id FROM customers WHERE id=?").get(input.customerId);
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
    const product = (input.scope === "COURSE"
      ? db.prepare(`SELECT id,product_ref,withdrawn_at FROM products WHERE kind='ONLINE_COURSE' AND course_ref=?`).get(input.courseRef)
      : db.prepare(`SELECT id,product_ref,withdrawn_at FROM products WHERE kind='COURSE_BUNDLE' AND product_ref='bundle:all-courses'`).get()) as {
        id: string; product_ref: string; withdrawn_at: string | null;
      } | undefined;
    if (!product) throw new Error("MANUAL_GRANT_PRODUCT_NOT_FOUND");
    if (product.withdrawn_at) throw new Error("PRODUCT_WITHDRAWN");
    const legal = db.prepare(`SELECT id FROM legal_releases WHERE storefront='COURSES' AND active=1
      ORDER BY effective_at DESC LIMIT 1`).get() as { id: string } | undefined;
    if (!legal) throw new Error("LEGAL_RELEASE_REQUIRED");

    const idempotencyKeyHash = createHash("sha256").update(input.idempotencyKey).digest("hex");
    const snapshot = {
      schema: "flexperiment.manual-entitlement/1",
      customerId: input.customerId,
      scope: input.scope,
      courseRef: input.courseRef ?? null,
      productRef: product.product_ref,
      reason,
      evidenceRef,
      legalTermsRef,
      actor,
      idempotencyKeyHash,
    } as const;
    const snapshotJson = JSON.stringify(snapshot);
    const snapshotHash = createHash("sha256").update(snapshotJson).digest("hex");
    const orderPublicId = manualOrderPublicId(input.idempotencyKey);
    const existing = db.prepare("SELECT id,customer_id,snapshot_hash FROM orders WHERE public_id=?").get(orderPublicId) as {
      id: string; customer_id: string; snapshot_hash: string;
    } | undefined;
    if (existing) {
      if (existing.customer_id !== input.customerId || existing.snapshot_hash !== snapshotHash) throw new Error("IDEMPOTENCY_KEY_REUSED");
      const entitlement = db.prepare(`SELECT entitlement.id FROM course_entitlements entitlement
        JOIN order_lines line ON line.id=entitlement.source_order_line_id WHERE line.order_id=?`).get(existing.id) as { id: string } | undefined;
      if (!entitlement) throw new Error("MANUAL_GRANT_INCOMPLETE");
      return { entitlementId: entitlement.id, orderPublicId, created: false };
    }

    const orderId = randomUUID();
    const lineId = randomUUID();
    db.prepare(`INSERT INTO orders
      (id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
      VALUES (?,?,?,'FULFILLED',0,?,?,?,?,?)`)
      .run(orderId, orderPublicId, input.customerId, snapshotJson, snapshotHash, legal.id, now, now);
    db.prepare(`INSERT INTO order_lines
      (id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,created_at)
      VALUES (?,?,?,?,?,0,?,?)`)
      .run(lineId, orderId, product.id, `manual:${product.product_ref}`, "Ручной доступ", legalTermsRef, now);
    grantEntitlement(db, {
      customerId: input.customerId,
      scope: input.scope,
      courseRef: input.courseRef,
      sourceOrderLineId: lineId,
    }, now);
    const entitlement = db.prepare("SELECT id FROM course_entitlements WHERE source_order_line_id=?").get(lineId) as { id: string };
    auditControlRoom(db, {
      adminId: actor,
      action: "ENTITLEMENT_MANUALLY_GRANTED",
      entityType: "course_entitlement",
      entityId: entitlement.id,
      details: { scope: input.scope, courseRef: input.courseRef ?? null, reason, evidenceRef, sourceOrderPublicId: orderPublicId },
    }, now);
    return { entitlementId: entitlement.id, orderPublicId, created: true };
  });
  return command.immediate();
}

export function revokeManualEntitlement(
  db: Database.Database,
  entitlementId: string,
  input: { readonly reason: string; readonly evidenceRef: string; readonly actor: string },
  now = new Date().toISOString(),
) {
  const reason = requiredText(input.reason, "MANUAL_REVOCATION_REASON_REQUIRED", 1000);
  const evidenceRef = requiredText(input.evidenceRef, "MANUAL_REVOCATION_EVIDENCE_REQUIRED");
  const actor = requiredText(input.actor, "MANUAL_REVOCATION_ACTOR_REQUIRED");
  const command = db.transaction(() => {
    const entitlement = db.prepare(`SELECT entitlement.source_order_line_id,entitlement.revoked_at,entitlement.revocation_reason,
        orders.checkout_snapshot_json FROM course_entitlements entitlement
      JOIN order_lines line ON line.id=entitlement.source_order_line_id JOIN orders ON orders.id=line.order_id
      WHERE entitlement.id=?`).get(entitlementId) as {
        source_order_line_id: string; revoked_at: string | null; revocation_reason: string | null; checkout_snapshot_json: string;
      } | undefined;
    if (!entitlement) throw new Error("ENTITLEMENT_NOT_FOUND");
    const snapshot = JSON.parse(entitlement.checkout_snapshot_json) as { schema?: string };
    if (snapshot.schema !== "flexperiment.manual-entitlement/1") throw new Error("PURCHASE_ENTITLEMENT_REQUIRES_REFUND");
    if (entitlement.revoked_at) {
      if (entitlement.revocation_reason !== reason) throw new Error("ENTITLEMENT_ALREADY_REVOKED");
      return { entitlementId, revoked: false };
    }
    revokeEntitlementForOrderLine(db, entitlement.source_order_line_id, reason, now);
    auditControlRoom(db, {
      adminId: actor,
      action: "ENTITLEMENT_MANUALLY_REVOKED",
      entityType: "course_entitlement",
      entityId: entitlementId,
      details: { reason, evidenceRef },
    }, now);
    return { entitlementId, revoked: true };
  });
  return command.immediate();
}
