import type Database from "better-sqlite3";

/**
 * Agent Referrals activation-manifest / schema-evidence machinery.
 *
 * `agent_referrals_activation_manifest` is system-wide evidence only - an
 * open key/evidence store, not fixed columns, because most of what will be
 * pinned here (the payout-profile encryption key id, the ORD provider
 * profile id, ...) belongs to PR4/PR8 and does not exist yet. PR3 writes no
 * evidence into it.
 *
 * The required-schema-object list follows REQUIRED_SCHEMA_OBJECTS in
 * outbox-activation.ts exactly: named by sqlite_master identity, not by
 * "does a same-named table exist" - a bare table is a proxy for the
 * enforcement that actually matters (the immutability guards, the
 * catch-all-can-never-be-ALLOWED check, the exact-key uniqueness), and the
 * counterexample outbox-activation.ts documents is cheap here too: drop
 * agent_referrals_legal_profile_revisions_immutable_guard and the table
 * still accepts UPDATEs that rewrite filed evidence.
 *
 * This is deliberately NOT the DORMANT -> ACTIVE readiness gate - that is a
 * future assert-agent-referrals-activation-ready this PR does not build, and
 * will additionally require PR4-PR8 objects that do not exist yet. This
 * module only proves "PR3's own foundation schema is intact", which is a
 * necessary but explicitly incomplete precondition.
 */

export const AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS = [
  "agent_referrals_feature_state",
  "agent_referrals_feature_state_events",
  "agent_referrals_activation_manifest",
  "agent_referrals_legal_profile_revisions",
  "agent_referrals_legal_profile_revisions_immutable_guard",
  "agent_referrals_legal_profile_revisions_delete_guard",
  "framework_agreement_revisions",
  "framework_agreement_revisions_immutable_guard",
  "framework_agreement_revisions_delete_guard",
  "delegation_template_revisions",
  "delegation_template_revisions_immutable_guard",
  "delegation_template_revisions_delete_guard",
  "ad_channel_policy",
  "ad_channel_policy_channel_revision_unique",
  "ad_channel_policy_immutable_guard",
  "ad_channel_policy_delete_guard",
  // PR4 (0044). Every table PR4 ships is named here - both the immutable
  // evidence tables (with their UPDATE+DELETE guards) and the mutable
  // authority tables (invite capabilities, OTP challenges, sessions,
  // step-up grants, legal holds), because a base TABLE dropped entirely
  // (e.g. DROP TABLE partner_sessions) is exactly as unsound as a guard
  // dropped off an evidence table it once protected - and until this list
  // named the base tables too, only the six evidence tables' guards were
  // checked, so a dropped partner_sessions or step_up_grants would have
  // passed this assertion silently. The partial-unique indexes enforcing
  // "at most one live X per identity" are named alongside their tables for
  // the same reason a dropped guard trigger is unsound: the structural
  // invariant they carry is not implied by the bare table existing.
  "partner_identities",
  "partner_identity_events_immutable_guard",
  "partner_identity_events_delete_guard",
  "partner_invite_capabilities",
  "partner_invite_capabilities_active_unique",
  "partner_otp_challenges",
  "partner_otp_challenges_active_unique",
  "partner_sessions",
  "step_up_grants",
  "framework_issuances",
  "framework_issuances_immutable_guard",
  "framework_issuances_delete_guard",
  "framework_acceptances",
  "framework_acceptances_immutable_guard",
  "framework_acceptances_delete_guard",
  "ord_reporting_delegations",
  "ord_reporting_delegations_immutable_guard",
  "ord_reporting_delegations_delete_guard",
  "payout_profile_revisions",
  "payout_profile_revisions_immutable_guard",
  "payout_profile_revisions_delete_guard",
  "partner_identity_retention_policies",
  "partner_identity_retention_policies_immutable_guard",
  "partner_identity_retention_policies_delete_guard",
  "partner_identity_legal_holds",
  "partner_identity_legal_holds_active_unique",
  "partner_identity_legal_holds_placement_immutable_guard",
  "partner_identity_legal_holds_release_one_way_guard",
  "partner_identity_legal_holds_delete_guard",
  "partner_identity_destruction_events",
  "partner_identity_destruction_events_immutable_guard",
  "partner_identity_destruction_events_delete_guard",
] as const;

const MIGRATIONS = ["0043_agent_referrals_foundation.sql", "0044_partner_identity.sql"] as const;

export class AgentReferralsActivationError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const missingSchemaObjects = (db: Database.Database): string[] => {
  const placeholders = AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS.map(() => "?").join(", ");
  const found = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${placeholders})`)
    .all(...AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS) as Array<{ name: string }>).map((row) => row.name));
  return AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS.filter((name) => !found.has(name));
};

/**
 * Fails closed and names exactly which object(s) are missing - a refusal
 * that cannot say which object is gone costs an operator a manual schema
 * diff, same rationale as outbox-activation.ts's assertSchemaPresent().
 */
const missingMigrations = (db: Database.Database): string[] =>
  MIGRATIONS.filter((migration) => !db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(migration));

export const assertAgentReferralsFoundationSchemaPresent = (db: Database.Database): void => {
  const missingApplied = missingMigrations(db);
  if (missingApplied.length) throw new AgentReferralsActivationError("AGENT_REFERRALS_ACTIVATION_SCHEMA_MISSING", 409, missingApplied.join(", "));

  const missing = missingSchemaObjects(db);
  if (missing.length) throw new AgentReferralsActivationError("AGENT_REFERRALS_ACTIVATION_SCHEMA_INCOMPLETE", 409, missing.join(", "));
};

export type AgentReferralsFoundationSchemaEvidence = {
  present: boolean;
  missing: string[];
};

/** Read-only, non-throwing counterpart for a controller that wants evidence rather than an exception. */
export const agentReferralsFoundationSchemaEvidence = (db: Database.Database): AgentReferralsFoundationSchemaEvidence => {
  const missingApplied = missingMigrations(db);
  if (missingApplied.length) return { present: false, missing: missingApplied };
  const missing = missingSchemaObjects(db);
  return { present: missing.length === 0, missing };
};

/**
 * The manifest table's evidence reader/writer. Read-only for PR3: nothing in
 * this PR has evidence to record, but future PRs (payout-profile key id,
 * ORD provider profile id) write here without a schema ALTER.
 */
export const agentReferralsActivationEvidence = (db: Database.Database, key: string): unknown => {
  const row = db.prepare("SELECT value_json FROM agent_referrals_activation_manifest WHERE key = ?").get(key) as
    { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) : undefined;
};

/** Recursive sorted-key JSON, so semantically identical values compare equal regardless of key insertion order. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export class AgentReferralsActivationEvidenceConflictError extends AgentReferralsActivationError {
  constructor(readonly key: string) {
    super("AGENT_REFERRALS_ACTIVATION_EVIDENCE_CONFLICT", 409, key);
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
export const recordAgentReferralsActivationEvidence = (db: Database.Database, key: string, value: unknown): void => {
  const run = db.transaction(() => {
    const existing = db.prepare("SELECT value_json FROM agent_referrals_activation_manifest WHERE key = ?").get(key) as
      { value_json: string } | undefined;
    if (existing) {
      if (canonicalJson(JSON.parse(existing.value_json)) === canonicalJson(value)) return; // idempotent replay
      throw new AgentReferralsActivationEvidenceConflictError(key);
    }
    db.prepare("INSERT INTO agent_referrals_activation_manifest(key, value_json, recorded_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(key, JSON.stringify(value));
  });
  run.immediate();
};
