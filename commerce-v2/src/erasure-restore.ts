import { ownerLegalEvidenceMentions } from "./owner-legal-decision";
import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { classifyV2Database } from "./db";
import { assertErasureSubjectKey, erasurePseudonym, ErasureLedgerError, VerifiedErasureLedger, type ErasureKeys } from "./erasure-ledger";
import { DrainedErasureRuntime } from "./erasure-fence";

// Exact reviewed 0001–0025, 0001–0026 and 0001–0027 schemas. Migration 0026 adds only
// Control Room authored course content/history, with no customer FK or subject
// identity column; erasure still refuses financial/audit uncertainty. Keep the
// previous hashes for isolated old-backup restore. Migration 0027 adds retained
// owner legal evidence; possible subject mentions require audit review. Migration 0028 adds only
// the Control Room owner's encrypted TOTP seed, no subject data. Unknown DDL remains refused.
const REVIEWED_SCHEMA_SHA256 = new Set([
  "158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030",
  "c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39",
  "b71a08d5f785b98516d4c2fbde8184d25bb91ce1b880d614d637be76876dd84f",
  "40ede1d98e15b510c920418cd525e039346890560e7e9dc2fe90aecd760b86a1",
  // 0029: operator-authored LAB lifecycle/revisions, no new customer identity columns.
  "3250c233a22b6b2f77ed827fbfabacae604f9c30420788b2b0556116a56d8eab",
  // 0030: durable intent in the already-classified checkout_quotes store; customer FK retained.
  "18b7318e43e12f2835afcf9b87d0958de4c8e186aa3670f5a448e7f3d8389b4d",
  // 0031: trigger expires only unconsumed LAB intents on material edits; no new identity store.
  "9c464ba0199cd18fa0eb3d5598d3bc0131fd68bd9fad2064676e8801c498eb2b",
  // 0032: order-scoped guest credentials, recovery links and durable admission records.
  "354508649dd6ec29f477b118711913b2fb9b00c979e3f7c2bb895aae2c87f01a",
]);
function assertReviewedSchema(db: Database.Database) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  if (!REVIEWED_SCHEMA_SHA256.has(createHash("sha256").update(JSON.stringify(schema)).digest("hex"))) {
    throw new ErasureLedgerError("ERASURE_RESTORE_UNCLASSIFIED_SCHEMA");
  }
}

/** Isolated restore ONLY. No HTTP endpoint, runtime activation or mail/provider call.
 * Must run before any traffic/jobs/email, with a genuinely independent fresh ledger.
 * Merchant schema stays unchanged; financial/audit uncertainty keeps restore CLOSED. */
export function applyIsolatedRestoreErasure(db: Database.Database, ledger: VerifiedErasureLedger, keys: ErasureKeys,
  environment: "canary" | "production", now = new Date()) {
  return applyErasure(db,ledger,keys,environment,now,true);
}

// The application receipt is process-private proof of this exact transaction, not JSON
// from a restored DB/operator. It never substitutes for newest remote custody proof.
const applications = new WeakMap<object,{drain:DrainedErasureRuntime; db:Database.Database; ledger:VerifiedErasureLedger}>();
export function assertErasureApplication(receipt: unknown, drain: DrainedErasureRuntime, db:Database.Database, ledger:VerifiedErasureLedger) {
  const applied = receipt && typeof receipt==="object" ? applications.get(receipt) : undefined;
  if (!applied || applied.drain!==drain || applied.db!==db || applied.ledger!==ledger) throw new ErasureLedgerError("ERASURE_APPLICATION_UNVERIFIED");
  DrainedErasureRuntime.assert(drain,db,ledger.bundle.scope);
}
/** Live application is legal only behind the shared exclusive drained runtime fence.
 * The operator preserves custody first. This code does not install/activate itself. */
export function applyDrainedRuntimeErasure(db: Database.Database, ledger: VerifiedErasureLedger, keys: ErasureKeys,
  environment: "canary" | "production", drain:DrainedErasureRuntime, now = new Date(), mode:"LIVE_ADMISSION"|"BOOT_RESTORE"="LIVE_ADMISSION") {
  DrainedErasureRuntime.assert(drain,db,environment);
  if(!["LIVE_ADMISSION","BOOT_RESTORE"].includes(mode))throw new ErasureLedgerError("ERASURE_DRAIN_INVALID");
  const result=applyErasure(db,ledger,keys,environment,now,mode==="BOOT_RESTORE",()=>DrainedErasureRuntime.assert(drain,db,environment));
  const receipt=Object.freeze({}); applications.set(receipt,{drain,db,ledger});
  return {...result,application:receipt};
}
function applyErasure(db: Database.Database, ledger: VerifiedErasureLedger, keys: ErasureKeys,
  environment: "canary" | "production", now:Date, resetAllCredentials:boolean, assertDrain?:()=>void) {
  VerifiedErasureLedger.prototype.assertFresh.call(ledger,now);
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
      assertDrain?.();
      VerifiedErasureLedger.prototype.assertFresh.call(ledger,now);
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
          if (audit || adminAudit || ownerLegalEvidenceMentions(db, [customer.id, customer.email_normalized])) throw new ErasureLedgerError("ERASURE_AUDIT_REVIEW_REQUIRED");
          for (const table of ["authenticated_consent_actions", "account_consents", "marketing_consents",
            "notification_campaign_recipients", "free_course_enrollments", "checkout_quotes", "course_access_starts",
            "lesson_resume_positions", "playback_grant_rate_limits", "playback_access_events", "lab_guest_access"]) {
            if (table !== "lab_guest_access" || db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
              db.prepare(`DELETE FROM ${table} WHERE customer_id=?`).run(customer.id);
            }
          }
          db.prepare("DELETE FROM customers WHERE id=?").run(customer.id);
          erasedAccounts++; deletedCustomers.add(customer.id);
        }
        for (const user of targetUsers) {
          if(ownerLegalEvidenceMentions(db, [user.id, user.email]) || db.prepare(`SELECT 1 FROM audit_log WHERE actor=? OR subject_ref=? OR instr(evidence_json,?)>0 LIMIT 1`)
            .get(user.id,user.id,user.id) || db.prepare(`SELECT 1 FROM control_room_audit_log WHERE admin_id=? OR instr(details_json,?)>0 LIMIT 1`)
            .get(user.id,user.id)) throw new ErasureLedgerError("ERASURE_AUDIT_REVIEW_REQUIRED");
          // FK cascades remove session/account credentials; a foreign binding or
          // cross-subject consent proof causes rollback, not reassignment.
          db.prepare('DELETE FROM "user" WHERE id=?').run(user.id);
        }
        for (const email of emails) db.prepare("DELETE FROM auth_email_outbox WHERE recipient_normalized=?").run(email);
        if(!resetAllCredentials) {
          for(const row of db.prepare("SELECT id,value FROM verification").all() as Array<{id:string;value:string}>) {
            let value:unknown; try {value=JSON.parse(row.value);} catch {throw new ErasureLedgerError("ERASURE_VERIFICATION_UNCLASSIFIED");}
            if(!value || typeof value!=="object" || typeof (value as {email?:unknown}).email!=="string") throw new ErasureLedgerError("ERASURE_VERIFICATION_UNCLASSIFIED");
            if(matches("email",(value as {email:string}).email)) db.prepare("DELETE FROM verification WHERE id=?").run(row.id);
          }
        }
      }
      // Every restore invalidates ALL previously issued links and sessions. This
      // also handles orphaned magic-link JSON and avoids guessing identifier format.
      // Better Auth 1.7.6 stores hashed token identifiers + JSON {email,name} value.
      if(resetAllCredentials) {
        db.exec('DELETE FROM "session"; DELETE FROM verification;');
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lab_guest_access'").get()) {
          db.exec("DELETE FROM lab_ticket_recoveries; UPDATE lab_tickets SET qr_sha256=NULL;");
          for (const row of db.prepare("SELECT order_public_id FROM lab_guest_access").all() as Array<{order_public_id:string}>) {
            db.prepare("UPDATE lab_guest_access SET token_sha256=? WHERE order_public_id=?").run(randomBytes(32).toString("hex"), row.order_public_id);
          }
        }
      }
      assertDrain?.();
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new ErasureLedgerError("ERASURE_RESTORE_INTEGRITY_FAILED");
      return { erasedAccounts, suppressedEmails, sequence: ledger.bundle.entries.length,
        runtimeAdmission: "PENDING" as const, processorDeletion: "PENDING" as const };
    }).immediate();
  } catch (error) {
    if (error instanceof ErasureLedgerError) throw error;
    throw new ErasureLedgerError("ERASURE_RESTORE_REFUSED");
  }
}
