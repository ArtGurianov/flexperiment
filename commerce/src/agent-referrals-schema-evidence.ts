import type Database from "better-sqlite3";

/**
 * An immutable store for operational evidence that must never be silently
 * rewritten: the payout-profile encryption key id, the ORD provider profile id.
 *
 * This file used to do a second job. It carried a list of every schema object
 * Agent Referrals needs and a list of the migrations that created them, and
 * asserted both were present. The second list could not survive the launch
 * baseline - a launch database records one applied version, not thirteen - so
 * the assertion could never pass again, and nothing called it: the controller
 * that did was deleted with the activation machinery it served. Both lists are
 * gone. A database of the wrong lineage is refused before anything reaches
 * here, which is a stronger answer than enumerating what it ought to contain.
 *
 * The table is still called `agent_referrals_activation_manifest`, which is an
 * activation-era name for something that outlived activation. Renaming it is a
 * baseline change and has not been made for a comment's sake.
 */

export class AgentReferralsSchemaEvidenceError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * The manifest table's evidence reader/writer. Read-only for PR3: nothing in
 * this PR has evidence to record, but future PRs (payout-profile key id,
 * ORD provider profile id) write here without a schema ALTER.
 */
export const agentReferralsEvidence = (db: Database.Database, key: string): unknown => {
  const row = db.prepare("SELECT value_json FROM agent_referrals_activation_manifest WHERE key = ?").get(key) as
    { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) : undefined;
};

/** Recursive sorted-key JSON, so semantically identical values compare equal regardless of key insertion order. */
export const canonicalAgentReferralsEvidenceJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalAgentReferralsEvidenceJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalAgentReferralsEvidenceJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export class AgentReferralsEvidenceConflictError extends AgentReferralsSchemaEvidenceError {
  constructor(readonly key: string) {
    super("AGENT_REFERRALS_SCHEMA_EVIDENCE_CONFLICT", 409, key);
  }
}

/**
 * Insert-only: pinned evidence (a payout-profile encryption key id, say) is
 * never silently overwritten. Recording the exact same value again is an
 * idempotent no-op; recording a different value for a key that already has
 * one is refused - the plan's own language is "pinned in the activation
 * manifest", not "the current value of". A future PR that genuinely needs
 * rotation gets its own explicit version/supersession semantics rather than
 * this store growing a generic overwrite.
 */
export const recordAgentReferralsEvidence = (db: Database.Database, key: string, value: unknown): void => {
  const run = db.transaction(() => {
    recordAgentReferralsEvidenceInTransaction(db, key, value);
  });
  run.immediate();
};

/** Same immutable insert contract, usable by a combined authority command. */
export const recordAgentReferralsEvidenceInTransaction = (db: Database.Database, key: string, value: unknown): void => {
  const existing = db.prepare("SELECT value_json FROM agent_referrals_activation_manifest WHERE key = ?").get(key) as
    { value_json: string } | undefined;
  if (existing) {
    if (canonicalAgentReferralsEvidenceJson(JSON.parse(existing.value_json)) === canonicalAgentReferralsEvidenceJson(value)) return;
    throw new AgentReferralsEvidenceConflictError(key);
  }
  db.prepare("INSERT INTO agent_referrals_activation_manifest(key, value_json, recorded_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
.run(key, JSON.stringify(value));
};
