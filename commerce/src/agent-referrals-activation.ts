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
  "partner_identity_events",
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
  // PR5 (0045). Every base table PR5 ships, named alongside its guards
  // exactly like PR4's list above - a dropped base table is exactly as
  // unsound as a dropped guard. engagements and engagement_step_up_grants
  // carry no immutable-evidence guards (they are mutable-authority tables,
  // like partner_sessions/step_up_grants in PR4); engagement_distributions
  // is a bare identity table with no guards of its own (its revisions and
  // events carry the immutability). The partial unique indexes enforcing
  // "at most one current X" are named alongside their tables for the same
  // reason PR4's active-unique indexes are: the structural invariant they
  // carry is not implied by the bare table existing.
  "partner_audience_verification_events",
  "partner_audience_verification_events_immutable_guard",
  "partner_audience_verification_events_delete_guard",
  "engagements",
  "engagement_revisions",
  "engagement_revisions_immutable_guard",
  "engagement_revisions_delete_guard",
  "engagement_step_up_grants",
  "engagement_acceptances",
  "engagement_acceptances_immutable_guard",
  "engagement_acceptances_delete_guard",
  "partner_promos",
  "partner_promos_immutable_guard",
  "partner_promos_delete_guard",
  "engagement_promo_authorizations",
  "engagement_promo_authorizations_current_unique",
  "engagement_promo_authorizations_placement_immutable_guard",
  "engagement_promo_authorizations_revoke_one_way_guard",
  "engagement_promo_authorizations_delete_guard",
  "engagement_activation_events",
  "engagement_activation_events_immutable_guard",
  "engagement_activation_events_delete_guard",
  "engagement_creative_revisions",
  "engagement_creative_revisions_immutable_guard",
  "engagement_creative_revisions_delete_guard",
  "engagement_creative_authorizations",
  "engagement_creative_authorizations_current_unique",
  "engagement_creative_authorizations_placement_immutable_guard",
  "engagement_creative_authorizations_revoke_one_way_guard",
  "engagement_creative_authorizations_delete_guard",
  "engagement_distributions",
  "engagement_distribution_revisions",
  "engagement_distribution_revisions_immutable_guard",
  "engagement_distribution_revisions_delete_guard",
  "engagement_distribution_events",
  "engagement_distribution_events_immutable_guard",
  "engagement_distribution_events_delete_guard",
  "ord_reporting_delegation_revocations",
  "ord_reporting_delegation_revocations_immutable_guard",
  "ord_reporting_delegation_revocations_delete_guard",
  "engagement_closure_events",
  "engagement_closure_events_immutable_guard",
  "engagement_closure_events_delete_guard",
  // PR6 (0046). The order-authority-tuple triggers on the pre-existing
  // `orders` table are named alongside the two new registry/effective
  // tables, for the same reason PR4/PR5's own guards are: a dropped
  // trigger is exactly as unsound as a dropped base table, and `orders`
  // itself already appears nowhere in this list (it predates Agent
  // Referrals and is not itself an Agent-Referrals-owned object), so only
  // the new triggers it gained are named here, not the table. Likewise
  // `referral_rewards` gains two guards without itself being named (it
  // predates Agent Referrals too). Every relational-consistency guard
  // (holistic review, Phase 6) is named alongside its table's existing
  // guards for the identical reason.
  "orders_authority_tuple_consistency_guard",
  "orders_authority_columns_immutable_guard",
  "referral_rewards_authority_kind_matches_order_guard",
  "referral_rewards_authority_kind_immutable_guard",
  "engagement_reward_registry_snapshot",
  "engagement_reward_registry_snapshot_relational_consistency_guard",
  "engagement_reward_registry_snapshot_immutable_guard",
  "engagement_reward_registry_snapshot_delete_guard",
  "engagement_effective_reward_snapshots",
  "engagement_effective_reward_snapshots_relational_consistency_guard",
  "engagement_effective_reward_snapshots_immutable_guard",
  "engagement_effective_reward_snapshots_delete_guard",
  // PR7 (0047). reward_settlements predates Agent Referrals (like `orders`
  // in PR6) and is not itself named here - only the new triggers/index it
  // gained are. Every other object PR7 ships is named alongside its own
  // guards, for the identical reason PR4-PR6's own lists are.
  "reward_settlements_authority_tuple_consistency_guard",
  "reward_settlements_authority_columns_immutable_guard",
  "reward_settlements_effective_snapshot_unique",
  "reward_settlements_agent_referrals_status_transition_guard",
  "reward_settlements_agent_referrals_terminal_immutable_guard",
  "engagement_effective_reward_snapshots_no_correction_during_live_payment_guard",
  "settlement_step_up_grants",
  "settlement_acts",
  "settlement_acts_relational_consistency_guard",
  "settlement_acts_fields_immutable_guard",
  "settlement_acts_presented_one_way_guard",
  "settlement_acts_delete_guard",
  "settlement_act_acceptances",
  "settlement_act_acceptances_relational_consistency_guard",
  "settlement_act_acceptances_immutable_guard",
  "settlement_act_acceptances_delete_guard",
  "settlement_act_disputes",
  "settlement_act_disputes_relational_consistency_guard",
  "settlement_act_disputes_immutable_guard",
  "settlement_act_disputes_delete_guard",
  "npd_status_checks",
  "npd_status_checks_immutable_guard",
  "npd_status_checks_delete_guard",
  "payment_authorizations",
  "payment_authorizations_relational_consistency_guard",
  "payment_authorizations_immutable_guard",
  "payment_authorizations_delete_guard",
  "payment_attempts",
  "payment_attempts_active_unique",
  "payment_attempts_relational_consistency_guard",
  "payment_attempts_identity_immutable_guard",
  "payment_attempts_terminal_immutable_guard",
  "payment_attempts_transition_legality_guard",
  "payment_attempts_delete_guard",
  "npd_receipts",
  "npd_receipts_relational_consistency_guard",
  "npd_receipts_immutable_guard",
  "npd_receipts_delete_guard",
  "engagement_zero_reward_closures",
  "engagement_zero_reward_closures_relational_consistency_guard",
  "engagement_zero_reward_closures_immutable_guard",
  "engagement_zero_reward_closures_delete_guard",
  "engagement_recovery_exposure_evidence",
  "engagement_recovery_exposure_evidence_relational_consistency_guard",
  "engagement_recovery_exposure_evidence_immutable_guard",
  "engagement_recovery_exposure_evidence_delete_guard",
  // PR8 (0048). Every object PR8 ships is named here, matching PR4-PR7's
  // own lists - a dropped base table is exactly as unsound as a dropped
  // guard, so both are named.
  "ord_provider_profile_revisions",
  "ord_provider_profile_revisions_immutable_guard",
  "ord_provider_profile_revisions_delete_guard",
  "ord_provider_profile_revisions_lineage_guard",
  "ord_reporting_period_policy",
  "ord_reporting_period_policy_immutable_guard",
  "ord_reporting_period_policy_delete_guard",
  // Round-2 P0.1 fix: provider-operation authority for counterparty/
  // platform/contract/media - a durable manual operation record, distinct
  // from the immutable profile CONTENT above.
  "ord_provider_operations",
  "ord_provider_operations_relational_consistency_guard",
  "ord_provider_operations_terminal_immutable_guard",
  "ord_provider_operations_correction_only_guard",
  "ord_provider_operations_authority_immutable_guard",
  "ord_provider_operations_observed_id_immutable_guard",
  "ord_provider_operations_delete_guard",
  // Round-2 P0.2/P0.3 fix: ord_creative_registrations is now a revision
  // chain (creative_revision_id, revision) with a CORRECTION_ONLY lock
  // state between MUTABLE and EXTERNALLY_LOCKED.
  "ord_creative_registrations",
  "ord_creative_registrations_relational_consistency_guard",
  "ord_creative_registrations_terminal_immutable_guard",
  "ord_creative_registrations_correction_only_guard",
  "ord_creative_registrations_authority_immutable_guard",
  "ord_creative_registrations_observed_ids_immutable_guard",
  "ord_creative_registrations_delete_guard",
  "ord_distribution_period_reports",
  "ord_distribution_period_reports_relational_consistency_guard",
  "ord_distribution_period_reports_immutable_guard",
  "ord_distribution_period_reports_delete_guard",
  "ord_paid_invoice_payloads",
  "ord_paid_invoice_payloads_relational_consistency_guard",
  "ord_paid_invoice_payloads_terminal_immutable_guard",
  "ord_paid_invoice_payloads_authority_immutable_guard",
  "ord_paid_invoice_payloads_observed_id_immutable_guard",
  "ord_paid_invoice_payloads_delete_guard",
] as const;

const MIGRATIONS = ["0043_agent_referrals_foundation.sql", "0044_partner_identity.sql", "0045_engagement_publication.sql", "0046_attribution_reward.sql", "0047_act_payment_settlement.sql", "0048_ord_reporting.sql"] as const;

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
