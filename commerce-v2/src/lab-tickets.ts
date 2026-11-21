import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getOrCreateCustomer, normalizeEmail } from "./customers";
import { legalManifestHash, type LegalReleaseManifest } from "./legal-control";

export class LabTicketError extends Error {}
const fail = (code: string): never => { throw new LabTicketError(code); };
export const capabilityHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const assertLabCapability = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : fail("LAB_CAPABILITY_INVALID");
export const labEmail = (value: unknown) => {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s<>@\x00-\x1f\x7f-\x9f]+@[^\s<>@\x00-\x1f\x7f-\x9f]+\.[^\s<>@\x00-\x1f\x7f-\x9f]+$/.test(value.trim())) fail("LAB_EMAIL_INVALID");
  return normalizeEmail(value as string);
};
export type LabAccess = { order_public_id: string; customer_id: string; token_sha256: string; acceptance_json: string | null };
export function labAccess(db: Database.Database, token: string): LabAccess {
  const row = db.prepare("SELECT * FROM lab_guest_access WHERE token_sha256=?").get(capabilityHash(assertLabCapability(token))) as LabAccess | undefined;
  return row ?? fail("LAB_ACCESS_INVALID");
}

/** Fixed-window, persistent and bounded; keys contain only digests, never email/IP/capabilities. */
export function consumeLabLimit(db: Database.Database, scope: string, identity: string, max: number, now: string) {
  const window = new Date(Math.floor(Date.parse(now) / 900_000) * 900_000).toISOString();
  return db.transaction(() => {
    db.prepare("DELETE FROM lab_guest_rate_limits WHERE window_start<?").run(window);
    const bucket = capabilityHash(`${scope}:${identity}`);
    db.prepare(`INSERT INTO lab_guest_rate_limits VALUES (?,?,1)
      ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1`).run(bucket, window);
    return (db.prepare("SELECT attempts FROM lab_guest_rate_limits WHERE bucket=?").get(bucket) as { attempts: number }).attempts <= max;
  }).immediate();
}

/** The caller generates the token before the request, so lost ACK/reload can replay it. */
export function startLabGuest(db: Database.Database, input: { email: unknown; accessToken: unknown }, now: string) {
  const token = assertLabCapability(input.accessToken), email = labEmail(input.email);
  return db.transaction(() => {
    const existing = db.prepare(`SELECT access.order_public_id,customer.email_normalized FROM lab_guest_access access
      JOIN customers customer ON customer.id=access.customer_id WHERE access.token_sha256=?`).get(capabilityHash(token)) as
      { order_public_id: string; email_normalized: string } | undefined;
    if (existing) {
      if (existing.email_normalized !== email) fail("LAB_ACCESS_INPUT_MISMATCH");
      return { orderPublicId: existing.order_public_id };
    }
    const customer = getOrCreateCustomer(db, email);
    const orderPublicId = randomUUID();
    db.prepare("INSERT INTO lab_guest_access(order_public_id,customer_id,token_sha256,acceptance_json,created_at,updated_at) VALUES (?,?,?,NULL,?,?)")
      .run(orderPublicId, customer.id, capabilityHash(token), now, now);
    return { orderPublicId };
  }).immediate();
}

export type LabAcceptance = { personalDataConsent: boolean; termsAccepted: boolean; receiptContactAccepted: boolean;
  releaseVersion: string; manifestSha256: string };
export function labLegalReview(db: Database.Database) {
  const release = db.prepare("SELECT id,version,manifest_json FROM legal_releases WHERE storefront='LAB' AND active=1").get() as
    { id: string; version: string; manifest_json: string } | undefined;
  if (!release) return fail("LAB_LEGAL_RELEASE_REQUIRED");
  const manifest = JSON.parse(release.manifest_json) as LegalReleaseManifest;
  if (manifest.stage !== "B" || ["privacy", "personal_data", "course_offer", "receipt_contact", "fiscal_items", "refund_terms"]
    .some(kind => !manifest.documents.some(doc => doc.kind === kind))) fail("LAB_LEGAL_RELEASE_REQUIRED");
  return { releaseId: release.id, releaseVersion: release.version, manifestSha256: legalManifestHash(manifest), documents: manifest.documents };
}
/** Payment acceptance, never browser success/navigation, issues one durable ticket per line. */
export function issueLabTicket(db: Database.Database, lineId: string, now: string) {
  db.prepare("INSERT INTO lab_tickets(id,order_line_id,issued_at) VALUES (?,?,?) ON CONFLICT(order_line_id) DO NOTHING")
    .run(randomUUID(), lineId, now);
}
const qrFor = (token: string, ticketId: string) => createHmac("sha256", token).update(`LAB_ENTRY_V1:${ticketId}`).digest("base64url");
function ticketRow(db: Database.Database, orderPublicId: string) {
  return db.prepare(`SELECT ticket.id,ticket.used_at,ticket.used_by,ticket.qr_sha256,orders.state,line.occurrence_snapshot_json,
      occurrence.lifecycle,product.occurrence_ref FROM lab_tickets ticket JOIN order_lines line ON line.id=ticket.order_line_id
      JOIN orders ON orders.id=line.order_id JOIN products product ON product.id=line.product_id
      JOIN lab_occurrences occurrence ON occurrence.occurrence_ref=product.occurrence_ref WHERE orders.public_id=?`).get(orderPublicId) as
    { id: string; used_at: string | null; used_by: string | null; qr_sha256: string | null; state: string;
      occurrence_snapshot_json: string; lifecycle: string; occurrence_ref: string } | undefined;
}
const statusFor = (row: NonNullable<ReturnType<typeof ticketRow>>) =>
  row.state === "REFUNDED" || row.state === "CANCELLED" || row.state === "EXPIRED" || row.lifecycle === "CANCELLED" ? "VOID"
    : row.used_at ? "USED" : "VALID";
export function readLabTicket(db: Database.Database, token: string) {
  return db.transaction(() => {
    const access = labAccess(db, token), row = ticketRow(db, access.order_public_id);
    if (!row) return { orderPublicId: access.order_public_id, status: "NOT_ISSUED" as const };
    const status = statusFor(row), qrToken = qrFor(token, row.id);
    if (status === "VALID") db.prepare("UPDATE lab_tickets SET qr_sha256=? WHERE id=? AND qr_sha256 IS NULL").run(capabilityHash(qrToken), row.id);
    return { orderPublicId: access.order_public_id, ticketId: row.id, status, usedAt: row.used_at,
      occurrence: JSON.parse(row.occurrence_snapshot_json), ...(status === "VALID" ? { qrToken } : {}) };
  }).immediate();
}

/** Atomic compare-and-set under SQLite's write lock. Neither a recovery nor a refund clears used_at. */
export function checkInLabTicket(db: Database.Database, input: { qrToken: string; occurrenceRef: string; actor: string }, now: string) {
  return db.transaction(() => {
    const tokenHash = capabilityHash(assertLabCapability(input.qrToken));
    const order = db.prepare(`SELECT orders.public_id FROM lab_tickets ticket JOIN order_lines line ON line.id=ticket.order_line_id
      JOIN orders ON orders.id=line.order_id WHERE ticket.qr_sha256=?`).get(tokenHash) as { public_id: string } | undefined;
    const row = order && ticketRow(db, order.public_id);
    if (!row || row.occurrence_ref !== input.occurrenceRef) return fail("LAB_QR_INVALID");
    if (statusFor(row) === "VOID") fail("LAB_TICKET_VOID");
    if (row.used_at) fail("LAB_QR_ALREADY_USED");
    const changed = db.prepare("UPDATE lab_tickets SET used_at=?,used_by=? WHERE id=? AND qr_sha256=? AND used_at IS NULL")
      .run(now, input.actor, row.id, tokenHash);
    if (changed.changes !== 1) fail("LAB_QR_ALREADY_USED");
    db.prepare("INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?, 'LAB_TICKET_USED','LAB_TICKET',?,?,?)")
      .run(randomUUID(), input.actor, row.id, JSON.stringify({ occurrenceRef: input.occurrenceRef }), now);
    return { ticketId: row.id, status: "USED" as const, usedAt: now };
  }).immediate();
}

export type LabTicketEmail = { email: string; url: string; ticketLinks?: readonly string[] };
export function prepareLabRecovery(db: Database.Database, email: string, orderPublicId: string, origin: string, now: string): LabTicketEmail | null {
  const row = db.prepare(`SELECT access.order_public_id FROM lab_guest_access access JOIN customers customer ON customer.id=access.customer_id
    WHERE access.order_public_id=? AND customer.email_normalized=?`).get(orderPublicId, email) as { order_public_id: string } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM lab_ticket_recoveries WHERE expires_at<=?").run(now);
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO lab_ticket_recoveries(token_sha256,order_public_id,expires_at) VALUES (?,?,?)")
    .run(capabilityHash(token), row.order_public_id, new Date(Date.parse(now) + 15 * 60_000).toISOString());
  return { email, url: `${origin}/ticket#recover=${token}` };
}
function rotateAccess(db: Database.Database, orderPublicId: string, token: string, now: string) {
  assertLabCapability(token);
  db.prepare("UPDATE lab_guest_access SET token_sha256=?,updated_at=? WHERE order_public_id=?").run(capabilityHash(token), now, orderPublicId);
  // Revoke every old QR, while keeping the ticket's immutable use record.
  db.prepare(`UPDATE lab_tickets SET qr_sha256=NULL WHERE order_line_id IN
    (SELECT line.id FROM order_lines line JOIN orders ON orders.id=line.order_id WHERE orders.public_id=?)`).run(orderPublicId);
  return { orderPublicId };
}
export function redeemLabRecovery(db: Database.Database, recoveryToken: string, accessToken: string, now: string) {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM lab_ticket_recoveries WHERE token_sha256=?").get(capabilityHash(assertLabCapability(recoveryToken))) as
      { order_public_id: string; expires_at: string; consumed_at: string | null; replacement_sha256: string | null } | undefined;
    assertLabCapability(accessToken);
    if (!row || row.expires_at <= now) return fail("LAB_RECOVERY_INVALID");
    if (row.consumed_at) {
      const current = labAccess(db, accessToken);
      if (row.replacement_sha256 !== capabilityHash(accessToken) || current.order_public_id !== row.order_public_id) fail("LAB_RECOVERY_INVALID");
      return { orderPublicId: row.order_public_id };
    }
    const result = rotateAccess(db, row.order_public_id, accessToken, now);
    db.prepare("UPDATE lab_ticket_recoveries SET consumed_at=?,replacement_sha256=? WHERE token_sha256=?")
      .run(now, capabilityHash(accessToken), capabilityHash(recoveryToken));
    // Concurrent emails cannot later overwrite a completed recovery.
    db.prepare("DELETE FROM lab_ticket_recoveries WHERE order_public_id=? AND token_sha256<>?").run(row.order_public_id, capabilityHash(recoveryToken));
    return result;
  }).immediate();
}
export function reissueOwnedLabTicket(db: Database.Database, customerId: string, orderPublicId: string, token: string, now: string) {
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM lab_guest_access WHERE order_public_id=? AND customer_id=?").get(orderPublicId, customerId)) fail("LAB_ACCESS_INVALID");
    db.prepare("DELETE FROM lab_ticket_recoveries WHERE order_public_id=?").run(orderPublicId);
    return rotateAccess(db, orderPublicId, token, now);
  }).immediate();
}

/**
 * FLEX-60/123: the ticket of an account-owned LAB order (no guest capability). The QR is
 * HMAC(serverSecret, ticket, generation): a normal view shows the same QR, an explicit reissue moves
 * the generation and revokes the old one. A used ticket keeps its use record and shows no QR.
 */
const ownedQrFor = (secret: Buffer, ticketId: string, generation: number) =>
  createHmac("sha256", secret).update(`LAB_ENTRY_V2:${ticketId}:${generation}`).digest("base64url");
function ownedTicketRow(db: Database.Database, customerId: string, orderPublicId: string) {
  const owned = db.prepare(`SELECT 1 FROM orders WHERE public_id=? AND customer_id=?
    AND NOT EXISTS (SELECT 1 FROM lab_guest_access access WHERE access.order_public_id=orders.public_id)`).get(orderPublicId, customerId);
  if (!owned) fail("LAB_TICKET_NOT_FOUND");
  const row = ticketRow(db, orderPublicId);
  if (!row) return undefined;
  const { qr_generation } = db.prepare("SELECT qr_generation FROM lab_tickets WHERE id=?").get(row.id) as { qr_generation: number };
  return { ...row, qr_generation };
}
const assertQrSecret = (secret: Buffer) => { if (!Buffer.isBuffer(secret) || secret.length < 32) fail("LAB_TICKET_SECRET_UNAVAILABLE"); };
export function readOwnedLabTicket(db: Database.Database, secret: Buffer, customerId: string, orderPublicId: string) {
  assertQrSecret(secret);
  return db.transaction(() => {
    const row = ownedTicketRow(db, customerId, orderPublicId);
    if (!row) return { orderPublicId, status: "NOT_ISSUED" as const };
    const status = statusFor(row), qrToken = ownedQrFor(secret, row.id, row.qr_generation);
    if (status === "VALID") {
      db.prepare("UPDATE lab_tickets SET qr_sha256=? WHERE id=? AND qr_sha256 IS NULL").run(capabilityHash(qrToken), row.id);
      const current = db.prepare("SELECT qr_sha256 FROM lab_tickets WHERE id=?").get(row.id) as { qr_sha256: string | null };
      if (current.qr_sha256 !== capabilityHash(qrToken)) fail("LAB_TICKET_QR_CONFLICT");
    }
    return { orderPublicId, ticketId: row.id, status, usedAt: row.used_at, occurrence: JSON.parse(row.occurrence_snapshot_json),
      ...(status === "VALID" ? { qrToken } : {}) };
  }).immediate();
}
export function reissueOwnedLabQr(db: Database.Database, secret: Buffer, customerId: string, orderPublicId: string, now: string) {
  assertQrSecret(secret);
  return db.transaction(() => {
    const row = ownedTicketRow(db, customerId, orderPublicId) ?? fail("LAB_TICKET_NOT_ISSUED");
    if (statusFor(row) !== "VALID") fail(row.used_at ? "LAB_QR_ALREADY_USED" : "LAB_TICKET_VOID");
    db.prepare("UPDATE lab_tickets SET qr_generation=qr_generation+1,qr_sha256=NULL WHERE id=?").run(row.id);
    db.prepare("INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?, 'LAB_TICKET_QR_REISSUED','LAB_TICKET',?,?,?)")
      .run(randomUUID(), `customer:${customerId}`, row.id, JSON.stringify({ generation: row.qr_generation + 1 }), now);
    return readOwnedLabTicket(db, secret, customerId, orderPublicId);
  }).immediate();
}

/** Server env only: base64url of ≥32 bytes. Anything else leaves owned-ticket QR closed (fail-closed). */
export function labTicketQrSecretFromEnv(env: Record<string, string | undefined>): Buffer | undefined {
  const raw = env.LAB_TICKET_QR_SECRET?.trim();
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  const secret = Buffer.from(raw, "base64url");
  return secret.length >= 32 ? secret : undefined;
}

export type MyLabTicket = { orderPublicId: string; title: string; startsAt: string; endsAt: string; timezone: string;
  venueName: string | null; status: "VALID" | "USED" | "VOID" | "NOT_ISSUED"; viewPath: string | null };

/**
 * FLEX-123 "Мои билеты" for a confirmed account: the frozen promise of each LAB order and its ticket
 * status. No QR, token or capability. A historical guest order bound to the account is listed without a
 * view path: its ticket stays behind its own capability.
 */
export function listOwnedLabTickets(db: Database.Database, customerId: string): MyLabTicket[] {
  const rows = db.prepare(`SELECT orders.public_id,orders.state,line.occurrence_snapshot_json,occurrence.lifecycle,
      ticket.id AS ticket_id,ticket.used_at,
      EXISTS (SELECT 1 FROM lab_guest_access access WHERE access.order_public_id=orders.public_id) AS guest_scoped
    FROM orders JOIN order_lines line ON line.order_id=orders.id JOIN products product ON product.id=line.product_id
    JOIN lab_occurrences occurrence ON occurrence.occurrence_ref=product.occurrence_ref
    LEFT JOIN lab_tickets ticket ON ticket.order_line_id=line.id
    WHERE orders.customer_id=? AND product.kind='LAB' AND orders.state NOT IN ('EXPIRED','CANCELLED','DRAFT')
    ORDER BY json_extract(line.occurrence_snapshot_json,'$.startsAt') DESC,orders.public_id`).all(customerId) as Array<{
      public_id: string; state: string; occurrence_snapshot_json: string; lifecycle: string; ticket_id: string | null; used_at: string | null; guest_scoped: number }>;
  return rows.map(row => {
    const promised = JSON.parse(row.occurrence_snapshot_json) as { title: string; startsAt: string; endsAt: string; timezone: string;
      venue: { status: string; name?: string } | null };
    const status = !row.ticket_id ? "NOT_ISSUED" as const
      : statusFor({ state: row.state, lifecycle: row.lifecycle, used_at: row.used_at } as NonNullable<ReturnType<typeof ticketRow>>);
    return { orderPublicId: row.public_id, title: promised.title, startsAt: promised.startsAt, endsAt: promised.endsAt, timezone: promised.timezone,
      venueName: promised.venue?.status === "CONFIRMED" ? promised.venue.name ?? null : null, status,
      viewPath: row.guest_scoped ? null : `/tickets/${encodeURIComponent(row.public_id)}` };
  });
}
