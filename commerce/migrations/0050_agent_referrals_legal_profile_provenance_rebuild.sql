-- PR-D foundation: agent_referrals_legal_profile_revisions rebuilt to carry
-- assertion provenance (assertion_source, evidence_ref) as part of the
-- immutable revision itself, not as a mutable side table or a value the
-- caller merely narrates in `reason`. This is the prerequisite the
-- legal-profile supersession work (D2) builds on: a change-request
-- candidate needs to record WHO asserted a legal profile change and WHAT
-- evidence backs it, and that provenance must live on the same immutable
-- row the rest of the profile's authority already lives on - never bolted
-- on afterward as an annotation next to an immutable fact.
--
-- assertion_source is exhaustive: PARTNER_ASSERTED (the partner's own
-- onboarding submission, verified by an admin - the only production mint
-- path today, via verifyPartnerLegalProfile) or ADMIN_ASSERTED (an admin
-- acting on external evidence; not yet reachable from any route, wired by a
-- later PR). evidence_ref is optional for PARTNER_ASSERTED - the partner's
-- own submitted draft is already captured in partner_identities.submitted_
-- legal_form/_tax_mode and the LEGAL_PROFILE_SUBMITTED event, and is its
-- own evidence - but mandatory and non-blank for ADMIN_ASSERTED, matching
-- the evidence_ref discipline already established for act/payment evidence
-- (0047) and ORD reporting evidence (0048): a claim minted on an admin's
-- say-so must always name what backs it.
--
-- This is the second FK-off migration (see FK_OFF_MIGRATIONS in
-- commerce/src/db.ts). SQLite cannot add a CHECK constraint spanning
-- existing columns without recreating the table, and this table carries
-- three inbound FKs (engagement_activation_events.legal_profile_revision_id,
-- reward_settlements.legal_profile_revision_id_snapshot,
-- partner_identities.legal_profile_revision_id) plus its own self-
-- referencing supersedes_revision_id. The exact DROP-then-RENAME-INTO
-- pattern 0042 established - build the replacement under a temporary name,
-- DROP the original, then RENAME the replacement INTO the original's name -
-- is reused verbatim: renaming the ORIGINAL away (instead of dropping it)
-- would make SQLite's rename-tracking repoint every inbound FK, including
-- this table's own self-reference, at the vacated temporary name rather
-- than the rebuilt table; DROP-then-RENAME-INTO sidesteps that because none
-- of those FK clauses - not the three external tables', not this table's
-- own - ever stop naming `agent_referrals_legal_profile_revisions`, so
-- nothing needs rewriting once a table by that name exists again.
--
-- A second, distinct obstacle 0042 never had to face: SQLite's ALTER TABLE
-- RENAME TO does not only repoint bare `REFERENCES` clauses - empirically,
-- it also recompiles every OTHER trigger body anywhere in the schema that
-- textually names the table being renamed INTO, to keep it resolvable
-- under the new name. Three such triggers exist here, all defined on
-- OTHER tables and left untouched by 0043-0049, but each references this
-- table inside a JOIN or subquery rather than a `REFERENCES` clause:
-- reward_settlements_authority_tuple_consistency_guard and
-- reward_settlements_contractor_type_projection_guard (both on
-- reward_settlements), and agents_contractor_type_projection_guard (on
-- agents). Recompiling them happens mid-rename, at the instant the ALTER
-- TABLE statement runs - which is AFTER the old table has already been
-- DROPped and BEFORE the replacement has been renamed into place - so
-- without intervention that recompilation fails outright with "no such
-- table: main.agent_referrals_legal_profile_revisions", even though none
-- of the three is otherwise touched by this migration. They are therefore
-- DROPped just before the rename and CREATEd again, byte-for-byte
-- identical to 0047/0049, immediately after - never altered, only made to
-- survive the instant the referenced table does not exist.
DROP TRIGGER agents_contractor_type_projection_guard;
DROP TRIGGER reward_settlements_contractor_type_projection_guard;
DROP TRIGGER reward_settlements_authority_tuple_consistency_guard;

-- Existing legacy rows are backfilled as PARTNER_ASSERTED with evidence_ref
-- NULL: production's only mint path has always been partner-submitted-
-- then-admin-verified, so this is the true recorded provenance of every row
-- that predates this migration, not an invented one - and no evidence_ref
-- is fabricated to satisfy the ADMIN_ASSERTED branch, since no existing row
-- was ever admin-asserted.
CREATE TABLE agent_referrals_legal_profile_revisions_0050_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  revision INTEGER NOT NULL,
  legal_form TEXT NOT NULL CHECK (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR', 'LEGAL_ENTITY')),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('NPD', 'OTHER')),
  projected_contractor_type TEXT NOT NULL CHECK (projected_contractor_type IN ('SELF_EMPLOYED', 'INDIVIDUAL_ENTREPRENEUR', 'ORGANIZATION')),
  supersedes_revision_id TEXT REFERENCES agent_referrals_legal_profile_revisions(id),
  reason TEXT NOT NULL,
  assertion_source TEXT NOT NULL CHECK (assertion_source IN ('PARTNER_ASSERTED', 'ADMIN_ASSERTED')),
  evidence_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id, revision),
  CHECK (
    (legal_form = 'INDIVIDUAL' AND tax_mode = 'NPD' AND projected_contractor_type = 'SELF_EMPLOYED')
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND tax_mode IN ('NPD', 'OTHER') AND projected_contractor_type = 'INDIVIDUAL_ENTREPRENEUR')
    OR (legal_form = 'LEGAL_ENTITY' AND tax_mode = 'OTHER' AND projected_contractor_type = 'ORGANIZATION')
  ),
  CHECK (evidence_ref IS NULL OR trim(evidence_ref) != ''),
  CHECK (assertion_source = 'PARTNER_ASSERTED' OR (assertion_source = 'ADMIN_ASSERTED' AND evidence_ref IS NOT NULL))
);

INSERT INTO agent_referrals_legal_profile_revisions_0050_new
  (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, supersedes_revision_id, reason, assertion_source, evidence_ref, created_at)
  SELECT id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, supersedes_revision_id, reason, 'PARTNER_ASSERTED', NULL, created_at
  FROM agent_referrals_legal_profile_revisions;

DROP TABLE agent_referrals_legal_profile_revisions;

ALTER TABLE agent_referrals_legal_profile_revisions_0050_new RENAME TO agent_referrals_legal_profile_revisions;

CREATE INDEX agent_referrals_legal_profile_revisions_agent_idx
  ON agent_referrals_legal_profile_revisions(agent_id, revision);

-- Historical evidence; a filed revision is never restated in place, and
-- "immutable" must not mean only "cannot be edited, may still be erased" -
-- deleting the current (latest) revision would silently fall the current
-- projection back to a stale one while agents.contractor_type still carries
-- the deleted revision's value, so evidence and projection would disagree.
-- Recreated verbatim from 0043: DROP TABLE above also dropped these two
-- triggers along with the table they guarded.
CREATE TRIGGER agent_referrals_legal_profile_revisions_immutable_guard
BEFORE UPDATE ON agent_referrals_legal_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE');
END;
CREATE TRIGGER agent_referrals_legal_profile_revisions_delete_guard
BEFORE DELETE ON agent_referrals_legal_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE');
END;

-- The three triggers dropped above, recreated byte-for-byte identical to
-- 0047 (reward_settlements_authority_tuple_consistency_guard) and 0049
-- (the other two). Nothing about their own behavior changes; only the
-- instant they exist within this transaction does.
CREATE TRIGGER agents_contractor_type_projection_guard
BEFORE UPDATE OF contractor_type ON agents
WHEN NEW.contractor_type IS NOT OLD.contractor_type
  AND EXISTS (SELECT 1 FROM agent_referrals_legal_profile_revisions WHERE agent_id = NEW.id)
  AND NEW.contractor_type IS NOT (
    SELECT projected_contractor_type FROM agent_referrals_legal_profile_revisions
    WHERE agent_id = NEW.id ORDER BY revision DESC LIMIT 1
  )
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_CONTRACTOR_TYPE_PROJECTION_LOCKED'); END;

CREATE TRIGGER reward_settlements_authority_tuple_consistency_guard
BEFORE INSERT ON reward_settlements
WHEN NOT (
  ((NEW.settlement_flow IS NULL OR NEW.settlement_flow = 'LEGACY')
    AND NEW.engagement_id IS NULL AND NEW.engagement_revision_id IS NULL
    AND NEW.base_registry_snapshot_id IS NULL AND NEW.reward_registry_hash IS NULL AND NEW.effective_reward_snapshot_id IS NULL
    AND NEW.partner_identity_id IS NULL AND NEW.payout_profile_revision_id IS NULL
    AND NEW.tax_mode_snapshot IS NULL AND NEW.legal_profile_revision_id_snapshot IS NULL
    AND NEW.supersedes_settlement_id IS NULL AND NEW.cancellation_reason IS NULL)
  OR
  (NEW.settlement_flow = 'AGENT_REFERRALS'
    AND NEW.engagement_id IS NOT NULL AND NEW.engagement_revision_id IS NOT NULL
    AND NEW.base_registry_snapshot_id IS NOT NULL AND NEW.reward_registry_hash IS NOT NULL AND NEW.effective_reward_snapshot_id IS NOT NULL
    AND NEW.partner_identity_id IS NOT NULL AND NEW.payout_profile_revision_id IS NOT NULL
    AND NEW.tax_mode_snapshot IS NOT NULL AND NEW.legal_profile_revision_id_snapshot IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM engagement_effective_reward_snapshots e
      WHERE e.id = NEW.effective_reward_snapshot_id
        AND e.engagement_id = NEW.engagement_id
        AND e.engagement_revision_id = NEW.engagement_revision_id
        AND e.base_registry_snapshot_id = NEW.base_registry_snapshot_id
        AND e.reward_total_kopecks = NEW.amount_kopecks
        AND e.sequence = (SELECT MAX(sequence) FROM engagement_effective_reward_snapshots WHERE engagement_id = NEW.engagement_id)
    )
    AND EXISTS (SELECT 1 FROM engagement_reward_registry_snapshot r WHERE r.id = NEW.base_registry_snapshot_id AND r.source_state_hash = NEW.reward_registry_hash)
    AND EXISTS (
      SELECT 1 FROM engagements en JOIN occurrences o ON o.id = en.occurrence_id
      WHERE en.id = NEW.engagement_id AND en.occurrence_id = NEW.occurrence_id AND o.fulfillment_status = 'COMPLETED'
    )
    AND EXISTS (SELECT 1 FROM partner_identities pi WHERE pi.id = NEW.partner_identity_id AND pi.agent_id = NEW.agent_id)
    AND EXISTS (SELECT 1 FROM engagements en2 WHERE en2.id = NEW.engagement_id AND en2.partner_identity_id = NEW.partner_identity_id)
    AND EXISTS (
      SELECT 1 FROM partner_identities pi2
      JOIN agent_referrals_legal_profile_revisions lp ON lp.id = pi2.legal_profile_revision_id
      WHERE pi2.id = NEW.partner_identity_id AND pi2.legal_profile_revision_id = NEW.legal_profile_revision_id_snapshot
        AND lp.agent_id = NEW.agent_id AND lp.tax_mode = NEW.tax_mode_snapshot
    )
    AND NEW.contractor_type_snapshot = (SELECT contractor_type FROM agents WHERE id = NEW.agent_id)
    AND EXISTS (
      SELECT 1 FROM payout_profile_revisions ppr
      WHERE ppr.id = NEW.payout_profile_revision_id AND ppr.partner_identity_id = NEW.partner_identity_id AND ppr.kind = 'ACTIVE_DESTINATION'
        AND ppr.revision = (SELECT MAX(revision) FROM payout_profile_revisions WHERE partner_identity_id = NEW.partner_identity_id)
    )
    AND (
      NEW.supersedes_settlement_id IS NULL
      OR EXISTS (
        SELECT 1 FROM reward_settlements prev
        JOIN engagement_effective_reward_snapshots e2 ON e2.id = NEW.effective_reward_snapshot_id
        WHERE prev.id = NEW.supersedes_settlement_id
          AND prev.settlement_flow = 'AGENT_REFERRALS'
          AND prev.engagement_id = NEW.engagement_id
          AND prev.status = 'CANCELLED_BEFORE_PAYMENT'
          AND prev.cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION'
          AND e2.supersedes_effective_snapshot_id = prev.effective_reward_snapshot_id
      )
    ))
)
BEGIN SELECT RAISE(ABORT, 'REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT'); END;

CREATE TRIGGER reward_settlements_contractor_type_projection_guard
BEFORE INSERT ON reward_settlements
WHEN NEW.settlement_flow = 'AGENT_REFERRALS'
  AND NEW.legal_profile_revision_id_snapshot IS NOT NULL
  AND NEW.contractor_type_snapshot IS NOT (
    SELECT projected_contractor_type FROM agent_referrals_legal_profile_revisions
    WHERE id = NEW.legal_profile_revision_id_snapshot
  )
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_SETTLEMENT_CONTRACTOR_TYPE_PROJECTION_MISMATCH'); END;
