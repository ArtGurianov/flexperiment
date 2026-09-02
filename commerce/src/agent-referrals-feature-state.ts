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
 * DORMANT is the unowned default - like outbox's unpaused state - and owner
 * conflict is checked only once the singleton is owned (state != DORMANT).
 * The legal graph never re-admits DORMANT: it exists only as PR3's shipped
 * starting point, never as a transition target.
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

/** Fail closed: a missing control row means DORMANT and unowned, never ACTIVE. */
export const agentReferralsFeatureState = (db: Database.Database): AgentReferralsFeatureStateRow => {
  const row = db.prepare("SELECT state, owner_id, revision FROM agent_referrals_feature_state WHERE singleton = 1").get() as
    Record<string, unknown> | undefined;
  if (!row) return { state: "DORMANT", owner_id: null, revision: 0 };
  return {
    state: row.state === "ACTIVE" || row.state === "SUSPENDED" ? row.state : "DORMANT",
    owner_id: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    revision: Number(row.revision ?? 0),
  };
};

/**
 * The only legal edges. DORMANT never appears as a value: nothing may
 * transition back to it, and PR3 ships it only as the initial row.
 */
const LEGAL_EDGES: Record<AgentReferralsFeatureStateName, ReadonlySet<AgentReferralsFeatureStateName>> = {
  DORMANT: new Set(["ACTIVE"]),
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
const transitionInTransaction = (
  db: Database.Database,
  to: AgentReferralsFeatureStateName,
  input: AgentReferralsFeatureTransitionInput,
): AgentReferralsFeatureStateRow => {
  const current = agentReferralsFeatureState(db);

  // A state held by another owner is never touched, in either direction -
  // the case CAS cannot cover, exactly as in outbox-authority.ts.
  if (current.state !== "DORMANT" && current.owner_id !== input.owner_id) {
    throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_OWNER_CONFLICT", 409);
  }

  // Idempotent replay: the same owner asking for the state it already holds
  // is reconciliation, not a conflict, and must not consume a revision.
  if (current.state === to && current.owner_id === input.owner_id) return current;

  if (!LEGAL_EDGES[current.state].has(to)) {
    throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_ILLEGAL_TRANSITION", 409, `${current.state}->${to}`);
  }

  const changed = db.prepare(`UPDATE agent_referrals_feature_state
    SET state = ?, owner_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE singleton = 1 AND revision = ?`)
    .run(to, input.owner_id, input.expected_revision);
  if (changed.changes !== 1) throw new AgentReferralsFeatureError("AGENT_REFERRALS_FEATURE_REVISION_CONFLICT", 409);

  const next = agentReferralsFeatureState(db);
  db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ${FEATURE_STATE_EVENT_NOW})`)
    .run(id(), current.state, to, input.owner_id, input.reason, next.revision);
  return next;
};

const transition = (db: Database.Database, to: AgentReferralsFeatureStateName, input: AgentReferralsFeatureTransitionInput) =>
  db.transaction(() => transitionInTransaction(db, to, input)).immediate();

/**
 * DORMANT -> ACTIVE only. PR3 ships DORMANT and calls this from nowhere -
 * activation is gated behind a future readiness assertion
 * (assert-agent-referrals-activation-ready) that does not exist yet, and
 * this function is deliberately not wired to any HTTP route.
 */
export const activateAgentReferrals = (db: Database.Database, input: AgentReferralsFeatureTransitionInput) =>
  transition(db, "ACTIVE", input);

export const suspendAgentReferrals = (db: Database.Database, input: AgentReferralsFeatureTransitionInput) =>
  transition(db, "SUSPENDED", input);

/** SUSPENDED -> ACTIVE only. Reactivation never auto-reactivates anything else. */
export const reactivateAgentReferrals = (db: Database.Database, input: AgentReferralsFeatureTransitionInput) =>
  transition(db, "ACTIVE", input);

export const lastAgentReferralsFeatureStateEvent = (db: Database.Database) =>
  (db.prepare(`SELECT id, from_state, to_state, owner_id, reason, revision, created_at
    FROM agent_referrals_feature_state_events ORDER BY revision DESC, created_at DESC LIMIT 1`).get() as
    Record<string, unknown> | undefined) ?? null;
