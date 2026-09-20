import type Database from "better-sqlite3";
import { id, now, sha256 } from "../crypto";
import { suspendEngagementsForOccurrenceMaterialChange } from "../agent-referrals-engagement";
import { assertInventoryTarget, InventoryTargetError, resolveInventoryTarget, seatCommitments } from "../occurrence-inventory";
import { CITY_INTEREST_SWEEP_BATCH_SIZE, DomainError, many, one, occurrenceCustomerSnapshot, type OccurrenceCustomerSnapshot, type Row, withImmediateTransaction } from "./shared";

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
  recordAdminCommandAudit(adminId: string, action: string, entityType: string, entityId: string, auditContext: string | undefined, idempotencyKey: string, payload: unknown, details?: Record<string, unknown>): void;
  ensureFullCapturedRefund(paymentId: string, source: string, capturedTotal: number): Row | null;
  consumeEligibleCityInterests(citySlug?: string, limit?: number, timestamp?: string): unknown;
  enqueueEmail(type: string, recipientEmail: string, recipientEmailHash: string, template: string, payloadRef: string, payload: Record<string, unknown>): string;
  supersedePendingOccurrenceUpdatesForBooking(bookingId: string, reason: string): void;
  closeOccurrenceChangeRefundEntitlementsForBooking(bookingId: string, reason: string): void;
  hasOpenOccurrenceChangeRefundEntitlement(bookingId: string): boolean;
  pendingOccurrenceUpdateBaseline(bookingId: string): PendingOccurrenceUpdateBaseline | null;
  openOccurrenceNotificationPayloadCorruptionIncident(input: {
    occurrenceId: string;
    bookingId: string;
    orderId: string;
    blockedRevisionId: string;
    corrupt: CorruptOccurrenceNotification;
    recoveredFromRevision: boolean;
  }): void;
}

export type OccurrenceRevisionClassification = {
  changed: boolean;
  notificationMaterial: boolean;
  refundMaterial: boolean;
  materialChanges: Array<{ kind: string; field: keyof OccurrenceCustomerSnapshot; before: unknown; after: unknown }>;
  before: OccurrenceCustomerSnapshot;
  after: OccurrenceCustomerSnapshot;
};

export type CorruptOccurrenceNotification = { outboxId: string; revisionId: string };
export type PendingOccurrenceUpdateBaseline =
  | { before: OccurrenceCustomerSnapshot; revisionIds: string[]; recoveredCorruptNotifications: CorruptOccurrenceNotification[]; corruptNotifications?: never }
  | { before?: never; revisionIds?: never; recoveredCorruptNotifications?: never; corruptNotifications: CorruptOccurrenceNotification[] };

const occurrenceState = (occurrence: Row) => `${occurrence.visibility}:${occurrence.sales_status}`;
const allowedOccurrenceStateTransitions = new Set([
  "HIDDEN:CLOSED->PUBLISHED:CLOSED",
  "PUBLISHED:CLOSED->PUBLISHED:OPEN",
  "PUBLISHED:CLOSED->HIDDEN:CLOSED",
  "PUBLISHED:OPEN->PUBLISHED:PAUSED",
  "PUBLISHED:OPEN->PUBLISHED:CLOSED",
  "PUBLISHED:PAUSED->PUBLISHED:OPEN",
  "PUBLISHED:PAUSED->PUBLISHED:CLOSED",
]);
const isAllowedOccurrenceStateTransition = (before: Row, after: Row) =>
  occurrenceState(before) === occurrenceState(after)
    || allowedOccurrenceStateTransitions.has(`${occurrenceState(before)}->${occurrenceState(after)}`);

export const classifyOccurrenceRevision = (beforeValue: Row, afterValue: Row): OccurrenceRevisionClassification => {
  const before = occurrenceCustomerSnapshot(beforeValue);
  const after = occurrenceCustomerSnapshot(afterValue);
  const fields = Object.keys(before) as Array<keyof OccurrenceCustomerSnapshot>;
  const kinds: Record<keyof OccurrenceCustomerSnapshot, string> = {
    title: "OCCURRENCE_TITLE_CHANGED",
    starts_at: "OCCURRENCE_START_CHANGED",
    ends_at: "OCCURRENCE_END_CHANGED",
    timezone: "OCCURRENCE_TIMEZONE_CHANGED",
    venue_status: "VENUE_STATUS_CHANGED",
    venue_name: "VENUE_NAME_CHANGED",
    venue_address: "VENUE_ADDRESS_CHANGED",
    venue_disclosure_text: "VENUE_DISCLOSURE_CHANGED",
    venue_announce_by: "VENUE_ANNOUNCEMENT_DEADLINE_CHANGED",
  };
  const materialChanges = fields.filter((field) => before[field] !== after[field])
    .map((field) => ({ kind: kinds[field], field, before: before[field], after: after[field] }));
  const changed = materialChanges.length > 0;
  const changedField = (field: keyof OccurrenceCustomerSnapshot) => before[field] !== after[field];
  const confirmedVenueChanged = before.venue_status === "CONFIRMED" && (
    after.venue_status !== "CONFIRMED" || changedField("venue_name") || changedField("venue_address")
  );
  const deadlineMovedLater = before.venue_announce_by !== null && after.venue_announce_by !== null
    && new Date(after.venue_announce_by).getTime() > new Date(before.venue_announce_by).getTime();
  return {
    changed,
    notificationMaterial: changed,
    refundMaterial: changedField("starts_at") || changedField("ends_at") || changedField("timezone") || confirmedVenueChanged || deadlineMovedLater,
    materialChanges,
    before,
    after,
  };
};

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
export const cancelOccurrence = (
  host: OccurrencesHost,
  occurrenceId: string,
  input: { reason: string; reauthCapability: string },
  idempotencyKey: string,
  adminId: string,
  sessionId: string,
) => {
  const payload = { occurrence_id: occurrenceId, reason: input.reason };
    return host.withAdminCommand("occurrence-cancel", idempotencyKey, payload, "occurrences", () => {
      const occurrence = one(host.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId);
      if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
      if (occurrence.fulfillment_status !== "SCHEDULED") throw new DomainError("OCCURRENCE_TERMINAL", 409);
      const capability = one(host.db, `SELECT * FROM admin_reauth_capabilities WHERE capability_hash = ? AND admin_session_id = ? AND admin_id = ?
        AND purpose = 'CANCEL_OCCURRENCE' AND resource_id = ? AND consumed_at IS NULL AND expires_at > ?`, sha256(input.reauthCapability), sessionId, adminId, occurrenceId, now());
      if (!capability) throw new DomainError("ADMIN_REAUTH_REQUIRED", 403);
      host.db.prepare("UPDATE admin_reauth_capabilities SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now(), capability.id);
      host.db.prepare("UPDATE occurrences SET fulfillment_status = 'CANCELLED', sales_status = 'CLOSED', cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?").run(now(), input.reason, now(), occurrenceId);
      // Entitlement cancellation is deliberately limited to active bookings.
      // It must not decide which captured payments receive a refund.
      const bookings = many(host.db, "SELECT id, order_id FROM bookings WHERE occurrence_id = ? AND status IN ('RESERVED', 'CONFIRMED')", occurrenceId);
      for (const booking of bookings) {
        host.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ? WHERE id = ?").run(now(), "OCCURRENCE_CANCELLED", booking.id);
        host.db.prepare("UPDATE tickets SET status = 'VOID', voided_at = ? WHERE booking_id = ? AND status = 'VALID'").run(now(), booking.id);
        host.supersedePendingOccurrenceUpdatesForBooking(String(booking.id), "OCCURRENCE_CANCELLED");
        host.closeOccurrenceChangeRefundEntitlementsForBooking(String(booking.id), "OCCURRENCE_CANCELLED");
      }
      host.resolveOperationalIncidents("occurrence", occurrenceId, "Occurrence cancelled");
      // Financial unwind and organizer notice are independent of booking
      // status. A prior technical or customer cancellation must not strand
      // money or suppress the affected paid order's cancellation notice.
      const capturedPayments = many(host.db, `SELECT p.id, p.captured_amount_kopecks, ord.id AS order_id,
          ord.customer_email, ord.customer_email_hash, ord.public_order_number
        FROM payments p JOIN orders ord ON ord.id = p.order_id
        WHERE ord.occurrence_id = ? AND p.captured_amount_kopecks > 0`, occurrenceId);
      for (const payment of capturedPayments) {
        host.ensureFullCapturedRefund(String(payment.id), "OCCURRENCE_CANCELLED", Number(payment.captured_amount_kopecks));
        host.enqueueEmail("OCCURRENCE_CANCELLED", String(payment.customer_email), String(payment.customer_email_hash), "occurrence-cancelled", String(payment.order_id), {
          occurrence_id: occurrenceId, order_id: payment.order_id, reason: input.reason, public_order_number: payment.public_order_number,
        });
      }
      host.recordAdminCommandAudit(adminId, "OCCURRENCE_CANCELLED", "occurrence", occurrenceId, input.reason, idempotencyKey, payload);
      return one(host.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId)!;
    });
};

const patchOccurrenceCommandPayload = (occurrenceId: string, input: Record<string, unknown>) => ({ occurrence_id: occurrenceId, ...input });

/**
 * The patch itself, with no opinion about transactions.
 *
 * Named so that a caller already holding a `BEGIN IMMEDIATE` can run it - the
 * certification catalogue seam must commit this mutation together with its own
 * record of what the command did, and `withAdminCommand` opens a raw
 * transaction that cannot nest.
 */
export const patchOccurrenceOperation = (host: OccurrencesHost, occurrenceId: string, input: Record<string, unknown>, idempotencyKey: string, adminId: string) => {
  const payload = patchOccurrenceCommandPayload(occurrenceId, input);
    {
      const before = one(host.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId);
      if (!before) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
      if (before.fulfillment_status !== "SCHEDULED") throw new DomainError("OCCURRENCE_TERMINAL", 409);
      const expectedRevision = Number(input.expected_revision);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(before.admin_revision)) {
        throw new DomainError("OCCURRENCE_REVISION_CONFLICT", 409);
      }
      if (input.capacity !== undefined) throw new DomainError("VALIDATION_ERROR", 422);
      const inventory = input.inventory;
      if (inventory !== undefined && (!inventory || typeof inventory !== "object" || Array.isArray(inventory))) throw new DomainError("VALIDATION_ERROR", 422);
      const inventoryPatch = inventory as Record<string, unknown> | undefined;
      const normalizedInput: Record<string, unknown> = {
        ...input,
        ...(inventoryPatch?.capacity !== undefined ? { capacity: inventoryPatch.capacity } : {}),
        ...(inventoryPatch?.admin_reserved_seats !== undefined ? { admin_reserved_seats: inventoryPatch.admin_reserved_seats } : {}),
      };
      delete (normalizedInput as Record<string, unknown>).inventory;
      const target = resolveInventoryTarget(before, normalizedInput);
      try { assertInventoryTarget(seatCommitments(host.db, occurrenceId), target); }
      catch (error) {
        if (error instanceof InventoryTargetError) throw new DomainError(error.code, 409, error.code, error.details);
        throw error;
      }
      const fields = ["title", "starts_at", "ends_at", "timezone", "venue_status", "venue_name", "venue_address", "venue_public", "venue_disclosure_text", "venue_announce_by", "price_kopecks", "capacity", "admin_reserved_seats", "sales_status", "visibility"] as const;
      const persistedPatch = Object.fromEntries(fields
        .filter((field) => normalizedInput[field] !== undefined)
        .map((field) => [field, typeof normalizedInput[field] === "boolean" ? Number(normalizedInput[field]) : normalizedInput[field]]));
      const changed = fields.filter((field) => persistedPatch[field] !== undefined && persistedPatch[field] !== before[field]);
      if (!changed.length) return before;
      const next = { ...before, ...Object.fromEntries(changed.map((field) => [field, persistedPatch[field]])) };
      const isLegacyHiddenSalesState = before.visibility === "HIDDEN" && (before.sales_status === "OPEN" || before.sales_status === "PAUSED");
      if (isLegacyHiddenSalesState && !(changed.length === 1 && changed[0] === "sales_status" && next.sales_status === "CLOSED")) {
        throw new DomainError("OCCURRENCE_STATE_TRANSITION_FORBIDDEN", 409);
      }
      if (!isAllowedOccurrenceStateTransition(before, next)) throw new DomainError("OCCURRENCE_STATE_TRANSITION_FORBIDDEN", 409);
      if (Date.parse(String(next.ends_at)) <= Date.parse(String(next.starts_at))) throw new DomainError("OCCURRENCE_CREATE_INVALID", 422);
      if (next.venue_status === "CONFIRMED" && (!next.venue_name || !next.venue_address)) throw new DomainError("VENUE_CONFIRMATION_INCOMPLETE", 422);
      if (next.venue_status === "TO_BE_ANNOUNCED" && (!next.venue_disclosure_text || !next.venue_announce_by)) throw new DomainError("VENUE_TBD_INCOMPLETE", 422);
      if (next.venue_status === "TO_BE_ANNOUNCED" && Date.parse(String(next.venue_announce_by)) >= Date.parse(String(next.starts_at))) throw new DomainError("VENUE_ANNOUNCEMENT_TOO_LATE", 422);
      const classification = classifyOccurrenceRevision(before, next);
      const assignments = [...changed.map((field) => `${field} = ?`), "material_revision = material_revision + ?", "admin_revision = admin_revision + 1", "updated_at = ?"];
      const updated = host.db.prepare(`UPDATE occurrences SET ${assignments.join(", ")} WHERE id = ? AND admin_revision = ?`)
        .run(...changed.map((field) => persistedPatch[field]), classification.notificationMaterial ? 1 : 0, now(), occurrenceId, expectedRevision);
      if (!updated.changes) throw new DomainError("OCCURRENCE_REVISION_CONFLICT", 409);
      const after = one(host.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId)!;
      // Publication, not city creation, can complete the narrowly scoped
      // purpose. The helper rechecks scheduled/future eligibility.
      const city = one(host.db, "SELECT slug FROM cities WHERE id = ?", after.city_id);
      if (city) host.consumeEligibleCityInterests(String(city.slug), CITY_INTEREST_SWEEP_BATCH_SIZE);
      if (classification.notificationMaterial) {
        const revisionId = id();
        host.db.prepare("INSERT INTO occurrence_revisions(id, occurrence_id, revision, reason, before_json, after_json, changed_by_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(revisionId, occurrenceId, after.material_revision, typeof input.audit_context === "string" ? input.audit_context : "", JSON.stringify(classification.before), JSON.stringify(classification.after), adminId);
        emitOccurrenceRevisionEffects(host, revisionId, before, after, classification);
        // Agent Referrals compatibility seam: the same classification that
        // just bumped occurrences.material_revision also invalidates any
        // engagement_revisions minted against the old schedule. An
        // already-ACTIVE engagement for this occurrence must not be left
        // granting promo/publication authority under stale terms - suspend
        // it now; only a fresh engagement revision (whose own
        // occurrence_material_revision will pin the new state), accepted
        // and activated again, can restore it.
        suspendEngagementsForOccurrenceMaterialChange(host.db, occurrenceId, "OCCURRENCE_MATERIAL_REVISION_CHANGED");
      }
      const inventoryDetails = Object.fromEntries(["capacity", "admin_reserved_seats"].filter((field) => changed.includes(field as typeof changed[number])).map((field) => [field, { from: before[field], to: after[field] }]));
      host.recordAdminCommandAudit(adminId, "OCCURRENCE_EDITED", "occurrence", occurrenceId, typeof input.audit_context === "string" ? input.audit_context : undefined, idempotencyKey, payload, Object.keys(inventoryDetails).length ? { inventory: inventoryDetails } : undefined);
      return after;
    }
};

export const patchOccurrence = (host: OccurrencesHost, occurrenceId: string, input: Record<string, unknown>, idempotencyKey: string, adminId: string) =>
  host.withAdminCommand("occurrence-patch", idempotencyKey, patchOccurrenceCommandPayload(occurrenceId, input), "occurrences",
    () => patchOccurrenceOperation(host, occurrenceId, input, idempotencyKey, adminId));

/** Creates immutable customer notices and, only for materially adverse facts, refund rights. */
const emitOccurrenceRevisionEffects = (host: OccurrencesHost, revisionId: string, before: Row, after: Row, classification: OccurrenceRevisionClassification) => {
  const paidBookings = many(host.db, `SELECT b.id AS booking_id, b.order_id, p.id AS payment_id,
        t.id AS ticket_id, o.customer_email, o.customer_email_hash, o.public_order_number
      FROM bookings b
      JOIN orders o ON o.id = b.order_id
      JOIN payments p ON p.order_id = o.id
      JOIN tickets t ON t.booking_id = b.id
      WHERE b.occurrence_id = ?
        AND b.status = 'CONFIRMED'
        AND t.status = 'VALID'
        AND p.status IN ('PAID', 'PARTIALLY_REFUNDED')
        AND p.captured_amount_kopecks > 0`, after.id);
    for (const booking of paidBookings) {
      // Only PENDING is proof that a prior notice did not leave our system.
      // Carry its earliest customer baseline forward so a quick follow-up
      // edit cannot hide a material change from the replacement notice.
      const pendingBaseline = host.pendingOccurrenceUpdateBaseline(String(booking.booking_id));
      if (classification.refundMaterial) {
        host.db.prepare(`INSERT OR IGNORE INTO occurrence_change_refund_entitlements(
          id, occurrence_revision_id, order_id, booking_id, payment_id
        ) VALUES (?, ?, ?, ?, ?)`)
          .run(id(), revisionId, booking.order_id, booking.booking_id, booking.payment_id);
      }
      if (pendingBaseline?.corruptNotifications) {
        // We cannot prove the baseline of an immutable pending customer
        // notice. Preserve it and stop this booking's notification sequence
        // rather than silently dropping the earlier change or guessing a
        // cumulative diff. Financial entitlement creation above remains
        // authoritative and atomic with the occurrence revision.
        for (const corrupt of pendingBaseline.corruptNotifications) {
          host.openOccurrenceNotificationPayloadCorruptionIncident({
            occurrenceId: String(after.id), bookingId: String(booking.booking_id),
            orderId: String(booking.order_id), blockedRevisionId: revisionId,
            corrupt, recoveredFromRevision: false,
          });
        }
        continue;
      }
      for (const corrupt of pendingBaseline?.recoveredCorruptNotifications ?? []) {
        host.openOccurrenceNotificationPayloadCorruptionIncident({
          occurrenceId: String(after.id), bookingId: String(booking.booking_id),
          orderId: String(booking.order_id), blockedRevisionId: revisionId,
          corrupt, recoveredFromRevision: true,
        });
      }
      host.supersedePendingOccurrenceUpdatesForBooking(String(booking.booking_id), "NEWER_OCCURRENCE_REVISION");
      const notificationClassification = pendingBaseline
        ? classifyOccurrenceRevision(pendingBaseline.before, after)
        : classification;
      const organizerChangeFullRefundAvailable = host.hasOpenOccurrenceChangeRefundEntitlement(String(booking.booking_id));
      const payload = {
        schema_version: 1,
        occurrence_revision_id: revisionId,
        occurrence_id: after.id,
        revision: after.material_revision,
        ticket_id: booking.ticket_id,
        booking_id: booking.booking_id,
        order_id: booking.order_id,
        public_order_number: booking.public_order_number,
        before: notificationClassification.before,
        after: notificationClassification.after,
        material_changes: notificationClassification.materialChanges,
        // This is a durable booking right, not a property of only the latest
        // PATCH. It stays visible after a notification-only follow-up edit.
        organizer_change_full_refund_available: organizerChangeFullRefundAvailable,
        ...(pendingBaseline ? { coalesced_unsent_revision_ids: pendingBaseline.revisionIds } : {}),
      };
      const outboxId = host.enqueueEmail(
        "OCCURRENCE_UPDATED",
        String(booking.customer_email),
        String(booking.customer_email_hash),
        "occurrence-updated",
        String(booking.order_id),
        payload,
      );
      host.db.prepare(`INSERT INTO occurrence_update_notifications(
        id, occurrence_revision_id, order_id, booking_id, ticket_id, outbox_id
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id(), revisionId, booking.order_id, booking.booking_id, booking.ticket_id, outboxId);
    }
};
