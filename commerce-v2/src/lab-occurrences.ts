import { CheckoutConflictError } from "./checkout-conflict";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * LAB cities and occurrences on the v2 model (ART-199, design 2026-10-18 §1.4 and §4).
 *
 * An occurrence has a lifecycle, never a sales status: selling is `offers.sale_mode` plus
 * the admission below. Finished is derived from `ends_at`. Changes that would rewrite what a
 * buyer was promised (schedule, venue) are refused once a seat is committed; they belong to
 * the move/cancel workflow (ART-203), as does cancelling an occurrence with committed seats.
 */

export type VenueDisclosure =
  | { readonly status: "CONFIRMED"; readonly name: string; readonly address: string; readonly public: boolean }
  | { readonly status: "TO_BE_ANNOUNCED"; readonly disclosureText: string; readonly announceBy: string };

/** The venue a buyer is promised; whether the catalogue shows it publicly is not part of the promise. */
export type BuyerVenueDisclosure =
  | { readonly status: "CONFIRMED"; readonly name: string; readonly address: string }
  | { readonly status: "TO_BE_ANNOUNCED"; readonly disclosureText: string; readonly announceBy: string };

export type LabOccurrencePhase = "SCHEDULED" | "IN_PROGRESS" | "FINISHED" | "CANCELLED";
export type LabVisibility = "LISTED" | "UNLISTED";

export type LabOccurrenceRow = {
  id: string; occurrence_ref: string; city_id: string; title: string; starts_at: string; ends_at: string; timezone: string;
  capacity: number; admin_reserved_seats: number; version: number; material_revision: number;
  lifecycle: "SCHEDULED" | "CANCELLED"; cancelled_at: string | null; cancellation_reason: string | null; visibility: LabVisibility;
  venue_status: VenueDisclosure["status"] | null; venue_name: string | null; venue_address: string | null; venue_public: 0 | 1;
  venue_disclosure_text: string | null; venue_announce_by: string | null;
};

export type LabSeatInventory = {
  readonly capacity: number;
  readonly adminReservedSeats: number;
  /** Paid seats, including a paid order whose refund is still in progress. */
  readonly sold: number;
  /** Seats of orders whose payment may still settle; no TTL frees them, only a final outcome. */
  readonly pending: number;
  readonly customerCommitted: number;
  readonly available: number;
};

const REF = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEXT_LIMIT = 500;

const requiredText = (value: unknown, code: string, limit = TEXT_LIMIT) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit) throw new Error(code);
  return value.trim();
};

/** Whole-second UTC instants, the form Refref accepts for service dates. */
export const occurrenceInstant = (value: unknown, code = "LAB_OCCURRENCE_TIME_INVALID") => {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCMilliseconds() !== 0) throw new Error(code);
  return parsed.toISOString().replace(".000Z", "Z");
};

const validTimezone = (value: unknown) => {
  const timezone = requiredText(value, "LAB_OCCURRENCE_TIMEZONE_INVALID", 64);
  try { new Intl.DateTimeFormat("ru-RU", { timeZone: timezone }); }
  catch { throw new Error("LAB_OCCURRENCE_TIMEZONE_INVALID"); }
  return timezone;
};

const seatCount = (value: unknown, minimum: number, code: string) => {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > 100_000) throw new Error(code);
  return value as number;
};

const venueColumns = (venue: VenueDisclosure, startsAt: string) => {
  if (venue?.status === "CONFIRMED") {
    if (typeof venue.public !== "boolean") throw new Error("LAB_VENUE_INVALID");
    return { venue_status: "CONFIRMED" as const, venue_name: requiredText(venue.name, "LAB_VENUE_CONFIRMATION_INCOMPLETE"),
      venue_address: requiredText(venue.address, "LAB_VENUE_CONFIRMATION_INCOMPLETE"), venue_public: venue.public ? 1 as const : 0 as const,
      venue_disclosure_text: null, venue_announce_by: null };
  }
  if (venue?.status === "TO_BE_ANNOUNCED") {
    const announceBy = occurrenceInstant(venue.announceBy, "LAB_VENUE_TBA_INCOMPLETE");
    if (Date.parse(announceBy) >= Date.parse(startsAt)) throw new Error("LAB_VENUE_ANNOUNCEMENT_TOO_LATE");
    return { venue_status: "TO_BE_ANNOUNCED" as const, venue_name: null, venue_address: null, venue_public: 0 as const,
      venue_disclosure_text: requiredText(venue.disclosureText, "LAB_VENUE_TBA_INCOMPLETE"), venue_announce_by: announceBy };
  }
  throw new Error("LAB_VENUE_INVALID");
};

/** What a buyer is told about the place; frozen into the order line, never re-read for an order. */
export const venueDisclosure = (row: Pick<LabOccurrenceRow, "venue_status" | "venue_name" | "venue_address"
  | "venue_public" | "venue_disclosure_text" | "venue_announce_by">): VenueDisclosure | null =>
  row.venue_status === "CONFIRMED"
    ? { status: "CONFIRMED", name: row.venue_name!, address: row.venue_address!, public: row.venue_public === 1 }
    : row.venue_status === "TO_BE_ANNOUNCED"
      ? { status: "TO_BE_ANNOUNCED", disclosureText: row.venue_disclosure_text!, announceBy: row.venue_announce_by! }
      : null;

export const occurrencePhase = (row: Pick<LabOccurrenceRow, "lifecycle" | "starts_at" | "ends_at">, now: string): LabOccurrencePhase =>
  row.lifecycle === "CANCELLED" ? "CANCELLED"
    : Date.parse(row.ends_at) <= Date.parse(now) ? "FINISHED"
      : Date.parse(row.starts_at) <= Date.parse(now) ? "IN_PROGRESS" : "SCHEDULED";

const occurrenceRow = (db: Database.Database, occurrenceRef: string) =>
  db.prepare("SELECT * FROM lab_occurrences WHERE occurrence_ref=?").get(occurrenceRef) as LabOccurrenceRow | undefined;

/**
 * The one seat partition. A seat is released only by a final order outcome (expired, declined,
 * refunded); any other or unknown state keeps it, so an uncertain payment never loses its seat.
 * ART-200 adds quote holds to `pending`.
 */
export function labSeatInventory(db: Database.Database, occurrence: Pick<LabOccurrenceRow, "occurrence_ref" | "capacity" | "admin_reserved_seats">): LabSeatInventory {
  const row = db.prepare(`SELECT
      COUNT(*) FILTER (WHERE orders.state NOT IN ('EXPIRED','CANCELLED','REFUNDED')) AS committed,
      COUNT(*) FILTER (WHERE orders.state IN ('FULFILLED','REFUND_PENDING')) AS sold
    FROM order_lines line JOIN orders ON orders.id=line.order_id JOIN products product ON product.id=line.product_id
    WHERE product.occurrence_ref=?`).get(occurrence.occurrence_ref) as { committed: number; sold: number };
  const customerCommitted = Number(row.committed);
  return { capacity: occurrence.capacity, adminReservedSeats: occurrence.admin_reserved_seats, sold: Number(row.sold),
    pending: customerCommitted - Number(row.sold), customerCommitted,
    available: occurrence.capacity - occurrence.admin_reserved_seats - customerCommitted };
}

const assertInventoryTarget = (inventory: LabSeatInventory, capacity: number, adminReservedSeats: number) => {
  if (capacity < inventory.customerCommitted) throw new Error("LAB_CAPACITY_BELOW_COMMITTED_SEATS");
  if (capacity < inventory.customerCommitted + adminReservedSeats) throw new Error("LAB_RESERVE_EXCEEDS_AVAILABLE_CAPACITY");
};

/**
 * Live admission of a LAB occurrence for a new quote or order: scheduled, not started, a declared
 * venue and a free seat. Visibility is not a sales control; an UNLISTED occurrence sells by link.
 */
export function assertLabOccurrenceAdmissible(db: Database.Database, occurrenceRef: string | null, now: string) {
  const row = occurrenceRef ? occurrenceRow(db, occurrenceRef) : undefined;
  if (!row) throw new CheckoutConflictError("LAB_OCCURRENCE_NOT_FOUND");
  const phase = occurrencePhase(row, now);
  if (phase === "CANCELLED") throw new CheckoutConflictError("LAB_OCCURRENCE_CANCELLED");
  if (phase !== "SCHEDULED") throw new CheckoutConflictError("LAB_OCCURRENCE_STARTED");
  const venue = venueDisclosure(row);
  if (!venue) throw new CheckoutConflictError("LAB_VENUE_UNDECLARED");
  if (labSeatInventory(db, row).available < 1) throw new CheckoutConflictError("LAB_OCCURRENCE_SOLD_OUT");
  const buyerVenue: BuyerVenueDisclosure = venue.status === "CONFIRMED"
    ? { status: venue.status, name: venue.name, address: venue.address } : venue;
  return { row, venue: buyerVenue };
}

/** The facts an order line freezes; a later edit never changes a sold seat's promise. */
const customerFacts = (row: LabOccurrenceRow) => ({
  title: row.title, startsAt: row.starts_at, endsAt: row.ends_at, timezone: row.timezone, venue: venueDisclosure(row),
});
const revisionFacts = (row: LabOccurrenceRow) => ({
  ...customerFacts(row), cityId: row.city_id, capacity: row.capacity, adminReservedSeats: row.admin_reserved_seats,
  visibility: row.visibility, lifecycle: row.lifecycle, cancellationReason: row.cancellation_reason,
});

const recordRevision = (db: Database.Database, input: {
  before: LabOccurrenceRow | null; after: LabOccurrenceRow; kind: "CREATED" | "EDITED" | "CANCELLED";
  changedFields: string[]; customerFacing: boolean; actor: string; reason: string; now: string;
}) => {
  db.prepare(`INSERT INTO lab_occurrence_revisions(id,occurrence_ref,version,material_revision,change_kind,customer_facing,
      changed_fields_json,before_json,after_json,actor,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), input.after.occurrence_ref, input.after.version, input.after.material_revision, input.kind,
      input.customerFacing ? 1 : 0, JSON.stringify(input.changedFields), input.before ? JSON.stringify(revisionFacts(input.before)) : null,
      JSON.stringify(revisionFacts(input.after)), input.actor, input.reason, input.now);
  db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomUUID(), input.actor, `LAB_OCCURRENCE_${input.kind}`, "LAB_OCCURRENCE", input.after.occurrence_ref,
      JSON.stringify({ version: input.after.version, changedFields: input.changedFields, reason: input.reason }), input.now);
};

export function createCity(db: Database.Database, command: { slug: string; title: string; actor: string }, now = new Date().toISOString()) {
  if (typeof command.slug !== "string" || !SLUG.test(command.slug)) throw new Error("CITY_SLUG_INVALID");
  const title = requiredText(command.title, "CITY_TITLE_INVALID", 120);
  const actor = requiredText(command.actor, "LAB_COMMAND_INVALID");
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM cities WHERE slug=?").get(command.slug)) throw new Error("CITY_SLUG_TAKEN");
    const cityId = randomUUID();
    db.prepare("INSERT INTO cities(id,slug,title,created_at) VALUES (?,?,?,?)").run(cityId, command.slug, title, now);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), actor, "CITY_CREATED", "CITY", command.slug, JSON.stringify({ title }), now);
    return { cityId, slug: command.slug, title };
  }).immediate();
}

/** A city keeps its slug forever; only its displayed title changes. */
export function renameCity(db: Database.Database, command: { slug: string; title: string; actor: string }, now = new Date().toISOString()) {
  const title = requiredText(command.title, "CITY_TITLE_INVALID", 120);
  const actor = requiredText(command.actor, "LAB_COMMAND_INVALID");
  return db.transaction(() => {
    const city = db.prepare("SELECT id,title FROM cities WHERE slug=?").get(command.slug) as { id: string; title: string } | undefined;
    if (!city) throw new Error("CITY_NOT_FOUND");
    if (city.title === title) return { cityId: city.id, slug: command.slug, title };
    db.prepare("UPDATE cities SET title=? WHERE id=?").run(title, city.id);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), actor, "CITY_RENAMED", "CITY", command.slug, JSON.stringify({ from: city.title, to: title }), now);
    return { cityId: city.id, slug: command.slug, title };
  }).immediate();
}

export type LabOccurrenceCreateCommand = {
  occurrenceRef: string; citySlug: string; title: string; startsAt: string; endsAt: string; timezone: string;
  capacity: number; adminReservedSeats?: number; venue: VenueDisclosure; actor: string; reason: string;
};

/** A new occurrence starts UNLISTED and SCHEDULED; its offer is configured separately (configureProduct). */
export function createLabOccurrence(db: Database.Database, command: LabOccurrenceCreateCommand, now = new Date().toISOString()) {
  if (typeof command.occurrenceRef !== "string" || !REF.test(command.occurrenceRef)) throw new Error("LAB_OCCURRENCE_REF_INVALID");
  if (typeof command.citySlug !== "string" || !SLUG.test(command.citySlug)) throw new Error("CITY_SLUG_INVALID");
  const title = requiredText(command.title, "LAB_OCCURRENCE_TITLE_INVALID", 200);
  const startsAt = occurrenceInstant(command.startsAt);
  const endsAt = occurrenceInstant(command.endsAt);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("LAB_OCCURRENCE_TIME_INVALID");
  if (Date.parse(startsAt) <= Date.parse(now)) throw new Error("LAB_OCCURRENCE_STARTS_IN_PAST");
  const timezone = validTimezone(command.timezone);
  const capacity = seatCount(command.capacity, 1, "LAB_CAPACITY_INVALID");
  const adminReservedSeats = seatCount(command.adminReservedSeats ?? 0, 0, "LAB_RESERVE_INVALID");
  if (adminReservedSeats > capacity) throw new Error("LAB_RESERVE_EXCEEDS_AVAILABLE_CAPACITY");
  const venue = venueColumns(command.venue, startsAt);
  const actor = requiredText(command.actor, "LAB_COMMAND_INVALID");
  const reason = requiredText(command.reason, "LAB_CHANGE_REASON_REQUIRED");
  return db.transaction(() => {
    const city = db.prepare("SELECT id FROM cities WHERE slug=?").get(command.citySlug) as { id: string } | undefined;
    if (!city) throw new Error("CITY_NOT_FOUND");
    if (occurrenceRow(db, command.occurrenceRef)) throw new Error("LAB_OCCURRENCE_REF_TAKEN");
    db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,admin_reserved_seats,
        venue_status,venue_name,venue_address,venue_public,venue_disclosure_text,venue_announce_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), command.occurrenceRef, city.id, title, startsAt, endsAt, timezone,
      capacity, adminReservedSeats, venue.venue_status, venue.venue_name, venue.venue_address, venue.venue_public,
      venue.venue_disclosure_text, venue.venue_announce_by, now, now);
    const after = occurrenceRow(db, command.occurrenceRef)!;
    recordRevision(db, { before: null, after, kind: "CREATED", changedFields: [], customerFacing: true, actor, reason, now });
    return { occurrenceRef: after.occurrence_ref, version: after.version };
  }).immediate();
}

export type LabOccurrencePatch = {
  title?: string; startsAt?: string; endsAt?: string; timezone?: string; capacity?: number; adminReservedSeats?: number;
  venue?: VenueDisclosure; visibility?: LabVisibility;
};

const SCHEDULE_FIELDS = ["starts_at", "ends_at", "timezone"] as const;
const VENUE_CONTRACT_FIELDS = ["venue_status", "venue_name", "venue_address", "venue_disclosure_text", "venue_announce_by"] as const;
const CUSTOMER_FACING_FIELDS = new Set<string>(["title", ...SCHEDULE_FIELDS, ...VENUE_CONTRACT_FIELDS]);
const EDITABLE_FIELDS = ["title", ...SCHEDULE_FIELDS, "capacity", "admin_reserved_seats", ...VENUE_CONTRACT_FIELDS,
  "venue_public", "visibility"] as const;

/**
 * Design §4 on the v2 model: description, price, capacity, reserve and publication stay free;
 * schedule and venue are free only while no seat is committed. A no-op patch changes nothing.
 */
export function editLabOccurrence(db: Database.Database, command: {
  occurrenceRef: string; expectedVersion: number; patch: LabOccurrencePatch; actor: string; reason: string;
}, now = new Date().toISOString()) {
  const actor = requiredText(command.actor, "LAB_COMMAND_INVALID");
  const reason = requiredText(command.reason, "LAB_CHANGE_REASON_REQUIRED");
  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1
    || !command.patch || typeof command.patch !== "object" || Array.isArray(command.patch)) throw new Error("LAB_COMMAND_INVALID");
  const unknown = Object.keys(command.patch).filter((key) => !["title", "startsAt", "endsAt", "timezone", "capacity",
    "adminReservedSeats", "venue", "visibility"].includes(key));
  if (unknown.length) throw new Error("LAB_COMMAND_INVALID");
  return db.transaction(() => {
    const before = occurrenceRow(db, command.occurrenceRef);
    if (!before) throw new Error("LAB_OCCURRENCE_NOT_FOUND");
    if (before.version !== command.expectedVersion) throw new Error("LAB_OCCURRENCE_VERSION_CONFLICT");
    const phase = occurrencePhase(before, now);
    if (phase === "CANCELLED") throw new Error("LAB_OCCURRENCE_CANCELLED");
    if (phase === "FINISHED") throw new Error("LAB_OCCURRENCE_FINISHED");
    const { patch } = command;
    const startsAt = patch.startsAt === undefined ? before.starts_at : occurrenceInstant(patch.startsAt);
    const endsAt = patch.endsAt === undefined ? before.ends_at : occurrenceInstant(patch.endsAt);
    const next: LabOccurrenceRow = {
      ...before,
      title: patch.title === undefined ? before.title : requiredText(patch.title, "LAB_OCCURRENCE_TITLE_INVALID", 200),
      starts_at: startsAt, ends_at: endsAt,
      timezone: patch.timezone === undefined ? before.timezone : validTimezone(patch.timezone),
      capacity: patch.capacity === undefined ? before.capacity : seatCount(patch.capacity, 1, "LAB_CAPACITY_INVALID"),
      admin_reserved_seats: patch.adminReservedSeats === undefined ? before.admin_reserved_seats
        : seatCount(patch.adminReservedSeats, 0, "LAB_RESERVE_INVALID"),
      visibility: patch.visibility === undefined ? before.visibility
        : patch.visibility === "LISTED" || patch.visibility === "UNLISTED" ? patch.visibility
          : (() => { throw new Error("LAB_VISIBILITY_INVALID"); })(),
      ...(patch.venue === undefined ? {} : venueColumns(patch.venue, startsAt)),
    };
    const changed = EDITABLE_FIELDS.filter((field) => next[field] !== before[field]);
    if (!changed.length) return { occurrenceRef: before.occurrence_ref, version: before.version, changed: false };
    if (Date.parse(next.ends_at) <= Date.parse(next.starts_at)) throw new Error("LAB_OCCURRENCE_TIME_INVALID");
    // A TBA deadline is checked against the start it would end up with, not the one sent.
    if (patch.venue === undefined && next.venue_status === "TO_BE_ANNOUNCED"
      && Date.parse(next.venue_announce_by!) >= Date.parse(next.starts_at)) throw new Error("LAB_VENUE_ANNOUNCEMENT_TOO_LATE");
    if (next.visibility === "LISTED" && !next.venue_status) throw new Error("LAB_VENUE_UNDECLARED");
    const inventory = labSeatInventory(db, before);
    const scheduleChanged = changed.some((field) => (SCHEDULE_FIELDS as readonly string[]).includes(field));
    if (scheduleChanged) {
      if (phase !== "SCHEDULED") throw new Error("LAB_OCCURRENCE_STARTED");
      if (inventory.customerCommitted > 0) throw new Error("LAB_OCCURRENCE_SCHEDULE_LOCKED");
      if (Date.parse(next.starts_at) <= Date.parse(now)) throw new Error("LAB_OCCURRENCE_STARTS_IN_PAST");
    }
    // A legacy row may still declare its first venue: nobody bought against an undeclared one.
    if (before.venue_status && inventory.customerCommitted > 0
      && changed.some((field) => (VENUE_CONTRACT_FIELDS as readonly string[]).includes(field))) {
      throw new Error("LAB_VENUE_CHANGE_REQUIRES_WORKFLOW");
    }
    if (next.admin_reserved_seats > next.capacity) throw new Error("LAB_RESERVE_EXCEEDS_AVAILABLE_CAPACITY");
    assertInventoryTarget(inventory, next.capacity, next.admin_reserved_seats);
    const customerFacing = changed.some((field) => CUSTOMER_FACING_FIELDS.has(field));
    const updated = db.prepare(`UPDATE lab_occurrences SET title=?,starts_at=?,ends_at=?,timezone=?,capacity=?,admin_reserved_seats=?,
        venue_status=?,venue_name=?,venue_address=?,venue_public=?,venue_disclosure_text=?,venue_announce_by=?,visibility=?,
        version=version+1,material_revision=material_revision+?,updated_at=? WHERE id=? AND version=?`)
      .run(next.title, next.starts_at, next.ends_at, next.timezone, next.capacity, next.admin_reserved_seats, next.venue_status,
        next.venue_name, next.venue_address, next.venue_public, next.venue_disclosure_text, next.venue_announce_by, next.visibility,
        customerFacing ? 1 : 0, now, before.id, before.version);
    if (updated.changes !== 1) throw new Error("LAB_OCCURRENCE_VERSION_CONFLICT");
    const after = occurrenceRow(db, command.occurrenceRef)!;
    recordRevision(db, { before, after, kind: "EDITED", changedFields: changed, customerFacing, actor, reason, now });
    return { occurrenceRef: after.occurrence_ref, version: after.version, changed: true };
  }).immediate();
}

/**
 * Cancels an occurrence nobody holds a seat in and closes its offer in the same transaction.
 * With a committed seat the cancellation must first settle open attempts and refunds (ART-203).
 */
export function cancelLabOccurrence(db: Database.Database, command: {
  occurrenceRef: string; expectedVersion: number; actor: string; reason: string;
}, now = new Date().toISOString()) {
  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) throw new Error("LAB_COMMAND_INVALID");
  const actor = requiredText(command.actor, "LAB_COMMAND_INVALID");
  const reason = requiredText(command.reason, "LAB_CHANGE_REASON_REQUIRED");
  return db.transaction(() => {
    const before = occurrenceRow(db, command.occurrenceRef);
    if (!before) throw new Error("LAB_OCCURRENCE_NOT_FOUND");
    if (before.version !== command.expectedVersion) throw new Error("LAB_OCCURRENCE_VERSION_CONFLICT");
    const phase = occurrencePhase(before, now);
    if (phase === "CANCELLED") throw new Error("LAB_OCCURRENCE_CANCELLED");
    if (phase === "FINISHED") throw new Error("LAB_OCCURRENCE_FINISHED");
    if (labSeatInventory(db, before).customerCommitted > 0) throw new Error("LAB_OCCURRENCE_HAS_COMMITTED_SEATS");
    const product = db.prepare("SELECT id FROM products WHERE occurrence_ref=?").get(command.occurrenceRef) as { id: string } | undefined;
    if (product) {
      db.prepare("UPDATE offers SET sale_mode='CLOSED',updated_at=? WHERE product_id=? AND sale_mode<>'CLOSED'").run(now, product.id);
      db.prepare("UPDATE products SET version=version+1,updated_at=? WHERE id=?").run(now, product.id);
    }
    const updated = db.prepare(`UPDATE lab_occurrences SET lifecycle='CANCELLED',cancelled_at=?,cancellation_reason=?,
        version=version+1,material_revision=material_revision+1,updated_at=? WHERE id=? AND version=?`)
      .run(now, reason, now, before.id, before.version);
    if (updated.changes !== 1) throw new Error("LAB_OCCURRENCE_VERSION_CONFLICT");
    const after = occurrenceRow(db, command.occurrenceRef)!;
    recordRevision(db, { before, after, kind: "CANCELLED", changedFields: ["lifecycle"], customerFacing: true, actor, reason, now });
    return { occurrenceRef: after.occurrence_ref, version: after.version, cancelledAt: now };
  }).immediate();
}
