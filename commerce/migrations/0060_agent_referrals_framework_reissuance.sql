-- Reissuance and evidence authority (PR2 of the agreement-authority
-- program). Decided model: issuance pins the offer, acceptance pins the
-- legal-profile revision actually presented and accepted. There is exactly
-- one ordinal in this subsystem - `sequence` on the offer stream
-- (framework_issuances) - and resolution is derived, never a stored
-- pointer:
--
--   required issuance    = MAX(sequence) in framework_issuances for the partner
--   effective acceptance = framework_acceptances JOIN framework_issuances
--                             ON issuance.id = acceptance.issuance_id
--                           ORDER BY issuance.sequence DESC LIMIT 1
--
-- Zero-data precondition, ahead of the first destructive statement, in the
-- exact 0058 style: historical rows cannot be backfilled honestly (which
-- legal profile was actually displayed to a partner is unrecoverable), and
-- no issuance or acceptance exists in production yet, so this migration
-- REFUSES to run against a database that already has any - it never tries
-- to migrate them.
CREATE TEMP TABLE _0060_zero_data_guard (
  row_count INTEGER NOT NULL,
  CONSTRAINT PR2_REISSUANCE_MIGRATION_REQUIRES_ZERO_EXISTING_EVIDENCE CHECK (row_count = 0)
);
INSERT INTO _0060_zero_data_guard(row_count)
  SELECT (SELECT COUNT(*) FROM framework_issuances)
       + (SELECT COUNT(*) FROM framework_acceptances)
       + (SELECT COUNT(*) FROM ord_reporting_delegations);
DROP TABLE _0060_zero_data_guard;

-- Every table dropped below is proven empty by the guard above (and, since
-- engagement_activation_events.framework_acceptance_id/
-- ord_reporting_delegation_id and ord_reporting_delegation_revocations.
-- ord_reporting_delegation_id are NOT NULL foreign keys into these tables,
-- an empty framework_acceptances/ord_reporting_delegations transitively
-- proves those referencing tables are empty too) - so this is a plain
-- drop-and-recreate, not the temp-table-and-swap dance 0058/0059 need for a
-- column change on a table that still holds data. No FK-off registration
-- is needed: PRAGMA foreign_key_check below (implicitly, via the ordinary
-- migration path) has nothing to find a violation in.
DROP TRIGGER framework_issuances_immutable_guard;
DROP TRIGGER framework_issuances_delete_guard;
DROP TRIGGER framework_acceptances_immutable_guard;
DROP TRIGGER framework_acceptances_delete_guard;
DROP TRIGGER ord_reporting_delegations_immutable_guard;
DROP TRIGGER ord_reporting_delegations_delete_guard;

DROP TABLE ord_reporting_delegations;
DROP TABLE framework_acceptances;
DROP TABLE framework_issuances;

-- 1. Framework issuance: append-only per partner, never a single pinned
-- pair - `sequence` is the whole offer-stream ordinal. Re-offering an
-- older template revision pair is simply a new row with a higher sequence,
-- so `MAX(sequence)` stays correct without any pointer rollback.
CREATE TABLE framework_issuances (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  sequence INTEGER NOT NULL,
  framework_agreement_revision_id TEXT NOT NULL REFERENCES framework_agreement_revisions(id),
  delegation_template_revision_id TEXT NOT NULL REFERENCES delegation_template_revisions(id),
  issued_by_admin_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, sequence)
);
CREATE TRIGGER framework_issuances_immutable_guard
BEFORE UPDATE ON framework_issuances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ISSUANCE_IMMUTABLE'); END;
CREATE TRIGGER framework_issuances_delete_guard
BEFORE DELETE ON framework_issuances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ISSUANCE_IMMUTABLE'); END;

-- 2. Framework acceptance: pins the issuance actually accepted and the
-- legal-profile revision actually presented and accepted at that moment -
-- never "current", resolved later. UNIQUE(partner_identity_id, issuance_id)
-- is the whole idempotency key: at most one acceptance per issuance, so an
-- exact retry (same issuance) hits the same row, and a genuinely different
-- (later) issuance is always a distinct row, never a silently-overwritten
-- one. No sequence column of its own - order comes from the issuance an
-- acceptance accepted, via the join above.
CREATE TABLE framework_acceptances (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  issuance_id TEXT NOT NULL REFERENCES framework_issuances(id),
  legal_profile_revision_id TEXT NOT NULL REFERENCES agent_referrals_legal_profile_revisions(id),
  step_up_grant_id TEXT NOT NULL UNIQUE REFERENCES step_up_grants(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, issuance_id)
);
CREATE TRIGGER framework_acceptances_immutable_guard
BEFORE UPDATE ON framework_acceptances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_IMMUTABLE'); END;
CREATE TRIGGER framework_acceptances_delete_guard
BEFORE DELETE ON framework_acceptances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_IMMUTABLE'); END;

-- Structural consistency guard: an acceptance's issuance must belong to the
-- SAME partner as the acceptance itself. FKs alone would permit an
-- authority bundle assembled from two different partners (an acceptance
-- row for partner A pointing at partner B's issuance) - this proves the
-- tuple's MEANING, not merely that both ids resolve to some row each.
CREATE TRIGGER framework_acceptances_issuance_partner_consistency_guard
BEFORE INSERT ON framework_acceptances
WHEN NOT EXISTS (
  SELECT 1 FROM framework_issuances fi
  WHERE fi.id = NEW.issuance_id AND fi.partner_identity_id = NEW.partner_identity_id
)
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_ISSUANCE_PARTNER_MISMATCH'); END;

-- Structural consistency guard: the accepted legal-profile revision must
-- belong to the SAME partner's agent_id - never a revision minted for a
-- different agent's legal identity.
CREATE TRIGGER framework_acceptances_legal_profile_partner_consistency_guard
BEFORE INSERT ON framework_acceptances
WHEN NOT EXISTS (
  SELECT 1 FROM agent_referrals_legal_profile_revisions lp
  JOIN partner_identities pi ON pi.agent_id = lp.agent_id
  WHERE lp.id = NEW.legal_profile_revision_id AND pi.id = NEW.partner_identity_id
)
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_LEGAL_PROFILE_PARTNER_MISMATCH'); END;

-- 3. Effective ORD delegation this acceptance creates: one row PER
-- ACCEPTANCE now, not per partner (framework_acceptance_id stays UNIQUE,
-- but partner_identity_id no longer is) - a reissued/reaccepted partner
-- gets a second delegation row alongside the first. No auto-revocation on
-- reissuance: revocation stays a deliberate act
-- (agent-referrals-delegation-revocation.ts); a later acceptance never
-- implicitly revokes an earlier delegation - only isDelegationEffective's
-- own resolution (application code) decides which one currently matters.
CREATE TABLE ord_reporting_delegations (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  framework_acceptance_id TEXT NOT NULL UNIQUE REFERENCES framework_acceptances(id),
  delegation_template_revision_id TEXT NOT NULL REFERENCES delegation_template_revisions(id),
  ord_reporting_mode TEXT NOT NULL CHECK (ord_reporting_mode = 'FLEXPERIMENT_DELEGATED'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER ord_reporting_delegations_immutable_guard
BEFORE UPDATE ON ord_reporting_delegations
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_IMMUTABLE'); END;
CREATE TRIGGER ord_reporting_delegations_delete_guard
BEFORE DELETE ON ord_reporting_delegations
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_IMMUTABLE'); END;

-- Structural consistency guard: a delegation's acceptance must belong to
-- the SAME partner as the delegation itself.
CREATE TRIGGER ord_reporting_delegations_acceptance_partner_consistency_guard
BEFORE INSERT ON ord_reporting_delegations
WHEN NOT EXISTS (
  SELECT 1 FROM framework_acceptances fa
  WHERE fa.id = NEW.framework_acceptance_id AND fa.partner_identity_id = NEW.partner_identity_id
)
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_DELEGATION_ACCEPTANCE_PARTNER_MISMATCH'); END;
