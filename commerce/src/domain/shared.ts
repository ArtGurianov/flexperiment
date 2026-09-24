import type Database from "better-sqlite3";
import { parseLegalManifest, type LegalManifest } from "../legal-manifest";

export type Row = Record<string, unknown>;

export type OccurrenceCustomerSnapshot = {
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  venue_status: "CONFIRMED" | "TO_BE_ANNOUNCED";
  venue_name: string | null;
  venue_address: string | null;
  venue_disclosure_text: string | null;
  venue_announce_by: string | null;
};

export const occurrenceCustomerSnapshot = (value: Row): OccurrenceCustomerSnapshot => ({
  title: String(value.title),
  starts_at: String(value.starts_at),
  ends_at: String(value.ends_at),
  timezone: String(value.timezone),
  venue_status: value.venue_status === "CONFIRMED" ? "CONFIRMED" : "TO_BE_ANNOUNCED",
  venue_name: value.venue_name == null ? null : String(value.venue_name),
  venue_address: value.venue_address == null ? null : String(value.venue_address),
  venue_disclosure_text: value.venue_disclosure_text == null ? null : String(value.venue_disclosure_text),
  venue_announce_by: value.venue_announce_by == null ? null : String(value.venue_announce_by),
});

export const isOccurrenceCustomerSnapshot = (value: unknown): value is OccurrenceCustomerSnapshot => {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.title === "string"
    && typeof snapshot.starts_at === "string"
    && typeof snapshot.ends_at === "string"
    && typeof snapshot.timezone === "string"
    && (snapshot.venue_status === "CONFIRMED" || snapshot.venue_status === "TO_BE_ANNOUNCED")
    && [null, "string"].includes(snapshot.venue_name === null ? null : typeof snapshot.venue_name)
    && [null, "string"].includes(snapshot.venue_address === null ? null : typeof snapshot.venue_address)
    && [null, "string"].includes(snapshot.venue_disclosure_text === null ? null : typeof snapshot.venue_disclosure_text)
    && [null, "string"].includes(snapshot.venue_announce_by === null ? null : typeof snapshot.venue_announce_by);
};

export const CITY_INTEREST_SWEEP_BATCH_SIZE = 50;

export const one = <T extends Row>(db: Database.Database, sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...params) as T | undefined;

export const many = <T extends Row>(db: Database.Database, sql: string, ...params: unknown[]) =>
  db.prepare(sql).all(...params) as T[];

export class DomainError extends Error {
  constructor(readonly code: string, readonly status = 400, message = code, readonly details?: Record<string, unknown>) { super(message); }
}

export const legalManifest = (raw: unknown): LegalManifest => {
  try { return parseLegalManifest(raw); }
  catch { throw new DomainError("LEGAL_RELEASE_INVALID", 503); }
};

/**
 * An IMMEDIATE transaction - or, inside one already open, a savepoint in it.
 *
 * The nested case is real: a certification checkout spends its capability and
 * creates its order in one transaction, opened by the checkout authority, and
 * the order is created by `checkout`, which takes this lock itself. A second
 * `BEGIN` there is refused by SQLite ("cannot start a transaction within a
 * transaction"), so no certification checkout could ever have committed. Joining
 * the caller's transaction is what that design asked for: the outer transaction
 * decides the commit, and a failure in here still undoes only its own work
 * before it propagates.
 */
export function withImmediateTransaction<T>(db: Database.Database, operation: () => T): T {
  if (db.inTransaction) {
    db.exec("SAVEPOINT with_immediate_transaction");
    try { const result = operation(); db.exec("RELEASE with_immediate_transaction"); return result; }
    catch (error) { db.exec("ROLLBACK TO with_immediate_transaction"); db.exec("RELEASE with_immediate_transaction"); throw error; }
  }
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
