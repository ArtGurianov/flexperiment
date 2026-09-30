import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type EntitlementGrant = {
  readonly customerId: string;
  readonly scope: "COURSE" | "ALL_COURSES";
  readonly courseRef?: string;
  readonly sourceOrderLineId: string;
};

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
