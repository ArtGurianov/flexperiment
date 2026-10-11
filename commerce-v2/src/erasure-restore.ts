import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { classifyV2Database } from "./db";
import { assertErasureSubjectKey, erasurePseudonym, ErasureLedgerError, VerifiedErasureLedger, type ErasureKeys } from "./erasure-ledger";

// Reviewed schema 0001–0025, including triggers, views, columns, indexes and FKs.
// A new migration/DDL must explicitly requalify erasure coverage. Deriving this
// expected value from the restored DB would silently admit its unclassified data.
const REVIEWED_SCHEMA_SHA256 = "158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030";
function assertReviewedSchema(db: Database.Database) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  if (createHash("sha256").update(JSON.stringify(schema)).digest("hex") !== REVIEWED_SCHEMA_SHA256) {
    throw new ErasureLedgerError("ERASURE_RESTORE_UNCLASSIFIED_SCHEMA");
  }
}

/** Isolated restore ONLY. No HTTP endpoint, runtime activation or mail/provider call.
 * Must run before any traffic/jobs/email, with a genuinely independent fresh ledger.
 * Merchant schema stays unchanged; financial/audit uncertainty keeps restore CLOSED. */
export function applyIsolatedRestoreErasure(db: Database.Database, ledger: VerifiedErasureLedger, keys: ErasureKeys,
  environment: "canary" | "production", now = new Date()) {
  ledger.assertFresh(now);
  if (ledger.bundle.scope !== environment) throw new ErasureLedgerError("ERASURE_SCOPE_MISMATCH");
  if (classifyV2Database(db) !== "SUPPORTED" || db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new ErasureLedgerError("ERASURE_RESTORE_SCHEMA_REFUSED");
  }
  // SQLite row deletion is not destruction of old WAL/free pages or ciphertext
  // archives. secure_delete reduces residual deleted-cell data in THIS isolated
  // copy; filesystem/WAL cleanup and archive age retention remain separate gates.
  db.pragma("secure_delete=ON");
  try {
    return db.transaction(() => {
      ledger.assertFresh(now);
      assertReviewedSchema(db);
      // Restore admission is NOT based on a watermark stored in the restored DB.
      // Unknown columns/tables/FKs fail the entire transaction, never disable FKs.
      let erasedAccounts = 0; let suppressedEmails = 0;
      const deletedCustomers = new Set<string>();
      const customers = db.prepare("SELECT id,email_normalized,auth_user_id FROM customers").all() as
        Array<{ id: string; email_normalized: string; auth_user_id: string | null }>;
      const users = db.prepare('SELECT id,email FROM "user"').all() as Array<{ id: string; email: string }>;
      for (const entry of ledger.bundle.entries) {
        const { subject } = entry.body;
        assertErasureSubjectKey(keys, subject);
        const matches = (kind: "email" | "customer" | "user", value: string) =>
          erasurePseudonym(keys, subject.keyId, ledger.bundle.scope, kind, value) === subject[kind];
        // Suppression is reconstructed from the independent ledger even when the
        // original customer has gone or a genuinely new same-email account exists.
        const emails = new Set([
          ...customers.filter(customer => matches("email", customer.email_normalized)).map(customer => customer.email_normalized),
          ...users.filter(user => matches("email", user.email)).map(user => user.email.trim().toLocaleLowerCase("en-US")),
          ...(db.prepare("SELECT DISTINCT recipient_normalized FROM auth_email_outbox").all() as Array<{ recipient_normalized: string }>)
            .filter(row => matches("email", row.recipient_normalized)).map(row => row.recipient_normalized),
        ]);
        for (const email of emails) {
          db.prepare(`INSERT INTO email_suppressions(email_normalized,reason,created_at,removed_at) VALUES (?,'INDEPENDENT_ERASURE_LEDGER',?,NULL)
            ON CONFLICT(email_normalized) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at,removed_at=NULL`)
            .run(email, entry.body.recordedAt);
          db.prepare(`UPDATE notification_campaign_recipients SET state='SKIPPED_SUPPRESSED',last_error=NULL WHERE state='PENDING'
            AND customer_id IN (SELECT id FROM customers WHERE email_normalized=?)`).run(email);
          suppressedEmails++;
        }
        if (entry.body.kind !== "ERASURE") continue;
        const targetCustomers = customers.filter(customer => !deletedCustomers.has(customer.id) && matches("customer", customer.id));
        const targetUsers = users.filter(user => matches("user", user.id));
        if (targetUsers.some(user => !matches("email", user.email)) || targetCustomers.some(customer =>
          !matches("email", customer.email_normalized) || (customer.auth_user_id !== null && !matches("user", customer.auth_user_id)))) {
          throw new ErasureLedgerError("ERASURE_SUBJECT_BINDING_DRIFT");
        }
        for (const customer of targetCustomers) {
          for (const table of ["orders", "refund_requests", "course_entitlements"]) {
            if (db.prepare(`SELECT 1 FROM ${table} WHERE customer_id=? LIMIT 1`).get(customer.id)) {
              throw new ErasureLedgerError("ERASURE_FINANCIAL_REVIEW_REQUIRED");
            }
          }
          // Generic audit JSON is not assumed anonymous or safely discardable.
          // A classified legal/security hold must be implemented before such a
          // subject can be admitted; no invented retention deadline here.
          const audit = db.prepare(`SELECT 1 FROM audit_log WHERE actor=? OR subject_ref=?
            OR instr(evidence_json,?)>0 OR instr(evidence_json,?)>0 LIMIT 1`)
            .get(customer.id, customer.id, customer.id, customer.email_normalized);
          const adminAudit = db.prepare(`SELECT 1 FROM control_room_audit_log WHERE entity_id=?
            OR instr(details_json,?)>0 OR instr(details_json,?)>0 LIMIT 1`)
            .get(customer.id, customer.id, customer.email_normalized);
          if (audit || adminAudit) throw new ErasureLedgerError("ERASURE_AUDIT_REVIEW_REQUIRED");
          for (const table of ["authenticated_consent_actions", "account_consents", "marketing_consents",
            "notification_campaign_recipients", "free_course_enrollments", "checkout_quotes", "course_access_starts",
            "lesson_resume_positions", "playback_grant_rate_limits", "playback_access_events"]) {
            db.prepare(`DELETE FROM ${table} WHERE customer_id=?`).run(customer.id);
          }
          db.prepare("DELETE FROM customers WHERE id=?").run(customer.id);
          erasedAccounts++; deletedCustomers.add(customer.id);
        }
        for (const user of targetUsers) {
          // FK cascades remove session/account credentials; a foreign binding or
          // cross-subject consent proof causes rollback, not reassignment.
          db.prepare('DELETE FROM "user" WHERE id=?').run(user.id);
        }
        for (const email of emails) db.prepare("DELETE FROM auth_email_outbox WHERE recipient_normalized=?").run(email);
      }
      // Every restore invalidates ALL previously issued links and sessions. This
      // also handles orphaned magic-link JSON and avoids guessing identifier format.
      // Better Auth 1.7.6 stores hashed token identifiers + JSON {email,name} value.
      db.exec('DELETE FROM "session"; DELETE FROM verification;');
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new ErasureLedgerError("ERASURE_RESTORE_INTEGRITY_FAILED");
      return { erasedAccounts, suppressedEmails, sequence: ledger.bundle.entries.length,
        runtimeAdmission: "PENDING" as const, processorDeletion: "PENDING" as const };
    }).immediate();
  } catch (error) {
    if (error instanceof ErasureLedgerError) throw error;
    throw new ErasureLedgerError("ERASURE_RESTORE_REFUSED");
  }
}
