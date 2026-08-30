import { readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { id } from "./crypto";

/**
 * Outbox authority control.
 *
 * Two capabilities, and deliberately not a third:
 *
 *   fence / unfence email dispatch   shipped here
 *   observe the control state        shipped here
 *   LEGACY -> ATTEMPT activation     NOT shipped, by design
 *
 * The activation transition belongs to the release that introduces the attempt
 * table and attempt-aware writers. Shipping it now would put a transition in
 * production capable of freezing legacy attempt writes while nothing else can
 * receive them.
 */

export type OutboxAuthorityState = {
  attempt_authority: "LEGACY" | "ATTEMPT";
  email_dispatch_paused: boolean;
  revision: number;
};

export class OutboxAuthorityError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
  }
}

/** Fail closed: a missing control row means dispatch is fenced, never open. */
export const outboxAuthority = (db: Database.Database): OutboxAuthorityState => {
  const row = db.prepare("SELECT attempt_authority, email_dispatch_paused, revision FROM outbox_authority WHERE singleton = 1").get() as
    { attempt_authority?: unknown; email_dispatch_paused?: unknown; revision?: unknown } | undefined;
  if (!row) return { attempt_authority: "LEGACY", email_dispatch_paused: true, revision: 0 };
  return {
    attempt_authority: row.attempt_authority === "ATTEMPT" ? "ATTEMPT" : "LEGACY",
    email_dispatch_paused: Number(row.email_dispatch_paused ?? 1) === 1,
    revision: Number(row.revision ?? 0),
  };
};

export const emailDispatchFenced = (db: Database.Database): boolean => outboxAuthority(db).email_dispatch_paused;

const setDispatchFence = (
  db: Database.Database,
  paused: boolean,
  input: { expected_revision: number; reason: string },
  actor: string,
): OutboxAuthorityState => {
  const current = outboxAuthority(db);
  // Idempotent: asking for the state it is already in is not a conflict, and a
  // retried operator command must not consume a revision.
  if (current.email_dispatch_paused === paused && current.revision === input.expected_revision) return current;

  const changed = db.prepare(`UPDATE outbox_authority
    SET email_dispatch_paused = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE singleton = 1 AND revision = ?`).run(paused ? 1 : 0, input.expected_revision);
  if (changed.changes !== 1) throw new OutboxAuthorityError("OUTBOX_AUTHORITY_REVISION_CONFLICT", 409);

  const next = outboxAuthority(db);
  db.prepare("INSERT INTO outbox_authority_events(id, action, actor, reason, revision) VALUES (?, ?, ?, ?, ?)")
    .run(id(), paused ? "DISPATCH_FENCED" : "DISPATCH_UNFENCED", actor, input.reason, next.revision);
  return next;
};

export const fenceEmailDispatch = (db: Database.Database, input: { expected_revision: number; reason: string }, actor: string) =>
  setDispatchFence(db, true, input, actor);

export const unfenceEmailDispatch = (db: Database.Database, input: { expected_revision: number; reason: string }, actor: string) =>
  setDispatchFence(db, false, input, actor);

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
