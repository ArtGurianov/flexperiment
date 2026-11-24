import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { erasurePseudonym, type ErasureEntry, type ErasureKeys } from "./erasure-ledger";
import { erasurePlanRefused, type ReviewedErasurePlan } from "./erasure-plan";
import { verificationSubjectEmail } from "./my-session-storage";

type Binding = { customerId: string; email: string; userId: string | null };
type ReviewedEntry = ErasureEntry & { body: Extract<ErasureEntry["body"], { kind: "REVIEWED_ERASURE" }> };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (email: string) => email.trim().toLocaleLowerCase("en-US");

export function readReviewedBinding(db: Database.Database, customerId: string) {
  const binding = db.prepare(`SELECT c.id AS customerId,c.email_normalized AS email,u.id AS userId,u.email AS userEmail
    FROM customers c JOIN "user" u ON u.id=c.auth_user_id WHERE c.id=? AND u.email_verified=1`).get(customerId) as
    (Binding & { userId: string; userEmail: string }) | undefined;
  if (!binding || normalize(binding.userEmail) !== binding.email) return erasurePlanRefused("ERASURE_REQUEST_UNVERIFIED");
  return { customerId, email: binding.email, userId: binding.userId };
}

export function readReviewedInventory(db: Database.Database, binding: Binding) {
  const orders = db.prepare(`SELECT o.id, line.id AS lineId, p.kind, n.payment_ref AS nativeRef,
      n.state AS paymentState, a.id AS historicalAttempt, o.state AS orderState
    FROM orders o LEFT JOIN order_lines line ON line.order_id=o.id LEFT JOIN products p ON p.id=line.product_id
    LEFT JOIN native_payments n ON n.order_id=o.id LEFT JOIN checkout_attempts a ON a.order_id=o.id
    WHERE o.customer_id=? ORDER BY o.id,line.id`).all(binding.customerId) as Array<{
      id: string; lineId?: string; kind?: string; nativeRef?: string; historicalAttempt?: string; paymentState?: string; orderState: string;
    }>;
  if (orders.some(order => order.kind === "LAB") ||
    db.prepare("SELECT 1 FROM lab_guest_access WHERE customer_id=?").get(binding.customerId) ||
    db.prepare("SELECT 1 FROM lab_purchase_acceptances WHERE customer_id=?").get(binding.customerId) ||
    db.prepare("SELECT 1 FROM lab_interest_signups WHERE email_normalized=?").get(binding.email) ||
    db.prepare("SELECT 1 FROM checkout_quotes WHERE customer_id=? AND storefront='LAB'").get(binding.customerId)) {
    erasurePlanRefused("ERASURE_LAB_PROFILE_REQUIRED");
  }
  if (orders.some(order => order.kind !== "ONLINE_COURSE" || !order.nativeRef || order.historicalAttempt ||
      !["PAID", "DECLINED", "EXPIRED"].includes(order.paymentState ?? "") ||
      !["FULFILLED", "REFUND_PENDING", "REFUNDED", "EXPIRED", "CANCELLED"].includes(order.orderState))) {
    erasurePlanRefused("ERASURE_FINANCIAL_REVIEW_REQUIRED");
  }
  const rights = db.prepare(`SELECT source_order_line_id AS lineId,revoked_at AS revokedAt
    FROM course_entitlements WHERE customer_id=? ORDER BY source_order_line_id`).all(binding.customerId) as
    Array<{ lineId: string; revokedAt: string | null }>;
  const lines = new Set(orders.map(order => order.lineId));
  if (rights.some(right => !lines.has(right.lineId))) erasurePlanRefused("ERASURE_FINANCIAL_REVIEW_REQUIRED");
  const activeRights = rights.filter(right => !right.revokedAt).length;
  const openRefunds = (db.prepare(`SELECT COUNT(*) AS n FROM refund_requests
    WHERE customer_id=? AND state IN ('REQUESTED','APPROVED','EXECUTING','REVIEW_REQUIRED')`)
    .get(binding.customerId) as { n: number }).n;
  return {
    orderCount: new Set(orders.map(order => order.id)).size, activeRights, openRefunds,
    obligationsSha256: hash(["flexperiment-erasure-obligations-v1", orders.map(order => [order.id, order.lineId, order.nativeRef])]),
  };
}

function verificationIds(db: Database.Database, email: string) {
  const rows = db.prepare("SELECT id,identifier,value FROM verification").all() as Array<{ id: string; identifier: string; value: string }>;
  return rows.filter(row => {
    const address = verificationSubjectEmail(row);
    if (address === null) erasurePlanRefused("ERASURE_VERIFICATION_UNCLASSIFIED");
    return address === email;
  }).map(row => row.id);
}

/** Same technical guard at dry run, on the drained DB, and on recovery. */
export function checkReviewedTarget(db: Database.Database, binding: Binding, plan: ReviewedErasurePlan, replay = false) {
  const inventory = readReviewedInventory(db, binding);
  const obligationOpen = inventory.activeRights > 0 || inventory.openRefunds > 0;
  if ((!replay || obligationOpen) && plan.obligationsSha256 !== inventory.obligationsSha256) {
    erasurePlanRefused("ERASURE_PLAN_OBLIGATIONS_CHANGED");
  }
  if (obligationOpen && plan.categories.account.action !== "CLOSE_WITH_CONTINUITY") {
    erasurePlanRefused("ERASURE_ACCESS_CONTINUITY_REQUIRED");
  }
  if (binding.userId) {
    const crossed = db.prepare(`SELECT 1 FROM authenticated_consent_actions WHERE auth_user_id=@userId AND customer_id<>@customerId
      UNION ALL SELECT 1 FROM account_consents WHERE confirmed_auth_user_id=@userId AND customer_id<>@customerId
      UNION ALL SELECT 1 FROM marketing_consents WHERE confirmed_auth_user_id=@userId AND customer_id<>@customerId
      UNION ALL SELECT 1 FROM lms_sessions l JOIN "session" s ON s.id=l.parent_session_id
        WHERE s.user_id=@userId AND l.customer_id<>@customerId
      UNION ALL SELECT 1 FROM session_exchanges e JOIN "session" s ON s.id=e.my_session_id
        WHERE s.user_id=@userId AND e.customer_id<>@customerId LIMIT 1`).get(binding);
    if (crossed) erasurePlanRefused("ERASURE_SUBJECT_BINDING_DRIFT");
  }
  return { inventory, verification: verificationIds(db, binding.email) };
}

export function reviewedReceipt(db: Database.Database, entry: ReviewedEntry) {
  const receipt = db.prepare(`SELECT entry_sha256,recorded_at,application_mode,counts_json FROM reviewed_erasure_receipts WHERE request_id=?`)
    .get(entry.body.requestId) as { entry_sha256: string; recorded_at: string; application_mode: "LIVE" | "RESTORE"; counts_json: string } | undefined;
  if (receipt && receipt.entry_sha256 !== entry.hash) erasurePlanRefused("ERASURE_RECEIPT_CONFLICT");
  return receipt && { recordedAt: receipt.recorded_at, applicationMode: receipt.application_mode,
    counts: JSON.parse(receipt.counts_json) as Record<string, number> };
}

export function applyReviewedErasure(db: Database.Database, entry: ReviewedEntry, keys: ErasureKeys, now: Date, restoring: boolean) {
  const { subject, scope, reviewed } = entry.body;
  const matches = (kind: "customer" | "user" | "email", value: string) =>
    erasurePseudonym(keys, subject.keyId, scope, kind, value) === subject[kind];
  const customers = db.prepare(`SELECT id AS customerId,email_normalized AS email,auth_user_id AS userId FROM customers`).all() as Binding[];
  const binding = customers.find(row => matches("customer", row.customerId));
  const users = db.prepare('SELECT id,email FROM "user"').all() as Array<{ id: string; email: string }>;
  const user = users.find(row => matches("user", row.id));
  const receipt = reviewedReceipt(db, entry);
  if (!binding) {
    if (user || customers.some(row => matches("email", row.email)) || users.some(row => matches("email", row.email))) {
      erasurePlanRefused("ERASURE_SUBJECT_BINDING_DRIFT");
    }
    // A snapshot may predate the subject. Preserve the independent tombstone.
    // There is no subject-local execution record to write in that snapshot.
    return;
  }
  if (!matches("email", binding.email) || (binding.userId !== null && (!user || binding.userId !== user.id)) ||
    (user && (!matches("email", user.email) || binding.userId !== user.id)) ||
    users.some(row => matches("email", row.email) && row.id !== binding.userId)) {
    erasurePlanRefused("ERASURE_SUBJECT_BINDING_DRIFT");
  }

  const { verification } = checkReviewedTarget(db, binding, reviewed.plan, true);
  const counts: Record<string, number> = {};
  const remove = (table: string, column: string, id: string) => {
    counts[table] = db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(id).changes;
  };
  counts.verification = verification.reduce((count, id) =>
    count + db.prepare("DELETE FROM verification WHERE id=?").run(id).changes, 0);
  for (const table of ["auth_email_outbox", "my_otp_outbox"]) remove(table, "recipient_normalized", binding.email);
  // Count rows before removal, including changes effected by FK cascades.
  for (const [table, where, id] of [
    ["lms_sessions", "customer_id=?", binding.customerId],
    ["session_exchanges", "customer_id=?", binding.customerId],
    ["session", "user_id=?", binding.userId],
    ["account", "user_id=?", binding.userId],
    ["authenticated_consent_events", "action_id IN (SELECT id FROM authenticated_consent_actions WHERE customer_id=?)", binding.customerId],
  ] as const) {
    counts[table] = (db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`).get(id) as { n: number }).n;
  }
  db.prepare("DELETE FROM session_exchanges WHERE customer_id=?").run(binding.customerId);
  db.prepare("DELETE FROM lms_sessions WHERE customer_id=?").run(binding.customerId);
  remove("browser_contexts", "bound_customer_id", binding.customerId);
  for (const table of ["authenticated_consent_actions", "account_consents", "marketing_consents", "notification_campaign_recipients"]) {
    remove(table, "customer_id", binding.customerId);
  }
  if (reviewed.plan.categories.freeLearning.action === "DELETE") {
    for (const table of ["course_learning_starts", "free_course_enrollments"]) remove(table, "customer_id", binding.customerId);
  }
  if (reviewed.plan.categories.progress.action === "DELETE") {
    for (const table of ["lesson_resume_positions", "playback_grant_rate_limits", "playback_access_events"]) remove(table, "customer_id", binding.customerId);
  }
  counts.customerProfileCleared = db.prepare(`UPDATE customers SET display_name=NULL,auth_user_id=NULL
    WHERE id=? AND (display_name IS NOT NULL OR auth_user_id IS NOT NULL)`).run(binding.customerId).changes;
  counts.user = db.prepare('DELETE FROM "user" WHERE id=?').run(binding.userId).changes;
  counts.email_suppressions = db.prepare(`INSERT INTO email_suppressions(email_normalized,reason,created_at,removed_at)
    VALUES (?,'INDEPENDENT_ERASURE_LEDGER',?,NULL) ON CONFLICT(email_normalized) DO UPDATE
    SET reason=excluded.reason,created_at=excluded.created_at,removed_at=NULL WHERE email_suppressions.removed_at IS NOT NULL`)
    .run(binding.email, entry.body.recordedAt).changes;

  if (!receipt) {
    db.prepare("INSERT INTO reviewed_erasure_receipts VALUES (?,?,?,?,?)").run(
      entry.body.requestId, entry.hash, now.toISOString(), restoring ? "RESTORE" : "LIVE", JSON.stringify(counts));
  }
}
