-- PR-E: unified legal requisites. Extends the immutable legal-profile
-- revision chain (0043, provenance added 0050, supersession added 0051)
-- with the full requisite tuple a legal identity actually needs beyond
-- legal_form/tax_mode - opf, full_name, short_name, inn, kpp,
-- registration_number, legal_address. Authority model is unchanged:
-- MAX(revision) remains the sole semantic authority, the partner_identities
-- pointer remains a checked projection of it, activation pinning and
-- settlement binding (D2 §4/§5) are untouched - a settlement's
-- legal_profile_revision_id_snapshot already resolves the exact immutable
-- revision it was activated under, so requisites are never duplicated onto
-- reward_settlements or settlement_acts.
--
-- Deliberately clean-slate, not versioned: a production read-only check
-- (2026-09-10) proved zero rows in agent_referrals_legal_profile_revisions,
-- and therefore (by the FK partner_identities -> that revisions table, and
-- change_requests -> partner_identities) zero rows in
-- agent_referrals_legal_profile_change_requests too - no partner has ever
-- completed onboarding in production. That manual check is design
-- evidence, not a durable guarantee by itself, so this migration re-proves
-- its own premise as an executable, fail-closed deployment invariant
-- BEFORE touching anything: if either table is non-empty by the time this
-- actually runs, the whole migration aborts and rolls back rather than
-- fabricating requisites for existing rows or inventing a nullable
-- compatibility schema nothing needs. No `profile_schema_version`, no
-- legacy-row remediation path - if the premise ever stops holding, that is
-- a genuine design decision to make with real evidence in hand, not
-- something to paper over here.
CREATE TEMP TABLE _pr_e_zero_legacy_guard (
  row_count INTEGER NOT NULL,
  CONSTRAINT pr_e_migration_requires_zero_legacy_rows CHECK (row_count = 0)
);
INSERT INTO _pr_e_zero_legacy_guard(row_count) SELECT COUNT(*) FROM agent_referrals_legal_profile_revisions;
INSERT INTO _pr_e_zero_legacy_guard(row_count) SELECT COUNT(*) FROM agent_referrals_legal_profile_change_requests;
DROP TABLE _pr_e_zero_legacy_guard;

-- The candidate table has no inbound FK of its own (nothing else
-- references agent_referrals_legal_profile_change_requests) and the guard
-- above already proved it empty, so it is dropped and recreated fresh
-- under the same name directly - no temp-name-then-rename dance, and
-- nothing to copy. Doing this BEFORE the revisions rebuild below also
-- removes it from that rebuild's own inbound-FK bookkeeping entirely: by
-- the time agent_referrals_legal_profile_revisions is touched, this table
-- (and its two FK columns into that one) no longer exists.
DROP TABLE agent_referrals_legal_profile_change_requests;

-- This is the third FK-off migration (see FK_OFF_MIGRATIONS in
-- commerce/src/db.ts) - SQLite still cannot widen a CHECK-constrained
-- table without recreating it, and agent_referrals_legal_profile_revisions
-- still carries three inbound FKs (engagement_activation_events,
-- reward_settlements, partner_identities) plus its own self-referencing
-- supersedes_revision_id. Same DROP-then-RENAME-INTO pattern 0042 and 0050
-- established, for the identical reason: renaming the ORIGINAL away
-- instead of dropping it would make SQLite's rename-tracking repoint every
-- inbound FK at the vacated temporary name rather than the rebuilt table.
--
-- The same three cross-table triggers 0050 had to work around are worked
-- around identically here: SQLite's ALTER TABLE RENAME TO recompiles every
-- OTHER trigger body anywhere in the schema that textually names the
-- table being renamed INTO, and does so mid-rename - after the old table
-- has already been DROPped and before the replacement has been renamed
-- into place - so without intervention that recompilation fails with "no
-- such table". DROPped just before the rename, CREATEd again byte-for-byte
-- identical immediately after.
DROP TRIGGER agents_contractor_type_projection_guard;
DROP TRIGGER reward_settlements_contractor_type_projection_guard;
DROP TRIGGER reward_settlements_authority_tuple_consistency_guard;

-- No row-copying INSERT...SELECT exists here at all, unlike 0050's rebuild
-- - the guard above already proved zero rows exist to copy, and the new
-- required requisite columns (full_name, inn) have no legacy source to
-- backfill them from even if a row somehow existed. If the guard did not
-- abort, there is nothing left to move.
CREATE TABLE agent_referrals_legal_profile_revisions_0052_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  revision INTEGER NOT NULL,
  legal_form TEXT NOT NULL CHECK (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR', 'LEGAL_ENTITY')),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('NPD', 'OTHER')),
  projected_contractor_type TEXT NOT NULL CHECK (projected_contractor_type IN ('SELF_EMPLOYED', 'INDIVIDUAL_ENTREPRENEUR', 'ORGANIZATION')),
  -- Unified legal requisites (PR-E). Every one is an asserted fact, never
  -- derived from another field (full_name is never built from opf+
  -- short_name or vice versa) - see the shape/format CHECKs below for the
  -- exact per-legal_form matrix. TEXT throughout, including every
  -- identifier (inn/kpp/registration_number): these are never arithmetic
  -- values, and a leading zero is significant.
  opf TEXT,
  full_name TEXT NOT NULL,
  short_name TEXT,
  inn TEXT NOT NULL,
  kpp TEXT,
  registration_number TEXT,
  legal_address TEXT,
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
  CHECK (evidence_ref IS NULL OR trim(evidence_ref, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (assertion_source = 'PARTNER_ASSERTED' OR (assertion_source = 'ADMIN_ASSERTED' AND evidence_ref IS NOT NULL)),
  -- Requisites SHAPE per legal_form: which fields this legal_form leaves
  -- NULL vs requires. INDIVIDUAL (self-employed/NPD individuals) and
  -- INDIVIDUAL_ENTREPRENEUR intentionally carry no legal_address requisite
  -- in PR-E - collecting a natural person's address is real PII with no
  -- concrete document/provider consumer yet, not schema symmetry for its
  -- own sake. short_name is the one OPTIONAL field, and only for
  -- LEGAL_ENTITY - no constraint names it structurally NULL/NOT NULL.
  CHECK (
    (legal_form = 'INDIVIDUAL' AND opf IS NULL AND short_name IS NULL AND kpp IS NULL AND registration_number IS NULL AND legal_address IS NULL)
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND opf IS NULL AND short_name IS NULL AND kpp IS NULL AND registration_number IS NOT NULL AND legal_address IS NULL)
    OR (legal_form = 'LEGAL_ENTITY' AND opf IS NOT NULL AND kpp IS NOT NULL AND registration_number IS NOT NULL AND legal_address IS NOT NULL)
  ),
  -- full_name is required for every legal_form (the registered full name /
  -- FIO), so this CHECK stands alone rather than folding into the shape
  -- CHECK above.
  CHECK (trim(full_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  -- A present-but-blank value is never accepted as "provided", matching
  -- the same evidence_ref discipline established in 0050/0051 - SQLite's
  -- single-argument trim() only strips ASCII space.
  CHECK (opf IS NULL OR trim(opf, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (short_name IS NULL OR trim(short_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (legal_address IS NULL OR trim(legal_address, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  -- INN: digits only, exact length by legal_form (12 for a natural
  -- person/individual entrepreneur, 10 for a legal entity - Russian tax
  -- identifier conventions).
  CHECK (
    (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR') AND length(inn) = 12 AND inn NOT GLOB '*[^0-9]*')
    OR (legal_form = 'LEGAL_ENTITY' AND length(inn) = 10 AND inn NOT GLOB '*[^0-9]*')
  ),
  -- KPP: digits only, exactly 9 - only ever present for LEGAL_ENTITY, and
  -- the shape CHECK above already makes it required there.
  CHECK (kpp IS NULL OR (length(kpp) = 9 AND kpp NOT GLOB '*[^0-9]*')),
  -- registration_number: digits only, exact length by legal_form (15 for
  -- an individual entrepreneur's OGRNIP, 13 for a legal entity's OGRN).
  CHECK (
    registration_number IS NULL
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND length(registration_number) = 15 AND registration_number NOT GLOB '*[^0-9]*')
    OR (legal_form = 'LEGAL_ENTITY' AND length(registration_number) = 13 AND registration_number NOT GLOB '*[^0-9]*')
  )
);

DROP TABLE agent_referrals_legal_profile_revisions;

ALTER TABLE agent_referrals_legal_profile_revisions_0052_new RENAME TO agent_referrals_legal_profile_revisions;

CREATE INDEX agent_referrals_legal_profile_revisions_agent_idx
  ON agent_referrals_legal_profile_revisions(agent_id, revision);

-- Recreated verbatim from 0043/0050: DROP TABLE above also dropped these
-- two triggers along with the table they guarded.
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
-- 0047/0049 (via 0050). Nothing about their own behavior changes; only the
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

-- The D2 candidate table, recreated fresh (dropped above) with the same
-- unified requisite tuple and the identical shape/format CHECKs as the
-- revisions table above - a candidate can never even be filed for a shape
-- the eventual mint path would reject. Lifecycle, transition guards and
-- the partial-unique-index backstop are otherwise byte-for-byte identical
-- to 0051.
CREATE TABLE agent_referrals_legal_profile_change_requests (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  legal_form TEXT NOT NULL CHECK (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR', 'LEGAL_ENTITY')),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('NPD', 'OTHER')),
  opf TEXT,
  full_name TEXT NOT NULL,
  short_name TEXT,
  inn TEXT NOT NULL,
  kpp TEXT,
  registration_number TEXT,
  legal_address TEXT,
  assertion_source TEXT NOT NULL CHECK (assertion_source IN ('PARTNER_ASSERTED', 'ADMIN_ASSERTED')),
  evidence_ref TEXT,
  reason TEXT NOT NULL,
  supersedes_revision_id TEXT NOT NULL REFERENCES agent_referrals_legal_profile_revisions(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'VERIFIED', 'REJECTED', 'STALE')),
  resolved_legal_profile_revision_id TEXT REFERENCES agent_referrals_legal_profile_revisions(id),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_reason TEXT,

  CHECK (
    (legal_form = 'INDIVIDUAL' AND tax_mode = 'NPD')
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND tax_mode IN ('NPD', 'OTHER'))
    OR (legal_form = 'LEGAL_ENTITY' AND tax_mode = 'OTHER')
  ),
  CHECK (evidence_ref IS NULL OR trim(evidence_ref, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (assertion_source = 'PARTNER_ASSERTED' OR (assertion_source = 'ADMIN_ASSERTED' AND evidence_ref IS NOT NULL)),
  CHECK (
    (state = 'PENDING' AND resolved_legal_profile_revision_id IS NULL AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL)
    OR (state = 'VERIFIED' AND resolved_legal_profile_revision_id IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    OR (state IN ('REJECTED', 'STALE') AND resolved_legal_profile_revision_id IS NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_reason IS NOT NULL)
  ),
  CHECK (
    (legal_form = 'INDIVIDUAL' AND opf IS NULL AND short_name IS NULL AND kpp IS NULL AND registration_number IS NULL AND legal_address IS NULL)
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND opf IS NULL AND short_name IS NULL AND kpp IS NULL AND registration_number IS NOT NULL AND legal_address IS NULL)
    OR (legal_form = 'LEGAL_ENTITY' AND opf IS NOT NULL AND kpp IS NOT NULL AND registration_number IS NOT NULL AND legal_address IS NOT NULL)
  ),
  CHECK (trim(full_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (opf IS NULL OR trim(opf, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (short_name IS NULL OR trim(short_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (legal_address IS NULL OR trim(legal_address, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)) != ''),
  CHECK (
    (legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR') AND length(inn) = 12 AND inn NOT GLOB '*[^0-9]*')
    OR (legal_form = 'LEGAL_ENTITY' AND length(inn) = 10 AND inn NOT GLOB '*[^0-9]*')
  ),
  CHECK (kpp IS NULL OR (length(kpp) = 9 AND kpp NOT GLOB '*[^0-9]*')),
  CHECK (
    registration_number IS NULL
    OR (legal_form = 'INDIVIDUAL_ENTREPRENEUR' AND length(registration_number) = 15 AND registration_number NOT GLOB '*[^0-9]*')
    OR (legal_form = 'LEGAL_ENTITY' AND length(registration_number) = 13 AND registration_number NOT GLOB '*[^0-9]*')
  )
);

CREATE INDEX agent_referrals_legal_profile_change_requests_partner_idx
  ON agent_referrals_legal_profile_change_requests(partner_identity_id, created_at);

CREATE UNIQUE INDEX agent_referrals_legal_profile_change_requests_pending_unique
  ON agent_referrals_legal_profile_change_requests(partner_identity_id) WHERE state = 'PENDING';

CREATE TRIGGER agent_referrals_legal_profile_change_requests_terminal_immutable_guard
BEFORE UPDATE ON agent_referrals_legal_profile_change_requests
WHEN OLD.state != 'PENDING'
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_legal_profile_change_requests_pending_reentry_guard
BEFORE UPDATE ON agent_referrals_legal_profile_change_requests
WHEN OLD.state = 'PENDING' AND NEW.state = 'PENDING'
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_legal_profile_change_requests_request_fields_immutable_guard
BEFORE UPDATE ON agent_referrals_legal_profile_change_requests
WHEN NEW.partner_identity_id IS NOT OLD.partner_identity_id
  OR NEW.legal_form IS NOT OLD.legal_form
  OR NEW.tax_mode IS NOT OLD.tax_mode
  OR NEW.opf IS NOT OLD.opf
  OR NEW.full_name IS NOT OLD.full_name
  OR NEW.short_name IS NOT OLD.short_name
  OR NEW.inn IS NOT OLD.inn
  OR NEW.kpp IS NOT OLD.kpp
  OR NEW.registration_number IS NOT OLD.registration_number
  OR NEW.legal_address IS NOT OLD.legal_address
  OR NEW.assertion_source IS NOT OLD.assertion_source
  OR NEW.evidence_ref IS NOT OLD.evidence_ref
  OR NEW.reason IS NOT OLD.reason
  OR NEW.supersedes_revision_id IS NOT OLD.supersedes_revision_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;

CREATE TRIGGER agent_referrals_legal_profile_change_requests_delete_guard
BEFORE DELETE ON agent_referrals_legal_profile_change_requests
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;

-- Primary onboarding's mutable draft (0044) so far only ever captured
-- submitted_legal_form/submitted_tax_mode. It now needs the same unified
-- requisite tuple as a draft, so submitPartnerLegalProfile() can validate
-- the FULL matrix before the one-time PROFILE_SUBMITTED transition and
-- verifyPartnerLegalProfile() can carry the whole proven snapshot straight
-- into applyVerifiedLegalProfileForPartnerIdentity() - mint #1 becomes
-- unreachable without every mandatory requisite present.
--
-- No new draft table: partner_identities already deliberately separates a
-- mutable submitted claim (this row) from the immutable verified evidence
-- (agent_referrals_legal_profile_revisions) - these seven columns extend
-- the existing draft rather than duplicating its lifecycle elsewhere.
--
-- Plain nullable ADD COLUMNs, no rebuild: partner_identities carries no
-- CHECK referencing these new columns, so SQLite can add them directly.
-- Deliberately no shape/format CHECK here (unlike the revision/candidate
-- tables above) - the draft is legitimately incomplete for as long as the
-- identity sits in INVITED, and submitPartnerLegalProfile() is the sole
-- write path, always setting the whole tuple atomically after running the
-- exact same domain matrix validator the DB CHECKs above mirror. The DB-
-- level backstop belongs on the table that actually mints authority.
ALTER TABLE partner_identities ADD COLUMN submitted_opf TEXT;
ALTER TABLE partner_identities ADD COLUMN submitted_full_name TEXT;
ALTER TABLE partner_identities ADD COLUMN submitted_short_name TEXT;
ALTER TABLE partner_identities ADD COLUMN submitted_inn TEXT;
ALTER TABLE partner_identities ADD COLUMN submitted_kpp TEXT;
ALTER TABLE partner_identities ADD COLUMN submitted_registration_number TEXT;
ALTER TABLE partner_identities ADD COLUMN submitted_legal_address TEXT;
