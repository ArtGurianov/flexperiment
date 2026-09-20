import type Database from "better-sqlite3";
import { id } from "../../src/crypto";
import { FEATURE_STATE_EVENT_NOW, agentReferralsFeatureState, type AgentReferralsFeatureStateRow } from "../../src/agent-referrals-feature-state";

/**
 * Test fixture setup only, and only for the very first transition.
 *
 * Production has no DORMANT -> ACTIVE command after Phase 5, so a fixture that
 * needs an owned ACTIVE row materializes the historical pre-baseline row
 * directly. That is legitimate exactly once: it stands in for a migration, not
 * for an operation.
 *
 * It deliberately refuses to act as a general state machine. Reusing it to
 * resume after a real SUSPENDED would append a second `DORMANT -> ACTIVE`
 * event, and the 0049 lineage trigger correctly rejects that with
 * AGENT_REFERRALS_FEATURE_STATE_EVENT_LINEAGE_INCONSISTENT. Tests that resume
 * must call the real `reactivateAgentReferrals()`.
 */
export const materializeInitialActiveFeatureForTest = (
  db: Database.Database,
  input: { expected_revision: number; owner_id: string; reason: string },
): AgentReferralsFeatureStateRow => {
  const stored = db.prepare("SELECT state, revision FROM agent_referrals_feature_state WHERE singleton = 1")
    .get() as { state: string; revision: number } | undefined;
  if (!stored) throw new Error("test fixture feature-state missing");
  if (stored.state === "ACTIVE") return agentReferralsFeatureState(db);
  if (stored.state !== "DORMANT") throw new Error(`test fixture may only materialize from DORMANT, not ${stored.state} - use reactivateAgentReferrals()`);
  const events = db.prepare("SELECT COUNT(*) AS count FROM agent_referrals_feature_state_events").get() as { count: number };
  if (events.count !== 0) throw new Error("test fixture may only materialize an empty event log - use reactivateAgentReferrals()");
  if (stored.revision !== input.expected_revision) throw new Error("test fixture feature-state revision mismatch");
  const changed = db.prepare(`UPDATE agent_referrals_feature_state
    SET state = 'ACTIVE', owner_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE singleton = 1 AND revision = ?`).run(input.owner_id, input.expected_revision);
  if (changed.changes !== 1) throw new Error("test fixture feature-state materialization conflict");
  const state = agentReferralsFeatureState(db);
  db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision, created_at)
    VALUES (?, 'DORMANT', 'ACTIVE', ?, ?, ?, ${FEATURE_STATE_EVENT_NOW})`)
    .run(id(), input.owner_id, input.reason, state.revision);
  return state;
};
