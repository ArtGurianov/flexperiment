import { ownerLegalEvidenceMentions } from "./owner-legal-decision";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyV2Database } from "./db";

const categories = ["EXPIRED_CREDENTIALS", "AUTH_OUTBOX", "PLAYBACK_TELEMETRY", "UNBOUND_INTENTS", "BACKUP_ARCHIVES"] as const;
const categorySchema = z.enum(categories);
export type RetentionCategory = z.infer<typeof categorySchema>;
const duration = z.number().int().min(600).max(10 * 366 * 24 * 3600);
const policySchema = z.object({
  version: z.literal(1), referenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  // No default/legal durations. Explicit reviewed technical policy only.
  expiredCredentialsGraceSeconds: duration, authOutboxMaxAgeSeconds: duration,
  playbackTelemetryMaxAgeSeconds: duration, unboundIntentsMaxAgeSeconds: duration,
  backupArchiveMaxAgeSeconds: duration,
}).strict();
export type RetentionPolicy = z.infer<typeof policySchema>;
const holdSchema = z.object({
  category: categorySchema,
  subject: z.object({ kind: z.enum(["CUSTOMER", "USER", "EMAIL", "BACKUP_OBJECT"]), value: z.string().min(1).max(512) }).strict(),
  justification: z.enum(["LEGAL_CLAIM", "SECURITY_INVESTIGATION", "PROCESSOR_CONFIRMATION"]),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), reviewedBy: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  reviewedAt: z.string().datetime(), until: z.string().datetime(),
}).strict();
export type RetentionHold = z.infer<typeof holdSchema>;
export class RetentionRefusal extends Error {
  constructor(code: string) { super(code); this.name = "RetentionRefusal"; }
}
const refuse = (code: string): never => { throw new RetentionRefusal(code); };
// Exact reviewed 0001–0025, 0001–0026 and 0001–0027 DDL. Migration 0026 adds Control Room
// authored course content/history, no customer FK or subject identity column.
// Migration 0027 retains merchant legal evidence and requires subject-mention review.
// Migration 0028 adds the Control Room owner's encrypted TOTP seed: an admin secret, no customer
// FK or subject identity column. Retention targets remain the same; unknown DDL still stops.
const supportedSchemaSha256 = new Set([
  "158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030",
  "c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39",
  "b71a08d5f785b98516d4c2fbde8184d25bb91ce1b880d614d637be76876dd84f",
  "40ede1d98e15b510c920418cd525e039346890560e7e9dc2fe90aecd760b86a1",
  // 0029: operator-authored LAB lifecycle/revisions, no new customer identity columns.
  "3250c233a22b6b2f77ed827fbfabacae604f9c30420788b2b0556116a56d8eab",
]);
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value); return result.success ? result.data : refuse("RETENTION_POLICY_OR_HOLD_INVALID");
};
function timestamp(value: unknown): number {
  if ((typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === "string" && /^\d{12,13}(?:\.0)?$/.test(value))) {
    const result = Number(value); if (Number.isSafeInteger(result)) return result;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    return refuse("RETENTION_TIMESTAMP_INVALID");
  }
  const qualified = value.replace(" ", "T");
  const [year, month, day, hour, minute, second] = qualified.slice(0, 19).split(/[-T:]/).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) return refuse("RETENTION_TIMESTAMP_INVALID");
  const result = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(qualified) ? qualified : `${qualified}Z`);
  return Number.isFinite(result) ? result : refuse("RETENTION_TIMESTAMP_INVALID");
}
function admission(input: { policy: RetentionPolicy; holds: readonly RetentionHold[] }, now: Date) {
  const policy = parse(policySchema, input.policy);
  const holds = parse(z.array(holdSchema).max(10_000), input.holds);
  const time = now.getTime(); if (!Number.isFinite(time)) refuse("RETENTION_CLOCK_INVALID");
  for (const hold of holds) {
    const reviewed = timestamp(hold.reviewedAt); const until = timestamp(hold.until);
    if (reviewed > time || until <= reviewed || until - reviewed > 10 * 366 * 24 * 3600 * 1000) refuse("RETENTION_HOLD_INVALID");
    if ((hold.category === "BACKUP_ARCHIVES") !== (hold.subject.kind === "BACKUP_OBJECT")) refuse("RETENTION_HOLD_INVALID");
  }
  // Expired holds need an explicit disposition review, NOT automatic evidence destruction.
  if (holds.some(hold => timestamp(hold.until) <= time)) refuse("RETENTION_HOLD_REVIEW_REQUIRED");
  const held = (category: RetentionCategory, refs: Array<{ kind: RetentionHold["subject"]["kind"]; value: string }>) =>
    holds.some(hold => hold.category === category && refs.some(ref => hold.subject.kind === ref.kind &&
      (ref.kind === "EMAIL" ? ref.value.trim().toLocaleLowerCase("en-US") === hold.subject.value.trim().toLocaleLowerCase("en-US") : ref.value === hold.subject.value)));
  return { policy, time, held };
}
const subjectRefs = (customer: { id: string; email_normalized: string; auth_user_id: string | null }) => [
  { kind: "CUSTOMER" as const, value: customer.id }, { kind: "EMAIL" as const, value: customer.email_normalized },
  ...(customer.auth_user_id ? [{ kind: "USER" as const, value: customer.auth_user_id }] : []),
];

/** Offline/quiescent engine only, deliberately not imported by server/jobs or a CLI.
 * Caller must stop all writers/mail before using it. A SQL transaction cannot stop
 * an already in-flight provider request. Installation/admission remains separate.
 * No active account, qualified consent, suppression or financial history is purged. */
export function cleanupOfflinePersonalData(db: Database.Database, input: {
  mode: "STOPPED_OFFLINE"; policy: RetentionPolicy; holds: readonly RetentionHold[];
}, now = new Date()) {
  if (input.mode !== "STOPPED_OFFLINE" || classifyV2Database(db) !== "SUPPORTED"
    || db.pragma("foreign_keys", { simple: true }) !== 1) refuse("RETENTION_OFFLINE_ADMISSION_REQUIRED");
  const { policy, time, held } = admission(input, now);
  const result = { policyReferenceSha256: policy.referenceSha256, policySha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex"), expiredCredentials: 0, authOutbox: 0,
    playbackTelemetry: 0, unboundIntents: 0, runtimeInstallation: "PENDING" as const };
  db.pragma("secure_delete=ON");
  try { return db.transaction(() => {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    if (!supportedSchemaSha256.has(createHash("sha256").update(JSON.stringify(schema)).digest("hex"))) refuse("RETENTION_SCHEMA_REVIEW_REQUIRED");
    const rows = (table: string) => {
      const count = (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
      if (count > 100_000) refuse("RETENTION_BATCH_REVIEW_REQUIRED");
      return db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    };
    const customers = rows("customers") as unknown as
      Array<{ id: string; email_normalized: string; auth_user_id: string | null }>;
    const users = rows('"user"') as unknown as Array<{ id: string; email: string }>;
    const emailRefs = (email: string) => [{ kind: "EMAIL" as const, value: email },
      ...customers.filter(customer => customer.email_normalized === email).flatMap(subjectRefs),
      ...users.filter(user => user.email.trim().toLocaleLowerCase("en-US") === email).map(user => ({ kind: "USER" as const, value: user.id }))];
    const userRefs = (id: string) => [{ kind: "USER" as const, value: id },
      ...users.filter(user => user.id === id).flatMap(user => emailRefs(user.email.trim().toLocaleLowerCase("en-US"))),
      ...customers.filter(customer => customer.auth_user_id === id).flatMap(subjectRefs)];
    const older = (value: unknown, seconds: number) => timestamp(value) < time - seconds * 1000;
    for (const row of rows('"session"')) {
      if (older(row.expires_at, policy.expiredCredentialsGraceSeconds)
        && !held("EXPIRED_CREDENTIALS", userRefs(String(row.user_id)))) {
        result.expiredCredentials += db.prepare('DELETE FROM "session" WHERE id=?').run(row.id).changes;
      }
    }
    for (const row of rows("verification")) {
      if (!older(row.expires_at, policy.expiredCredentialsGraceSeconds)) continue;
      let value: unknown; try { value = JSON.parse(String(row.value)); } catch { refuse("RETENTION_VERIFICATION_CLASSIFICATION_REQUIRED"); }
      if (!value || typeof value !== "object" || typeof (value as { email?: unknown }).email !== "string") refuse("RETENTION_VERIFICATION_CLASSIFICATION_REQUIRED");
      const email = (value as { email: string }).email.trim().toLocaleLowerCase("en-US");
      const refs = emailRefs(email);
      if (!held("EXPIRED_CREDENTIALS", refs)) result.expiredCredentials += db.prepare("DELETE FROM verification WHERE id=?").run(row.id).changes;
    }
    for (const row of rows("auth_email_outbox")) {
      const email = String(row.recipient_normalized);
      const refs = emailRefs(email);
      // Require last-update age AND actual link expiry. No ambiguous-send replay.
      if (older(row.updated_at, policy.authOutboxMaxAgeSeconds) && older(row.created_at, 600) && !held("AUTH_OUTBOX", refs)) {
        result.authOutbox += db.prepare("DELETE FROM auth_email_outbox WHERE id=?").run(row.id).changes;
      }
    }
    for (const row of rows("playback_access_events")) {
      const customer = customers.find(customer => customer.id === row.customer_id);
      const refs = customer ? emailRefs(customer.email_normalized) : row.customer_id ? [{ kind: "CUSTOMER" as const, value: String(row.customer_id) }] : [];
      if (older(row.occurred_at, policy.playbackTelemetryMaxAgeSeconds) && !held("PLAYBACK_TELEMETRY", refs)) {
        result.playbackTelemetry += db.prepare("DELETE FROM playback_access_events WHERE id=?").run(row.id).changes;
      }
    }
    for (const customer of customers) {
      if (customer.auth_user_id || users.some(user => user.email.trim().toLocaleLowerCase("en-US") === customer.email_normalized)
        || held("UNBOUND_INTENTS", subjectRefs(customer))) continue;
      const row = db.prepare("SELECT created_at,updated_at FROM customers WHERE id=?").get(customer.id) as { created_at: string; updated_at: string };
      if (!older(row.created_at, policy.unboundIntentsMaxAgeSeconds) || !older(row.updated_at, policy.unboundIntentsMaxAgeSeconds)) continue;
      // A newer initiation may leave customer.updated_at unchanged; use real facts.
      const intents = db.prepare("SELECT recorded_at,evidence_status FROM account_consents WHERE customer_id=? UNION ALL SELECT recorded_at,evidence_status FROM marketing_consents WHERE customer_id=?")
        .all(customer.id, customer.id) as Array<{ recorded_at: string; evidence_status: string }>;
      if (!intents.length || intents.some(intent => intent.evidence_status !== "UNVERIFIED_INTENT"
        || !older(intent.recorded_at, policy.unboundIntentsMaxAgeSeconds))) continue;
      if (db.prepare("SELECT 1 FROM auth_email_outbox WHERE recipient_normalized=? LIMIT 1").get(customer.email_normalized)) continue;
      let pendingLink = false;
      for (const verification of rows("verification")) {
        let body: unknown; try { body = JSON.parse(String(verification.value)); } catch { refuse("RETENTION_VERIFICATION_CLASSIFICATION_REQUIRED"); }
        if (!body || typeof body !== "object" || typeof (body as { email?: unknown }).email !== "string") refuse("RETENTION_VERIFICATION_CLASSIFICATION_REQUIRED");
        if ((body as { email: string }).email.trim().toLocaleLowerCase("en-US") === customer.email_normalized) pendingLink = true;
      }
      if (pendingLink) continue;
      // Preserve every grant/order/quote/recipient/access/progress fact, even if
      // unbound. Cleanup is not erasure admission and cannot invent a legal hold.
      if (["orders", "refund_requests", "course_entitlements", "free_course_enrollments", "checkout_quotes",
        "authenticated_consent_actions", "notification_campaign_recipients", "lesson_resume_positions",
        "course_access_starts", "playback_grant_rate_limits", "playback_access_events"]
        .some(table => !!db.prepare(`SELECT 1 FROM ${table} WHERE customer_id=? LIMIT 1`).get(customer.id))) continue;
      if (db.prepare("SELECT 1 FROM audit_log WHERE actor=? OR subject_ref=? OR instr(evidence_json,?)>0 OR instr(evidence_json,?)>0 LIMIT 1")
        .get(customer.id, customer.id, customer.id, customer.email_normalized)) continue;
      if (db.prepare("SELECT 1 FROM control_room_audit_log WHERE entity_id=? OR instr(details_json,?)>0 OR instr(details_json,?)>0 LIMIT 1")
        .get(customer.id, customer.id, customer.email_normalized)) continue;
      if (ownerLegalEvidenceMentions(db, [customer.id, customer.email_normalized])) continue;
      db.prepare("DELETE FROM account_consents WHERE customer_id=?").run(customer.id);
      db.prepare("DELETE FROM marketing_consents WHERE customer_id=?").run(customer.id);
      result.unboundIntents += db.prepare("DELETE FROM customers WHERE id=? AND auth_user_id IS NULL").run(customer.id).changes;
    }
    if ((db.pragma("foreign_key_check") as unknown[]).length) refuse("RETENTION_INTEGRITY_FAILED");
    return result;
  }).immediate(); } catch (error) {
    if (error instanceof RetentionRefusal) throw error;
    return refuse("RETENTION_CLEANUP_REFUSED");
  }
}

/** Pure archive planning, NOT deletion. Inventory must include VPS/Cloud/offline
 * copies with verified object identity. Foreign scopes/current proven archive/
 * individual holds are never selected; counts do not substitute for max age. */
export function expiredBackupCandidates(input: { policy: RetentionPolicy; holds: readonly RetentionHold[];
  scope: "commerce-canary" | "commerce-production" | "platform-canary";
  verifiedCurrentObject: string; objects: readonly { objectRef: string; scope: string; createdAt: string; sha256: string }[];
}, now = new Date()) {
  const { policy, time, held } = admission(input, now);
  if (!["commerce-canary", "commerce-production", "platform-canary"].includes(input.scope)
    || !input.verifiedCurrentObject || input.objects.length > 100_000) refuse("RETENTION_ARCHIVE_INVENTORY_INVALID");
  const identities = new Set<string>();
  for (const object of input.objects) {
    if (!object.objectRef || object.objectRef.length > 512 || !/^[a-f0-9]{64}$/.test(object.sha256) || identities.has(object.objectRef)) refuse("RETENTION_ARCHIVE_INVENTORY_INVALID");
    identities.add(object.objectRef);
    if (timestamp(object.createdAt) > time) refuse("RETENTION_CLOCK_INVALID");
  }
  const current = input.objects.find(object => object.objectRef === input.verifiedCurrentObject && object.scope === input.scope);
  if (!current) refuse("RETENTION_CURRENT_ARCHIVE_UNVERIFIED");
  return { policyReferenceSha256: policy.referenceSha256, policySha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex"), deletionAdmission: "PENDING" as const,
    objects: input.objects.filter(object => object.scope === input.scope && object.objectRef !== input.verifiedCurrentObject
      && timestamp(object.createdAt) < time - policy.backupArchiveMaxAgeSeconds * 1000
      && !held("BACKUP_ARCHIVES", [{ kind: "BACKUP_OBJECT", value: object.objectRef }])).map(object => ({ objectRef: object.objectRef, sha256: object.sha256 })) };
}
