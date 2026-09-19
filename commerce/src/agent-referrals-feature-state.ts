import type Database from "better-sqlite3";
import { id } from "./crypto";

/**
 * Agent Referrals feature-state authority.
 *
 * Mirrors outbox-authority.ts's setDispatchFence exactly: owner-conflict
 * refusal before any CAS, idempotent same-owner replay that consumes no
 * revision, a CAS UPDATE restating every precondition, and a sub-second
 * audit event in the same transaction.
 *
 * The runtime has one operational lifecycle: ACTIVE <-> SUSPENDED. The
 * historical DORMANT value remains in the pre-baseline schema until P9, but is
 * interpreted as ACTIVE so it no longer gates real business actions.
 */

export type AgentReferralsFeatureStateName = "DORMANT" | "ACTIVE" | "SUSPENDED";

export type AgentReferralsFeatureStateRow = {
  state: AgentReferralsFeatureStateName;
  owner_id: string | null;
  revision: number;
};

/**
 * Sub-second precision for the same reason AUTHORITY_EVENT_NOW exists in
 * outbox-authority.ts: deterministic ordering below one second matters for
 * concurrent-writer proofs, and the column's CURRENT_TIMESTAMP default only
 * has second precision.
 */
export const FEATURE_STATE_EVENT_NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

export class AgentReferralsFeatureError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Reads the pre-baseline physical state without granting it operational meaning. */
const storedFeatureState = (db: Database.Database): AgentReferralsFeatureStateRow | null => {
  const row = db.prepare("SELECT state, owner_id, revision FROM agent_referrals_feature_state WHERE singleton = 1").get() as
    Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    state: String(row.state) as AgentReferralsFeatureStateName,
    owner_id: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    revision: Number(row.revision ?? 0),
  };
};

/** A missing or DORMANT historical row is operationally ACTIVE until P9. */
export const agentReferralsFeatureState = (db: Database.Database): AgentReferralsFeatureStateRow => {
  const stored = storedFeatureState(db);
  if (!stored) return { state: "ACTIVE", owner_id: null, revision: 0 };
  return { ...stored, state: stored.state === "SUSPENDED" ? "SUSPENDED" : "ACTIVE" };
};

/** The only operational edges. DORMANT remains only in the physical schema. */
const LEGAL_EDGES: Record<Exclude<AgentReferralsFeatureStateName, "DORMANT">, ReadonlySet<AgentReferralsFeatureStateName>> = {
  ACTIVE: new Set(["SUSPENDED"]),
  SUSPENDED: new Set(["ACTIVE"]),
};

export type AgentReferralsFeatureTransitionInput = {
  expected_revision: number;
  owner_id: string;
  reason: string;
};

/**
 * The CAS UPDATE and the audit INSERT must commit together or not at all -
 * a state mutation with no corresponding audit evidence, or an audit event
 * for a revision a concurrent writer has already moved past, are both
 * refused by the plan's contract. Callable from inside an already-open
 * transaction (better-sqlite3 nests via SAVEPOINT, and `.immediate()` is
 * simply inert on a nested call), which is what lets a future combined
 * command run "assert readiness, then transition" as one atomic unit
 * without this module knowing anything about that command.
 */
export const transitionAgentReferralsFeatureInTransaction = (
  db: Database.Database,
  to: AgentReferralsFeatureStateName,
  input: AgentReferralsFeatureTransitionInput,
): AgentReferralsFeatureStateRow => {
  let stored = storedFeatureState(db);
  if (!stored) throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_STATE_MISSING", 409);
  let current = agentReferralsFeatureState(db);

  // A state held by another owner is never touched, in either direction -
  // the case CAS cannot cover, exactly as in outbox-authority.ts.
  if (current.owner_id !== null && current.owner_id !== input.owner_id) {
    throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_OWNER_CONFLICT", 409);
  }

  // Idempotent replay: the same owner asking for the state it already holds
  // is reconciliation, not a conflict, and must not consume a revision.
  if (current.state === to && current.owner_id === input.owner_id) return current;

  if (input.expected_revision !== stored.revision) {
    throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_REVISION_CONFLICT", 409);
  }

  // P9 drops DORMANT from the schema. Before then, a first suspension has to
  // materialize the old row as ACTIVE so the existing lineage trigger can
  // record the real ACTIVE -> SUSPENDED lifecycle. This is a physical-schema
  // compatibility step, not an operational DORMANT decision.
  if (stored.state === "DORMANT") {
    if (to === "ACTIVE") return current;
    const materialized = db.prepare(`UPDATE agent_referrals_feature_state
      SET state = 'ACTIVE', owner_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE singleton = 1 AND revision = ?`).run(input.owner_id, stored.revision);
    if (materialized.changes !== 1) throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_REVISION_CONFLICT", 409);
    stored = storedFeatureState(db)!;
    db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision, created_at)
      VALUES (?, 'DORMANT', 'ACTIVE', ?, ?, ?, ${FEATURE_STATE_EVENT_NOW})`)
      .run(id(), input.owner_id, "P5_PREBASELINE_ACTIVE", stored.revision);
    current = agentReferralsFeatureState(db);
  }

  if (!LEGAL_EDGES[current.state as "ACTIVE" | "SUSPENDED"].has(to)) {
    throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_ILLEGAL_TRANSITION", 409, `${current.state}->${to}`);
  }

  const changed = db.prepare(`UPDATE agent_referrals_feature_state
    SET state = ?, owner_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE singleton = 1 AND revision = ?`)
    .run(to, input.owner_id, stored.revision);
  if (changed.changes !== 1) throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_REVISION_CONFLICT", 409);

  const next = agentReferralsFeatureState(db);
  db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ${FEATURE_STATE_EVENT_NOW})`)
    .run(id(), stored.state, to, input.owner_id, input.reason, next.revision);
  return next;
};

const transition = (db: Database.Database, to: AgentReferralsFeatureStateName, input: AgentReferralsFeatureTransitionInput) =>
  db.transaction(() => transitionAgentReferralsFeatureInTransaction(db, to, input)).immediate();

/**
 * Historical compatibility helper for databases that still store DORMANT.
 */
export const activateAgentReferrals = (db: Database.Database, input: AgentReferralsFeatureTransitionInput) =>
  agentReferralsFeatureState(db).state === "ACTIVE"
    ? agentReferralsFeatureState(db)
    : transition(db, "ACTIVE", input);

/**
 * Historical compatibility helper for pre-baseline databases.
 */
export const activateAgentReferralsInTransaction = (db: Database.Database, input: AgentReferralsFeatureTransitionInput) =>
  agentReferralsFeatureState(db).state === "ACTIVE"
    ? agentReferralsFeatureState(db)
    : transitionAgentReferralsFeatureInTransaction(db, "ACTIVE", input);

export const suspendAgentReferrals = (db: Database.Database, input: AgentReferralsFeatureTransitionInput) =>
  transition(db, "SUSPENDED", input);

/** SUSPENDED -> ACTIVE only. Reactivation never auto-reactivates anything else. */
export const reactivateAgentReferrals = (db: Database.Database, input: AgentReferralsFeatureTransitionInput) =>
  transition(db, "ACTIVE", input);

/**
 * The global feature state AS OF a given instant - resolved from
 * agent_referrals_feature_state_events, never the current live row. Used
 * by distribution's historical-authority resolver (Phase 5 holistic
 * review, P0 finding 1): a publication's `published_at` may fall inside a
 * window where the feature was globally SUSPENDED at the time, even
 * though the feature is ACTIVE again by the time the fact is reported or
 * corrected - NEW_PUBLICATION_AUTHORITY must be judged against the state
 * that actually held at that instant, not the state now. julianday() -
 * never a raw TEXT comparison - matches every other historical-instant
 * comparison in this schema. Before the first historical event, the canonical
 * operational state is ACTIVE.
 */
export const agentReferralsFeatureStateAt = (db: Database.Database, atIso: string): AgentReferralsFeatureStateName => {
  const row = db.prepare(`SELECT to_state FROM agent_referrals_feature_state_events
    WHERE julianday(created_at) <= julianday(?) ORDER BY julianday(created_at) DESC, revision DESC LIMIT 1`)
    .get(atIso) as { to_state: string } | undefined;
  if (!row) return "ACTIVE";
  return row.to_state === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";
};

export const lastAgentReferralsFeatureStateEvent = (db: Database.Database) =>
  (db.prepare(`SELECT id, from_state, to_state, owner_id, reason, revision, created_at
    FROM agent_referrals_feature_state_events ORDER BY revision DESC, created_at DESC LIMIT 1`).get() as
    Record<string, unknown> | undefined) ?? null;
