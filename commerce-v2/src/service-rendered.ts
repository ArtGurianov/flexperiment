import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * The authoritative LAB SERVICE_RENDERED fact (FLEX-85, D). One append-only fact per paid order line,
 * schema `flexperiment.service-rendered/1`, read by C's FINAL_SETTLEMENT issuance (FLEX-119, #289):
 * C owns the closing-receipt outbox, its key `fiscal:FINAL_SETTLEMENT:{orderLineId}`, the contour of
 * the prepayment and the sealed receipt contact. Nothing here charges, issues or stores a contact.
 *
 * Basis (E position, 21.11.2026): CHECKED_IN, from the ticket's irreversible use record, is primary.
 * ATTENDED_ATTESTED is one explicit Control Room action per line after the end, with a reason from a
 * closed list, never in bulk, never for a cancelled or moved occurrence. A no-show, a partial or moved
 * service, an open refund or an unpaid order is REVIEW: no fact, so no closing receipt.
 */
export class ServiceRenderedError extends Error {
  constructor(code: string) { super(code); this.name = "ServiceRenderedError"; }
}
const fail = (code: string): never => { throw new ServiceRenderedError(code); };

export const SERVICE_RENDERED_SCHEMA = "flexperiment.service-rendered/1" as const;
export const ATTENDANCE_ATTESTATION_REASONS = ["QR_SCAN_FAILED", "SCANNER_UNAVAILABLE", "ATTENDANCE_LIST_CONFIRMED"] as const;
export type AttendanceAttestationReason = typeof ATTENDANCE_ATTESTATION_REASONS[number];
export type ServiceRenderedBasis = "CHECKED_IN" | "ATTENDED_ATTESTED";

export type ServiceRenderedFact = {
  schema: typeof SERVICE_RENDERED_SCHEMA;
  orderLineId: string; occurrenceRef: string; renderedAt: string; evidenceRef: string; recordedBy: string;
  basis: ServiceRenderedBasis; attestationReason: AttendanceAttestationReason | null; recordedAt: string;
};
export type ServiceRenderedReview = { orderPublicId: string; orderLineId: string; code: string };

type LineFacts = {
  order_public_id: string; order_state: string; line_id: string; occurrence_ref: string; occurrence_snapshot_json: string | null;
  lifecycle: string; starts_at: string; ends_at: string; cancelling: number;
  ticket_id: string | null; ticket_used_at: string | null; ticket_used_by: string | null; open_refund: number;
};
const LINE_FACTS = `SELECT orders.public_id AS order_public_id,orders.state AS order_state,line.id AS line_id,
    product.occurrence_ref,line.occurrence_snapshot_json,occurrence.lifecycle,occurrence.starts_at,occurrence.ends_at,
    EXISTS (SELECT 1 FROM lab_occurrence_cancellations cancellation WHERE cancellation.occurrence_ref=product.occurrence_ref) AS cancelling,
    ticket.id AS ticket_id,ticket.used_at AS ticket_used_at,ticket.used_by AS ticket_used_by,
    EXISTS (SELECT 1 FROM refund_requests request WHERE request.order_line_id=line.id
      AND request.state IN ('REQUESTED','APPROVED','EXECUTING','REVIEW_REQUIRED','REFUNDED')) AS open_refund
  FROM order_lines line JOIN orders ON orders.id=line.order_id JOIN products product ON product.id=line.product_id
  JOIN lab_occurrences occurrence ON occurrence.occurrence_ref=product.occurrence_ref
  LEFT JOIN lab_tickets ticket ON ticket.order_line_id=line.id
  WHERE product.kind='LAB'`;

/** Why a line cannot have a SERVICE_RENDERED fact now; null when it can. Order matters: the first applies. */
function refusal(line: LineFacts, now: string): string | null {
  if (line.lifecycle === "CANCELLED" || line.cancelling) return "OCCURRENCE_CANCELLED";
  if (Date.parse(line.ends_at) > Date.parse(now)) return "SERVICE_NOT_FINISHED";
  // A move after the sale means the promised service was not the one held (E, Q3).
  const promised = line.occurrence_snapshot_json ? JSON.parse(line.occurrence_snapshot_json) as { startsAt?: string; endsAt?: string } : null;
  if (!promised || Date.parse(promised.startsAt ?? "") !== Date.parse(line.starts_at) || Date.parse(promised.endsAt ?? "") !== Date.parse(line.ends_at)) {
    return "OCCURRENCE_MOVED_REVIEW";
  }
  if (line.order_state !== "FULFILLED") return `ORDER_${line.order_state}`;
  if (line.open_refund) return "REFUND_OPEN_OR_DONE";
  if (!line.ticket_id) return "TICKET_MISSING";
  return null;
}

const rowToFact = (row: Record<string, string | null>): ServiceRenderedFact => ({
  schema: SERVICE_RENDERED_SCHEMA, orderLineId: row.order_line_id!, occurrenceRef: row.occurrence_ref!, renderedAt: row.rendered_at!,
  evidenceRef: row.evidence_ref!, recordedBy: row.recorded_by!, basis: row.basis as ServiceRenderedBasis,
  attestationReason: row.attestation_reason as AttendanceAttestationReason | null, recordedAt: row.recorded_at!,
});

export function serviceRenderedFact(db: Database.Database, orderLineId: string): ServiceRenderedFact | null {
  const row = db.prepare("SELECT * FROM lab_service_renditions WHERE order_line_id=?").get(orderLineId) as Record<string, string | null> | undefined;
  return row ? rowToFact(row) : null;
}

/** For C's issuance job: facts in recording order, resumable with the last (recordedAt, orderLineId) cursor. */
export function listServiceRenderedFacts(db: Database.Database, options: { after?: { recordedAt: string; orderLineId: string }; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const rows = (options.after
    ? db.prepare(`SELECT * FROM lab_service_renditions WHERE (recorded_at,order_line_id)>(?,?) ORDER BY recorded_at,order_line_id LIMIT ?`)
      .all(options.after.recordedAt, options.after.orderLineId, limit)
    : db.prepare("SELECT * FROM lab_service_renditions ORDER BY recorded_at,order_line_id LIMIT ?").all(limit)) as Array<Record<string, string | null>>;
  return rows.map(rowToFact);
}

/** The cancellation signal C needs beside a fact: a cancelled or cancelling occurrence is never closed. */
export function labOccurrenceCancellationState(db: Database.Database, occurrenceRef: string): "NONE" | "REQUESTED" | "COMPLETED" {
  const row = db.prepare("SELECT state FROM lab_occurrence_cancellations WHERE occurrence_ref=?").get(occurrenceRef) as { state: "REQUESTED" | "COMPLETED" } | undefined;
  if (row) return row.state;
  const occurrence = db.prepare("SELECT lifecycle FROM lab_occurrences WHERE occurrence_ref=?").get(occurrenceRef) as { lifecycle: string } | undefined;
  return occurrence?.lifecycle === "CANCELLED" ? "COMPLETED" : "NONE";
}

/**
 * Whether a fact may be closed through the native closing receipt. Only a line prepaid through the
 * native contour is; a REFREF_RC2 prepayment, or any other or unknown contour, goes to a person.
 */
export function closingEligibility(fact: ServiceRenderedFact | null, contour: string | null, cancellation: "NONE" | "REQUESTED" | "COMPLETED") {
  if (!fact) return { eligible: false as const, code: "SERVICE_RENDERED_MISSING" };
  if (cancellation !== "NONE") return { eligible: false as const, code: "OCCURRENCE_CANCELLED" };
  if (contour === "NATIVE") return { eligible: true as const, code: "ELIGIBLE" };
  if (contour === "REFREF_RC2") return { eligible: false as const, code: "PREPAID_VIA_REFREF_RC2_HUMAN_HANDOFF" };
  return { eligible: false as const, code: "CONTOUR_UNKNOWN_HUMAN_HANDOFF" };
}

function insertFact(db: Database.Database, fact: Omit<ServiceRenderedFact, "schema">) {
  db.prepare(`INSERT INTO lab_service_renditions(order_line_id,occurrence_ref,basis,attestation_reason,rendered_at,evidence_ref,recorded_by,recorded_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(fact.orderLineId, fact.occurrenceRef, fact.basis, fact.attestationReason, fact.renderedAt,
    fact.evidenceRef, fact.recordedBy, fact.recordedAt);
  db.prepare("INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?, 'LAB_SERVICE_RENDERED','ORDER_LINE',?,?,?)")
    .run(randomUUID(), fact.recordedBy, fact.orderLineId, JSON.stringify({ occurrenceRef: fact.occurrenceRef, basis: fact.basis,
      attestationReason: fact.attestationReason, evidenceRef: fact.evidenceRef }), fact.recordedAt);
}

/**
 * Records SERVICE_RENDERED for every checked-in paid line of an ended occurrence. Each fact cites the
 * ticket's use record. Other lines are reported for review (a no-show is never closed by default).
 */
export function recordCheckedInServiceRendered(db: Database.Database, command: { occurrenceRef: string; recordedBy: string }, now: string) {
  const recordedBy = command.recordedBy?.trim() || fail("LAB_COMMAND_INVALID");
  return db.transaction(() => {
    const occurrence = db.prepare("SELECT lifecycle,ends_at FROM lab_occurrences WHERE occurrence_ref=?").get(command.occurrenceRef) as
      { lifecycle: string; ends_at: string } | undefined;
    if (!occurrence) fail("LAB_OCCURRENCE_NOT_FOUND");
    if (labOccurrenceCancellationState(db, command.occurrenceRef) !== "NONE") fail("LAB_OCCURRENCE_CANCELLED");
    if (Date.parse(occurrence!.ends_at) > Date.parse(now)) fail("LAB_SERVICE_NOT_FINISHED");
    const lines = db.prepare(`${LINE_FACTS} AND product.occurrence_ref=? ORDER BY orders.created_at,line.id`).all(command.occurrenceRef) as LineFacts[];
    const recorded: string[] = [], replayed: string[] = [], review: ServiceRenderedReview[] = [];
    for (const line of lines) {
      if (serviceRenderedFact(db, line.line_id)) { replayed.push(line.line_id); continue; }
      if (["EXPIRED", "CANCELLED", "REFUNDED"].includes(line.order_state)) continue; // Nothing paid or kept.
      const code = refusal(line, now) ?? (line.ticket_used_at ? null : "NO_SHOW_REVIEW");
      if (code) { review.push({ orderPublicId: line.order_public_id, orderLineId: line.line_id, code }); continue; }
      insertFact(db, { orderLineId: line.line_id, occurrenceRef: line.occurrence_ref, basis: "CHECKED_IN", attestationReason: null,
        renderedAt: line.ticket_used_at!, evidenceRef: `lab-ticket:${line.ticket_id}:used`, recordedBy, recordedAt: now });
      recorded.push(line.line_id);
    }
    return { occurrenceRef: command.occurrenceRef, recorded, replayed, review };
  }).immediate();
}

/**
 * One explicit attendance attestation for one line whose ticket was not scanned. Idempotent for the
 * same reason; a different later attestation never rewrites the first.
 */
export function attestLabAttendance(db: Database.Database, command: { orderLineId: string; reason: string; recordedBy: string }, now: string) {
  const recordedBy = command.recordedBy?.trim() || fail("LAB_COMMAND_INVALID");
  if (!(ATTENDANCE_ATTESTATION_REASONS as readonly string[]).includes(command.reason)) fail("LAB_ATTESTATION_REASON_INVALID");
  return db.transaction(() => {
    const existing = serviceRenderedFact(db, command.orderLineId);
    if (existing) {
      if (existing.basis === "ATTENDED_ATTESTED" && existing.attestationReason === command.reason) return { fact: existing, replayed: true };
      return fail("LAB_SERVICE_RENDERED_ALREADY_RECORDED");
    }
    const line = db.prepare(`${LINE_FACTS} AND line.id=?`).get(command.orderLineId) as LineFacts | undefined;
    if (!line) fail("LAB_ORDER_LINE_NOT_FOUND");
    const code = refusal(line!, now);
    if (code) fail(`LAB_ATTESTATION_REFUSED_${code}`);
    // A scanned ticket is CHECKED_IN, recorded from its own evidence, never attested over.
    if (line!.ticket_used_at) fail("LAB_ATTESTATION_REFUSED_CHECKED_IN");
    const fact = { orderLineId: line!.line_id, occurrenceRef: line!.occurrence_ref, basis: "ATTENDED_ATTESTED" as const,
      attestationReason: command.reason as AttendanceAttestationReason, renderedAt: line!.ends_at,
      evidenceRef: `control-room:${recordedBy}:${now}`, recordedBy, recordedAt: now };
    insertFact(db, fact);
    return { fact: { schema: SERVICE_RENDERED_SCHEMA, ...fact }, replayed: false };
  }).immediate();
}

/**
 * E Q4: the target is a fact on the day of `ends_at`; an ended occurrence with paid lines still
 * without a fact after 24 hours alerts, and so does a review older than 24 hours.
 */
export function labServiceRenderedBacklog(db: Database.Database, now: string) {
  const lines = db.prepare(`${LINE_FACTS} AND line.id NOT IN (SELECT order_line_id FROM lab_service_renditions)
    AND julianday(occurrence.ends_at)<=julianday(?) AND orders.state NOT IN ('EXPIRED','CANCELLED','REFUNDED')
    ORDER BY occurrence.ends_at,line.id`).all(now) as LineFacts[];
  const overdueAt = (endsAt: string) => Date.parse(endsAt) + 24 * 3600_000 <= Date.parse(now);
  return lines.map(line => ({ occurrenceRef: line.occurrence_ref, orderPublicId: line.order_public_id, orderLineId: line.line_id,
    endsAt: line.ends_at, code: refusal(line, now) ?? (line.ticket_used_at ? "CHECKED_IN_NOT_RECORDED" : "NO_SHOW_REVIEW"),
    alert: overdueAt(line.ends_at) }));
}
