-- Phase 1: `agents` becomes an operational entity. Legal identity lives only
-- in agent_referrals_legal_profile_revisions; the rebuild intentionally drops
-- the legacy legal-name/INN/contractor/NPD timestamp shadows.
--
-- This is FK-off by necessity: SQLite cannot drop the old CHECK-bound columns
-- in place, while several historical tables reference agents(id). The loader
-- admits this exact file only through its reviewed SHA-256 registry entry.
--
-- Do not touch reward_settlements_authority_columns_immutable_guard or
-- reward_settlements_contractor_type_projection_guard here. They do not
-- depend on agents and remain the historical/Agent Referrals backstops.

-- The two Phase 1 production gates, re-proved here as executable
-- preconditions rather than trusted from an operator snapshot.
--
-- An operator query is a point-in-time fact and cannot bind this migration:
-- the BASE runtime's legacy prepareSettlement() writes reward_settlements
-- rows without settlement_flow (so they read as LEGACY) and sits behind no
-- sales gate, so it can invalidate either gate between the query and the
-- cutover. applyFkOffMigration runs this whole file inside one
-- BEGIN IMMEDIATE transaction, so a writer either lands before the lock and
-- is counted below, or cannot interleave before the DDL at all. That closes
-- the race instead of narrowing it.
--
-- Same fail-closed shape as 0052's _pr_e_zero_legacy_guard: a violation
-- aborts the transaction with the constraint name as the reason and leaves
-- the schema, the migration ledger and every trigger untouched. There is
-- deliberately no repair, backfill or relabel path here - a non-zero gate is
-- a design decision to make with production evidence in hand, not something
-- to paper over inside a migration.
--
-- Top-level RAISE(ABORT) is not available: SQLite rejects it outside a
-- trigger program ("RAISE() may only be used within a trigger-program").

CREATE TEMP TABLE _phase_1_gate_1_guard (
  row_count INTEGER NOT NULL,
  CONSTRAINT PHASE_1_GATE_1_LEGACY_SETTLEMENTS_PRESENT CHECK (row_count = 0)
);
-- IS NOT is null-safe, so historical NULL rows count as LEGACY.
INSERT INTO _phase_1_gate_1_guard(row_count)
  SELECT COUNT(*) FROM reward_settlements WHERE settlement_flow IS NOT 'AGENT_REFERRALS';
DROP TABLE _phase_1_gate_1_guard;

CREATE TEMP TABLE _phase_1_gate_2_guard (
  row_count INTEGER NOT NULL,
  CONSTRAINT PHASE_1_GATE_2_UNBOUND_LEGACY_AGENT CHECK (row_count = 0)
);
-- Exactly the binding the rewritten LEGACY authority tuple below enforces at
-- INSERT time: a live identity whose pointer is this agent's MAX revision.
INSERT INTO _phase_1_gate_2_guard(row_count)
  SELECT COUNT(*) FROM agents a
  WHERE (
        EXISTS (SELECT 1 FROM referral_rewards r
                WHERE r.agent_id = a.id
                  AND COALESCE(r.reward_authority_kind, 'LEGACY') = 'LEGACY')
     OR EXISTS (SELECT 1 FROM reward_adjustments ra JOIN orders o ON o.id = ra.order_id
                WHERE ra.agent_id = a.id AND o.reward_authority_kind = 'LEGACY')
     OR EXISTS (SELECT 1 FROM reward_settlements rs
                WHERE rs.agent_id = a.id AND rs.settlement_flow IS NOT 'AGENT_REFERRALS')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM partner_identities pi
      JOIN agent_referrals_legal_profile_revisions lp ON lp.id = pi.legal_profile_revision_id
      WHERE pi.agent_id = a.id
        AND pi.destroyed_at IS NULL
        AND lp.agent_id = a.id
        AND lp.revision = (SELECT MAX(lp2.revision)
                           FROM agent_referrals_legal_profile_revisions lp2
                           WHERE lp2.agent_id = a.id)
    );
DROP TABLE _phase_1_gate_2_guard;

DROP TRIGGER agents_contractor_type_projection_guard;
DROP TRIGGER reward_settlements_authority_tuple_consistency_guard;

CREATE TABLE agents_0058_new (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  contract_reference TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  default_reward_type TEXT NOT NULL CHECK (default_reward_type IN ('PERCENT', 'FIXED')),
  default_reward_value INTEGER NOT NULL CHECK (default_reward_value >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO agents_0058_new (
  id, slug, display_name, email, contract_reference, enabled,
  default_reward_type, default_reward_value, created_at, updated_at
)
SELECT id, slug, display_name, email, contract_reference, enabled,
  default_reward_type, default_reward_value, created_at, updated_at
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_0058_new RENAME TO agents;

-- Legacy settlement authority is now a pinned, current legal-profile fact.
-- For new LEGACY rows, the selected revision must be the active partner
-- identity's exact pointer and the MAX revision for this agent at INSERT time.
-- A later revision does not revisit or invalidate a persisted settlement.
CREATE TRIGGER reward_settlements_authority_tuple_consistency_guard
BEFORE INSERT ON reward_settlements
WHEN NOT (
  ((NEW.settlement_flow IS NULL OR NEW.settlement_flow = 'LEGACY')
    AND NEW.engagement_id IS NULL AND NEW.engagement_revision_id IS NULL
    AND NEW.base_registry_snapshot_id IS NULL AND NEW.reward_registry_hash IS NULL AND NEW.effective_reward_snapshot_id IS NULL
    AND NEW.partner_identity_id IS NULL AND NEW.payout_profile_revision_id IS NULL
    AND NEW.tax_mode_snapshot IS NULL AND NEW.legal_profile_revision_id_snapshot IS NOT NULL
    AND NEW.contractor_type_snapshot IS NOT NULL
    AND NEW.supersedes_settlement_id IS NULL AND NEW.cancellation_reason IS NULL
    AND NEW.tax_treatment_revision_id_snapshot IS NULL AND NEW.tax_canonicalization_version IS NULL
    AND NEW.tax_canonical_json IS NULL AND NEW.tax_canonical_hash IS NULL
    AND EXISTS (
      SELECT 1
      FROM partner_identities pi
      JOIN agent_referrals_legal_profile_revisions lp ON lp.id = NEW.legal_profile_revision_id_snapshot
      WHERE pi.agent_id = NEW.agent_id
        AND pi.destroyed_at IS NULL
        AND pi.legal_profile_revision_id = NEW.legal_profile_revision_id_snapshot
        AND lp.agent_id = NEW.agent_id
        AND lp.revision = (SELECT MAX(revision) FROM agent_referrals_legal_profile_revisions WHERE agent_id = NEW.agent_id)
        AND lp.projected_contractor_type = NEW.contractor_type_snapshot
    ))
  OR
  (NEW.settlement_flow = 'AGENT_REFERRALS'
    AND NEW.engagement_id IS NOT NULL AND NEW.engagement_revision_id IS NOT NULL
    AND NEW.base_registry_snapshot_id IS NOT NULL AND NEW.reward_registry_hash IS NOT NULL AND NEW.effective_reward_snapshot_id IS NOT NULL
    AND NEW.partner_identity_id IS NOT NULL AND NEW.payout_profile_revision_id IS NOT NULL
    AND NEW.tax_mode_snapshot IS NOT NULL AND NEW.legal_profile_revision_id_snapshot IS NOT NULL
    AND NEW.tax_treatment_revision_id_snapshot IS NOT NULL AND NEW.tax_canonicalization_version = 'SETTLEMENT_TAX_V1'
    AND NEW.tax_canonical_json IS NOT NULL AND NEW.tax_canonical_hash IS NOT NULL
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
        AND lp.projected_contractor_type = NEW.contractor_type_snapshot
    )
    AND EXISTS (
      SELECT 1 FROM agent_referrals_tax_treatment_revisions tt
      WHERE tt.id = NEW.tax_treatment_revision_id_snapshot
        AND tt.legal_profile_revision_id = NEW.legal_profile_revision_id_snapshot
        AND tt.partner_identity_id = NEW.partner_identity_id
    )
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
