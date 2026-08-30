import { readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { id } from "./crypto";

/**
 * Outbox authority control.
 *
 * Two capabilities, and deliberately not a third:
 *
 *   fence / unfence email dispatch   here
 *   observe the control state        here
 *   LEGACY -> ATTEMPT activation     ./outbox-activation.ts
 *
 * The separation is not tidiness. 0040 shipped to production alone, with the
 * activation transition deliberately absent and `attempt_authority` structurally
 * pinned to LEGACY, so that the fence could be proven against the worker already
 * running there before any authority could move. Activation arrived only with
 * the attempt table and the attempt-aware writers that can receive it, and it
 * stays out of this module so that reviewing the fence never means reviewing the
 * flip.
 */

export type OutboxAuthorityState = {
  attempt_authority: "LEGACY" | "ATTEMPT";
  email_dispatch_paused: boolean;
  dispatch_owner_release_id: string | null;
  dispatch_owner_generation: number | null;
  revision: number;
};

/**
 * The epoch that holds the fence. Without it the durable authority belongs to
 * whoever holds the release-control credential rather than to the cutover that
 * acquired it, and CAS does not help: a second controller can read the current
 * revision and unfence in the middle of the first one's migration.
 */
export type DispatchEpoch = { release_id: string; generation: number | null };

export class OutboxAuthorityError extends Error {
  /**
   * `detail` never reaches the wire - the response body carries `code` alone -
   * but a refusal that cannot say WHICH object was missing costs an operator a
   * manual schema diff in the middle of a cutover.
   */
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Fail closed: a missing control row means dispatch is fenced, never open. */
export const outboxAuthority = (db: Database.Database): OutboxAuthorityState => {
  const row = db.prepare(`SELECT attempt_authority, email_dispatch_paused, dispatch_owner_release_id,
    dispatch_owner_generation, revision FROM outbox_authority WHERE singleton = 1`).get() as Record<string, unknown> | undefined;
  // Fail closed, and identically to the database trigger, which COALESCEs a
  // missing row to fenced for exactly the same reason.
  if (!row) return { attempt_authority: "LEGACY", email_dispatch_paused: true, dispatch_owner_release_id: null, dispatch_owner_generation: null, revision: 0 };
  return {
    attempt_authority: row.attempt_authority === "ATTEMPT" ? "ATTEMPT" : "LEGACY",
    email_dispatch_paused: Number(row.email_dispatch_paused ?? 1) === 1,
    dispatch_owner_release_id: row.dispatch_owner_release_id === null || row.dispatch_owner_release_id === undefined ? null : String(row.dispatch_owner_release_id),
    dispatch_owner_generation: row.dispatch_owner_generation === null || row.dispatch_owner_generation === undefined ? null : Number(row.dispatch_owner_generation),
    revision: Number(row.revision ?? 0),
  };
};

export type AuthorityEvent = {
  action: string;
  owner_release_id: string;
  owner_generation: number | null;
  reason: string;
  revision: number;
  created_at: string;
};

/**
 * The most recent authority transition, for the cutover controller.
 *
 * Without it "the activation was recorded" is asserted only by the code that
 * wrote the record - the controller would be trusting the same transaction it
 * is supposed to be verifying from outside.
 */
export const lastAuthorityEvent = (db: Database.Database): AuthorityEvent | null =>
  (db.prepare(`SELECT action, owner_release_id, owner_generation, reason, revision, created_at
    FROM outbox_authority_events ORDER BY revision DESC, created_at DESC LIMIT 1`).get() as AuthorityEvent | undefined) ?? null;

export const emailDispatchFenced = (db: Database.Database): boolean => outboxAuthority(db).email_dispatch_paused;

const sameEpoch = (state: OutboxAuthorityState, epoch: DispatchEpoch) =>
  state.dispatch_owner_release_id === epoch.release_id
  && (state.dispatch_owner_generation ?? null) === (epoch.generation ?? null);

const setDispatchFence = (
  db: Database.Database,
  paused: boolean,
  input: { expected_revision: number; reason: string },
  epoch: DispatchEpoch,
): OutboxAuthorityState => {
  const current = outboxAuthority(db);

  // A fence held by another epoch is never touched, in either direction. This
  // is the case CAS cannot cover: a second controller reading the current
  // revision would otherwise be able to unfence in the middle of the first
  // one's migration.
  if (current.email_dispatch_paused && !sameEpoch(current, epoch)) {
    throw new OutboxAuthorityError("OUTBOX_DISPATCH_OWNER_CONFLICT", 409);
  }

  // Idempotent replay: the same epoch asking for the state it already holds is
  // reconciliation, not a conflict, and must not consume a revision.
  if (current.email_dispatch_paused === paused && (!paused || sameEpoch(current, epoch))) return current;

  const changed = db.prepare(`UPDATE outbox_authority
    SET email_dispatch_paused = ?,
        dispatch_owner_release_id = ?, dispatch_owner_generation = ?,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE singleton = 1 AND revision = ?`)
    .run(paused ? 1 : 0, paused ? epoch.release_id : null, paused ? epoch.generation ?? null : null, input.expected_revision);
  if (changed.changes !== 1) throw new OutboxAuthorityError("OUTBOX_AUTHORITY_REVISION_CONFLICT", 409);

  const next = outboxAuthority(db);
  db.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, owner_generation, reason, revision)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id(), paused ? "DISPATCH_FENCED" : "DISPATCH_UNFENCED", epoch.release_id, epoch.generation ?? null, input.reason, next.revision);
  return next;
};

export const fenceEmailDispatch = (db: Database.Database, input: { expected_revision: number; reason: string }, epoch: DispatchEpoch) =>
  setDispatchFence(db, true, input, epoch);

export const unfenceEmailDispatch = (db: Database.Database, input: { expected_revision: number; reason: string }, epoch: DispatchEpoch) =>
  setDispatchFence(db, false, input, epoch);

/**
 * Drain evidence, separate from exclusion evidence.
 *
 * This says the last dispatch finished. It says nothing about whether another
 * can start - that is what the database trigger establishes. Reporting them as
 * one fact is the mistake this pair exists to prevent.
 */
export const emailDispatchDrained = (db: Database.Database): { drained: boolean; sending: number; leased: number } => {
  const sending = Number((db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'SENDING'").get() as { n: number }).n);
  const leased = Number((db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE lease_owner IS NOT NULL").get() as { n: number }).n);
  return { drained: sending === 0 && leased === 0, sending, leased };
};

/**
 * Forward compatibility guard.
 *
 * A build must not dispatch mail against a schema it does not understand. The
 * assertion is a set comparison, not a comparison of heads: schema_migrations
 * already stores applied versions as a set, and the release machinery hashes
 * the whole sorted inventory rather than trusting one filename. "Head is newer"
 * is a proxy, and proxies for real properties are what this codebase keeps
 * finding to be subtly wrong.
 *
 * Returns the applied versions this build has never heard of.
 */
export const unknownAppliedMigrations = (
  db: Database.Database,
  migrationsDir = join(process.cwd(), "commerce", "migrations"),
): string[] => {
  let known: Set<string>;
  try {
    known = new Set(readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")));
  } catch {
    // A build that cannot read its own migrations cannot prove compatibility.
    return ["MIGRATIONS_DIRECTORY_UNREADABLE"];
  }
  const applied = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>;
  return applied.map((row) => row.version).filter((version) => !known.has(version)).sort();
};
