import type Database from "better-sqlite3";
import { id, now, sha256 } from "../crypto";
import { DomainError, many, one, withImmediateTransaction } from "./shared";

export type OccurrenceCreateInput = {
  city_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  price_kopecks: number;
  capacity: number;
  venue_status: "CONFIRMED" | "TO_BE_ANNOUNCED";
  venue_name?: string | null;
  venue_address?: string | null;
  venue_disclosure_text?: string | null;
  venue_announce_by?: string | null;
  audit_context?: string;
};

interface OccurrencesHost {
  readonly db: Database.Database;
  resolveOperationalIncidents(entityType: "refund" | "order" | "occurrence", entityId: string, note: string): void;
  withAdminCommand<T extends Record<string, unknown>>(command: string, idempotencyKey: string, payload: unknown, table: "occurrences", operation: () => T): T;
  recordAdminCommandAudit(adminId: string, action: string, entityType: string, entityId: string, auditContext: string | undefined, idempotencyKey: string, payload: unknown): void;
}

export const cancellationFinancialOverview = (host: OccurrencesHost, occurrenceId: string) => {
  const occurrence = one(host.db, "SELECT fulfillment_status FROM occurrences WHERE id = ?", occurrenceId);
  if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
  if (occurrence.fulfillment_status !== "CANCELLED") throw new DomainError("OCCURRENCE_NOT_CANCELLED", 409);
  return one(host.db, `WITH payment_totals AS (
    SELECT p.id, p.captured_amount_kopecks AS captured,
      COALESCE((SELECT SUM(r.amount_kopecks) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'SUCCEEDED'), 0) AS refund_succeeded,
      COALESCE((SELECT COUNT(*) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'REVIEW_REQUIRED'), 0) AS refund_review_count,
      CASE WHEN ro.status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END AS obligation_review
    FROM payments p JOIN orders o ON o.id = p.order_id
    LEFT JOIN refund_obligations ro ON ro.payment_id = p.id
    WHERE o.occurrence_id = ? AND p.captured_amount_kopecks > 0
  ) SELECT
    COUNT(*) AS paid_orders,
    COALESCE(SUM(captured), 0) AS captured_kopecks,
    COALESCE(SUM(captured), 0) AS refund_target_kopecks,
    COALESCE(SUM(refund_succeeded), 0) AS refund_succeeded_kopecks,
    COALESCE(SUM(CASE WHEN captured > refund_succeeded THEN captured - refund_succeeded ELSE 0 END), 0) AS refund_outstanding_kopecks,
    COALESCE(SUM(CASE WHEN refund_review_count > 0 OR obligation_review = 1 THEN CASE WHEN captured > refund_succeeded THEN captured - refund_succeeded ELSE 0 END ELSE 0 END), 0) AS refund_needs_attention_kopecks,
    COALESCE(SUM(CASE WHEN refund_review_count > 0 OR obligation_review = 1 THEN 1 ELSE 0 END), 0) AS refund_needs_attention_count
    FROM payment_totals`, occurrenceId)!;
};

export const completeOccurrence = (host: OccurrencesHost, occurrenceId: string) =>
  withImmediateTransaction(host.db, () => {
    const occurrence = one(host.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId);
    if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
    if (occurrence.fulfillment_status !== "SCHEDULED") throw new DomainError("OCCURRENCE_TERMINAL", 409);
    if (occurrence.sales_status !== "CLOSED") throw new DomainError("OCCURRENCE_SALES_MUST_BE_CLOSED", 409);
    if (new Date(String(occurrence.ends_at)).getTime() > Date.now()) throw new DomainError("OCCURRENCE_NOT_ENDED", 409);
    host.db.prepare("UPDATE occurrences SET fulfillment_status = 'COMPLETED', sales_status = 'CLOSED', completed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), occurrenceId);
    const reserved = many(host.db, "SELECT id FROM bookings WHERE occurrence_id = ? AND status = 'RESERVED'", occurrenceId);
    for (const booking of reserved) host.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'OCCURRENCE_COMPLETED_UNPAID' WHERE id = ?").run(now(), booking.id);
    host.resolveOperationalIncidents("occurrence", occurrenceId, "Occurrence completed");
    return one(host.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId)!;
  });

export const createAdminReauth = (host: OccurrencesHost, input: { adminId: string; sessionId: string; purpose: "CANCEL_OCCURRENCE"; resourceId: string; capability: string }) =>
  withImmediateTransaction(host.db, () => {
    const capabilityId = id(); const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    host.db.prepare("INSERT INTO admin_reauth_capabilities(id, capability_hash, admin_session_id, admin_id, purpose, resource_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(capabilityId, sha256(input.capability), input.sessionId, input.adminId, input.purpose, input.resourceId, expiresAt);
    return { expires_at: expiresAt };
  });

export const createOccurrenceRecord = (host: OccurrencesHost, input: OccurrenceCreateInput, occurrenceId: string = id()) => {
  if (!one(host.db, "SELECT id FROM cities WHERE id = ?", input.city_id)) throw new DomainError("CITY_NOT_FOUND", 404);
  if (!Number.isInteger(input.price_kopecks) || input.price_kopecks <= 0 || !Number.isInteger(input.capacity) || input.capacity <= 0 || Date.parse(input.ends_at) <= Date.parse(input.starts_at)) {
    throw new DomainError("OCCURRENCE_CREATE_INVALID", 422);
  }
  if (input.venue_status === "CONFIRMED" && (!input.venue_name || !input.venue_address)) throw new DomainError("VENUE_CONFIRMATION_INCOMPLETE", 422);
  if (input.venue_status === "TO_BE_ANNOUNCED" && (!input.venue_disclosure_text || !input.venue_announce_by)) throw new DomainError("VENUE_TBD_INCOMPLETE", 422);
  if (input.venue_status === "TO_BE_ANNOUNCED" && Date.parse(input.venue_announce_by!) >= Date.parse(input.starts_at)) throw new DomainError("VENUE_ANNOUNCEMENT_TOO_LATE", 422);
  host.db.prepare(`INSERT INTO occurrences(
      id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
      sales_status, visibility, venue_status, venue_name, venue_address, venue_public,
      venue_disclosure_text, venue_announce_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CLOSED', 'HIDDEN', ?, ?, ?, 0, ?, ?)`)
    .run(occurrenceId, input.city_id, input.title, input.starts_at, input.ends_at, input.timezone,
      input.price_kopecks, input.capacity, input.venue_status, input.venue_name ?? null,
      input.venue_address ?? null, input.venue_disclosure_text ?? null, input.venue_announce_by ?? null);
  return one(host.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId)!;
};

export const createOccurrence = (host: OccurrencesHost, input: OccurrenceCreateInput, idempotencyKey: string, adminId: string) =>
  host.withAdminCommand("occurrence-create", idempotencyKey, input, "occurrences", () => {
    const occurrence = createOccurrenceRecord(host, input);
    host.recordAdminCommandAudit(adminId, "OCCURRENCE_CREATED", "occurrence", String(occurrence.id), input.audit_context, idempotencyKey, input);
    return occurrence;
  });
