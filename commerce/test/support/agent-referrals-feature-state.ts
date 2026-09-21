import type Database from "better-sqlite3";
import { agentReferralsFeatureState, type AgentReferralsFeatureStateRow } from "../../src/agent-referrals-feature-state";

/**
 * Test fixture setup only, and now almost nothing.
 *
 * The launch baseline seeds `ACTIVE` at revision 1, so the state a fixture used
 * to have to manufacture exists from birth. This remains as the one place that
 * says so, rather than deleting the call from thirty fixtures and leaving no
 * record of why they no longer need it.
 *
 * It deliberately refuses to act as a general state machine: tests that resume
 * after a real SUSPENDED must call `reactivateAgentReferrals()`.
 */
export const materializeInitialActiveFeatureForTest = (
  db: Database.Database,
  input: { expected_revision: number; owner_id: string; reason: string },
): AgentReferralsFeatureStateRow => {
  const stored = db.prepare("SELECT state, revision FROM agent_referrals_feature_state WHERE singleton = 1")
    .get() as { state: string; revision: number } | undefined;
  if (!stored) throw new Error("test fixture feature-state missing");
  if (stored.state !== "ACTIVE") throw new Error(`test fixture expects a seeded ACTIVE row, not ${stored.state} - use reactivateAgentReferrals()`);
  if (stored.revision !== input.expected_revision) throw new Error("test fixture feature-state revision mismatch");
  return agentReferralsFeatureState(db);
};
