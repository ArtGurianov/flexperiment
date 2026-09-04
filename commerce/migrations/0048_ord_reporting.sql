-- Agent Referrals ORD/ERIR reporting: local/manual VK ORD provider profile
-- evidence, provider-operation authority for counterparty/platform/
-- contract/media, creative-registration authority (completing PR5's
-- CREATIVE_READY_TO_PUBLISH provider half), distribution-period reporting +
-- correction lineage, VK paid-invoice payload authority, and the zero-reward
-- vs continuing statistics split (plan sections B-3, B-5, B-10). Ordinary
-- migration - not FK-off (only 0042 carries that status). Schema/DORMANT
-- runtime only: no provider network client of any kind ships in this PR -
-- see agent-referrals-ord-*.ts's own headers and the network-absence
-- boundary test.
--
-- No levy tables of any kind - see plan section B-12. Nothing here
-- resembles income_recognition_rules, advertising_income_snapshot, a
-- contribution snapshot, a levy quarter, RKN payment reconciliation, a UIN,
-- partner levy evidence, or a MATCH/MISMATCH levy status. ORD/ERIR
-- contract/act/reward monetary facts (paid-invoice payload) are reporting
-- facts, never a levy calculation.
--
-- Shared operation-authority shape (creative registration, provider
-- operations): a REVISION CHAIN, not a single mutable row and not a
-- fully-immutable-from-insert row either - the two extremes this schema
-- uses elsewhere. `lock_state` has three values because the plan's own
-- Phase 8 text names all three:
--   MUTABLE          before any VK submission - ordinary in-place UPDATE
--                     (recording vk_external_id, moving local_state along)
--                     is legal, exactly as PR7's payment_attempts progress.
--   CORRECTION_ONLY   the operation reached CONFIRMED (VK-observed facts on
--                     file) - this exact row is now frozen (no more raw
--                     UPDATE of any field except the one-way transition to
--                     EXTERNALLY_LOCKED below), but a genuine registration-
--                     level error may still be corrected by minting the
--                     NEXT revision, which supersedes this one and pins its
--                     own corrected facts - forward-only, historical rows
--                     never rewritten.
--   EXTERNALLY_LOCKED terminal: no further revision of this operation will
--                     ever be minted (an explicit admin action, not implied
--                     by CONFIRMED alone).
-- "At most one CURRENT/active operation" is MAX(revision) for the identity
-- (creative_revision_id, or operation_kind) - never a bare UNIQUE on the
-- identity column alone, which would make "one active" indistinguishable
-- from "one ever" and leave no room for a genuine post-confirmation
-- correction (the exact defect closed in this revision of the migration).

-- 1. Immutable provider PROFILE families - configuration, not a business
-- fact (plan Phase 8: "counterparty, platform, contract, media" profiles).
-- One table, discriminated by profile_kind, because every kind shares the
-- identical shape (opaque versioned content + hash), exactly the
-- framework_agreement_revisions/delegation_template_revisions precedent
-- (0043). "Current" is always MAX(revision) WHERE profile_kind = ? - no
-- stored pointer to drift. Deliberately NOT gated by
-- assertAgentReferralsOperationPermitted anywhere in
-- agent-referrals-ord-provider-profile.ts: DORMANT readiness explicitly
-- distinguishes "seeded static configuration" from production business
-- records (plan's own DORMANT-readiness section), and provider
-- profile/contract evidence is exactly that - an admin may record which VK
-- counterparty/platform/contract/media profile Flexperiment operates under
-- long before the feature is ever activated, the same way ad_channel_policy
-- and the framework templates are seeded pre-activation.
--
-- content_hash is computed by application code via crypto.ts's canonicalV2
-- (a real recursive canonical JSON encoding, the same primitive
-- creative_hash/canonical_hash use throughout this schema) - never a
-- shallow top-level-only JSON.stringify(value, sortedTopLevelKeys), which
-- would silently miss a nested-only semantic change.
CREATE TABLE ord_provider_profile_revisions (
  id TEXT PRIMARY KEY,
  profile_kind TEXT NOT NULL CHECK (profile_kind IN ('COUNTERPARTY', 'PLATFORM', 'CONTRACT', 'MEDIA')),
  revision INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES ord_provider_profile_revisions(id),
  reason TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_kind, revision),
  CHECK ((revision = 1) = (supersedes_revision_id IS NULL))
);
CREATE TRIGGER ord_provider_profile_revisions_immutable_guard
BEFORE UPDATE ON ord_provider_profile_revisions
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE'); END;
CREATE TRIGGER ord_provider_profile_revisions_delete_guard
BEFORE DELETE ON ord_provider_profile_revisions
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE'); END;

-- Structural revision lineage (P1.1): revision 1 has no predecessor;
-- revision > 1's predecessor must be the SAME profile_kind at EXACTLY
-- revision - 1 - a raw INSERT naming a nonexistent, wrong-kind, or
-- non-immediate predecessor is refused, the identical invariant
-- ord_distribution_period_reports' own guard already proves one section
-- down.
CREATE TRIGGER ord_provider_profile_revisions_lineage_guard
BEFORE INSERT ON ord_provider_profile_revisions
WHEN NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions prev WHERE prev.id = NEW.supersedes_revision_id AND prev.profile_kind = NEW.profile_kind AND prev.revision = NEW.revision - 1
)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_PROFILE_REVISION_LINEAGE_INCONSISTENT'); END;

-- 2. Versioned format_kind -> reporting_basis policy (plan section B-10).
-- format_kind is already a closed CHECK-constrained enum
-- (engagement_creative_revisions), unlike channel_key's open text, so no
-- REVIEW_REQUIRED-style catch-all fallback is needed here - every value is
-- seeded below. Same historical-effective-instant resolution pattern as
-- ad_channel_policy (0043): a distribution's reporting_basis is resolved
-- against the policy effective AT ITS OWN published_at, not "policy now".
-- Also configuration, not a business fact - no suspension gate on the
-- setter, matching ad_channel_policy.
CREATE TABLE ord_reporting_period_policy (
  id TEXT PRIMARY KEY,
  format_kind TEXT NOT NULL CHECK (format_kind IN ('post', 'story', 'short_video', 'long_video', 'stream', 'audio', 'text', 'graphic', 'text_graphic', 'native_authored')),
  policy_revision INTEGER NOT NULL,
  reporting_basis TEXT NOT NULL CHECK (reporting_basis IN ('CALENDAR_MONTH', 'PROVIDER_SPECIAL_PERIOD')),
  effective_from TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (format_kind, policy_revision)
);
CREATE INDEX ord_reporting_period_policy_effective_idx ON ord_reporting_period_policy(format_kind, effective_from);
CREATE TRIGGER ord_reporting_period_policy_immutable_guard
BEFORE UPDATE ON ord_reporting_period_policy
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_PERIOD_POLICY_IMMUTABLE'); END;
CREATE TRIGGER ord_reporting_period_policy_delete_guard
BEFORE DELETE ON ord_reporting_period_policy
BEGIN SELECT RAISE(ABORT, 'ORD_REPORTING_PERIOD_POLICY_IMMUTABLE'); END;

-- Seeded static configuration (not a business record): ordinary internet
-- formats report per calendar month (L5, confirmed in shape); the three
-- persistent/authored formats (long_video, stream, native_authored) map to
-- the separate timing regime the law also confirms exists in shape, whose
-- EXACT VK representation is L5's PENDING_EXTERNAL_CONFIRMATION - see
-- ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED in the activation manifest, which
-- fail-closed-gates actually FILING an ACTUAL report on this basis (never
-- gates the config mapping itself).
INSERT INTO ord_reporting_period_policy(id, format_kind, policy_revision, reporting_basis, effective_from, reason) VALUES
  (lower(hex(randomblob(16))), 'post', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: ordinary internet advertising (L5).'),
  (lower(hex(randomblob(16))), 'story', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: ordinary internet advertising (L5).'),
  (lower(hex(randomblob(16))), 'short_video', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: ordinary internet advertising (L5).'),
  (lower(hex(randomblob(16))), 'audio', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: ordinary internet advertising (L5).'),
  (lower(hex(randomblob(16))), 'text', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: ordinary internet advertising (L5).'),
  (lower(hex(randomblob(16))), 'graphic', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: ordinary internet advertising (L5).'),
  (lower(hex(randomblob(16))), 'text_graphic', 1, 'CALENDAR_MONTH', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: ordinary internet advertising (L5).'),
  (lower(hex(randomblob(16))), 'long_video', 1, 'PROVIDER_SPECIAL_PERIOD', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: authored video work, separate timing regime (L5/L7).'),
  (lower(hex(randomblob(16))), 'stream', 1, 'PROVIDER_SPECIAL_PERIOD', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: authored/persistent content (L5/L7).'),
  (lower(hex(randomblob(16))), 'native_authored', 1, 'PROVIDER_SPECIAL_PERIOD', '2020-01-01T00:00:00.000Z', 'Seeded at Phase 8 foundation: authored/persistent content (L5/L7).');

-- 3. Provider-operation authority for the four profile kinds (P0.1): the
-- durable MANUAL fact that Flexperiment actually submitted/maintains its
-- own counterparty/platform/contract/media registration with VK ORD - never
-- confused with the immutable CONTENT the profile revisions above describe.
-- One row per (operation_kind, revision); "current" is MAX(revision) for
-- the kind. Bounded to exactly one operation CHAIN per kind (Flexperiment
-- has exactly one counterparty, one platform, one contract, one media
-- registration under the single VK_ORD+MANUAL provider this plan scopes -
-- no multi-provider or multi-instance abstraction).
CREATE TABLE ord_provider_operations (
  id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('COUNTERPARTY', 'PLATFORM', 'CONTRACT', 'MEDIA')),
  revision INTEGER NOT NULL,
  supersedes_operation_id TEXT REFERENCES ord_provider_operations(id),
  provider_profile_revision_id TEXT NOT NULL REFERENCES ord_provider_profile_revisions(id),
  operation_key TEXT NOT NULL UNIQUE,
  local_state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (local_state IN ('DRAFT', 'SUBMITTED', 'CONFIRMED')),
  vk_submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (vk_submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_external_id TEXT,
  erir_code TEXT,
  erir_evidence_ref TEXT,
  evidence_ref TEXT,
  lock_state TEXT NOT NULL DEFAULT 'MUTABLE' CHECK (lock_state IN ('MUTABLE', 'CORRECTION_ONLY', 'EXTERNALLY_LOCKED')),
  correction_reason TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (operation_kind, revision),
  CHECK ((revision = 1) = (supersedes_operation_id IS NULL)),
  CHECK (revision = 1 OR correction_reason IS NOT NULL),
  -- Exact per-state shape (P0.6-style rigor, applied here too): DRAFT
  -- carries no observed/evidence facts at all and is always MUTABLE;
  -- SUBMITTED/CONFIRMED both require a real, non-empty evidence_ref and a
  -- real vk_external_id - "submitted" is never representable without
  -- durable provenance. Only CONFIRMED may leave MUTABLE.
  CHECK (
    (local_state = 'DRAFT' AND vk_submission_state IN ('NOT_SUBMITTED', 'SUBMIT_FAILED') AND vk_external_id IS NULL AND evidence_ref IS NULL AND lock_state = 'MUTABLE')
    OR (local_state = 'SUBMITTED' AND vk_submission_state = 'SUBMITTED' AND vk_external_id IS NOT NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '' AND lock_state = 'MUTABLE')
    OR (local_state = 'CONFIRMED' AND vk_submission_state = 'SUBMITTED' AND vk_external_id IS NOT NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '' AND lock_state IN ('CORRECTION_ONLY', 'EXTERNALLY_LOCKED'))
  ),
  -- ERIR reconciliation evidence (round-3 P0.4): independent of local/VK
  -- submission state, but never representable without its OWN durable
  -- provenance - a code with no evidence is exactly as unproven as a
  -- nullable external id merely existing.
  CHECK ((erir_code IS NULL) = (erir_evidence_ref IS NULL)) ,
  CHECK (erir_evidence_ref IS NULL OR trim(erir_evidence_ref) != ''),
  -- ERIR can only ever be recorded once a real submission is on file - DRAFT
  -- (never yet told VK anything) can never carry a reconciliation fact.
  CHECK (local_state != 'DRAFT' OR erir_code IS NULL)
);
CREATE INDEX ord_provider_operations_kind_idx ON ord_provider_operations(operation_kind, revision);

-- Lineage + provider-profile-currentness (the relational_registration
-- comment's own promise, now actually checked, not merely asserted):
-- revision > 1's predecessor is the SAME operation_kind at EXACTLY
-- revision - 1 AND was itself already CORRECTION_ONLY (a still-MUTABLE
-- draft is edited in place, never "corrected" via a new revision); the
-- pinned provider_profile_revision_id must be a real CURRENT profile
-- (MAX(revision)) of the matching kind at insert time - never a stale or
-- wrong-kind profile, and never an explicit caller-supplied override that
-- silently accepts a superseded revision.
CREATE TRIGGER ord_provider_operations_relational_consistency_guard
BEFORE INSERT ON ord_provider_operations
WHEN (NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM ord_provider_operations prev WHERE prev.id = NEW.supersedes_operation_id AND prev.operation_kind = NEW.operation_kind AND prev.revision = NEW.revision - 1 AND prev.lock_state = 'CORRECTION_ONLY'
))
OR NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions p
  WHERE p.id = NEW.provider_profile_revision_id AND p.profile_kind = NEW.operation_kind
    AND p.revision = (SELECT MAX(revision) FROM ord_provider_profile_revisions WHERE profile_kind = NEW.operation_kind)
)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_RELATIONAL_INCONSISTENT'); END;

-- Terminal: once EXTERNALLY_LOCKED, no UPDATE of any kind.
CREATE TRIGGER ord_provider_operations_terminal_immutable_guard
BEFORE UPDATE ON ord_provider_operations
WHEN OLD.lock_state = 'EXTERNALLY_LOCKED'
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_TERMINAL_IMMUTABLE'); END;

-- CORRECTION_ONLY: the row's own facts are frozen - the ONLY legal UPDATE
-- from here is the one-way transition to EXTERNALLY_LOCKED with every
-- other column held identical (erir_code/erir_evidence_ref excepted - the
-- independent Roskomnadzor reconciliation fact may still land while
-- CORRECTION_ONLY, since it is not part of what "correction" corrects -
-- but once set, the separate observed-id guard below makes it immutable
-- too, round-3 P0.4).
CREATE TRIGGER ord_provider_operations_correction_only_guard
BEFORE UPDATE ON ord_provider_operations
WHEN OLD.lock_state = 'CORRECTION_ONLY' AND (
  NEW.local_state IS NOT OLD.local_state OR NEW.vk_submission_state IS NOT OLD.vk_submission_state OR NEW.vk_external_id IS NOT OLD.vk_external_id
  OR NEW.evidence_ref IS NOT OLD.evidence_ref OR (NEW.lock_state NOT IN ('CORRECTION_ONLY', 'EXTERNALLY_LOCKED'))
)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_CORRECTION_ONLY'); END;

-- Authority columns never move, even pre-lock.
CREATE TRIGGER ord_provider_operations_authority_immutable_guard
BEFORE UPDATE ON ord_provider_operations
WHEN NEW.operation_kind IS NOT OLD.operation_kind OR NEW.revision IS NOT OLD.revision OR NEW.supersedes_operation_id IS NOT OLD.supersedes_operation_id
  OR NEW.provider_profile_revision_id IS NOT OLD.provider_profile_revision_id OR NEW.operation_key IS NOT OLD.operation_key OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_AUTHORITY_COLUMNS_IMMUTABLE'); END;

-- A provider-observed id (vk_external_id) or ERIR fact (erir_code, with its
-- own evidence), once set, can never be overwritten to a DIFFERENT value -
-- round-3 P0.4: a raw historical rewrite from ERIR code A to code B is no
-- longer possible; a genuine correction requires a new revision instead. A
-- same-value rewrite is an idempotent no-op the trigger does not need to
-- special-case.
CREATE TRIGGER ord_provider_operations_observed_id_immutable_guard
BEFORE UPDATE ON ord_provider_operations
WHEN (OLD.vk_external_id IS NOT NULL AND NEW.vk_external_id IS NOT OLD.vk_external_id)
  OR (OLD.erir_code IS NOT NULL AND NEW.erir_code IS NOT OLD.erir_code)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_OBSERVED_ID_IMMUTABLE'); END;

-- round-3 P1.4: EXTERNALLY_LOCKED is meant to be a chain-terminal fact - no
-- further revision will ever be minted. Locking a STALE (already-
-- superseded) revision would leave a newer CORRECTION_ONLY revision able
-- to keep advancing, so "terminal" would not actually be true for the
-- chain. Only the CURRENT (no strictly-higher revision yet exists) row may
-- ever be locked.
CREATE TRIGGER ord_provider_operations_lock_requires_current_guard
BEFORE UPDATE ON ord_provider_operations
WHEN NEW.lock_state = 'EXTERNALLY_LOCKED' AND OLD.lock_state != 'EXTERNALLY_LOCKED' AND EXISTS (
  SELECT 1 FROM ord_provider_operations newer WHERE newer.operation_kind = OLD.operation_kind AND newer.revision > OLD.revision
)
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_LOCK_REQUIRES_CURRENT'); END;

CREATE TRIGGER ord_provider_operations_delete_guard
BEFORE DELETE ON ord_provider_operations
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_OPERATION_IMMUTABLE'); END;

-- 4. Creative registration authority (plan §B-5, named exactly
-- "ord_creative_registrations"), now a REVISION CHAIN per the shared shape
-- documented at the top of this file (P0.2/P0.3): "at most one ACTIVE
-- registration per creative content revision" is MAX(revision) for the
-- creative_revision_id, never a bare UNIQUE(creative_revision_id) - which
-- could only ever represent "at most one, EVER" and left no room for a
-- genuine post-confirmation correction without either rewriting filed
-- history or falsely minting a new creative revision for content that
-- never changed (the exact L6 violation this fixes). UNIQUE(creative_
-- revision_id, revision) is the real structural backstop for "two
-- concurrent revision-1 registrations for C1 race": a second raw INSERT of
-- revision 1 for the same creative_revision_id collides on this
-- constraint regardless of caller.
--
-- A changed creative_hash always means a NEW engagement_creative_revisions
-- row, hence a fresh (unclaimed) creative_revision_id and therefore a
-- fresh chain here - never a correction revision of an existing chain - so
-- an ERID is never reused across a material creative change by
-- construction (L6).
CREATE TABLE ord_creative_registrations (
  id TEXT PRIMARY KEY,
  creative_revision_id TEXT NOT NULL REFERENCES engagement_creative_revisions(id),
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  revision INTEGER NOT NULL,
  supersedes_registration_id TEXT REFERENCES ord_creative_registrations(id),
  operation_key TEXT NOT NULL UNIQUE,
  provider_counterparty_profile_id TEXT NOT NULL REFERENCES ord_provider_profile_revisions(id),
  provider_contract_profile_id TEXT NOT NULL REFERENCES ord_provider_profile_revisions(id),
  registered_creative_target_url TEXT NOT NULL,
  local_state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (local_state IN ('DRAFT', 'SUBMITTED', 'CONFIRMED')),
  vk_submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (vk_submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_external_id TEXT,
  vk_object_id TEXT,
  erid TEXT,
  erir_code TEXT,
  erir_evidence_ref TEXT,
  evidence_ref TEXT,
  lock_state TEXT NOT NULL DEFAULT 'MUTABLE' CHECK (lock_state IN ('MUTABLE', 'CORRECTION_ONLY', 'EXTERNALLY_LOCKED')),
  correction_reason TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (creative_revision_id, revision),
  CHECK ((revision = 1) = (supersedes_registration_id IS NULL)),
  CHECK (revision = 1 OR correction_reason IS NOT NULL),
  -- Exact per-state shape (P0.3): CONFIRMED is the ONLY state
  -- CREATIVE_READY_TO_PUBLISH's provider half may ever accept, and it now
  -- structurally REQUIRES vk_submission_state = SUBMITTED and real
  -- evidence - "confirmed with an ERID but VK was never actually told"
  -- (the exact P0.3 counterexample) is no longer representable.
  CHECK (
    (local_state = 'DRAFT' AND vk_submission_state IN ('NOT_SUBMITTED', 'SUBMIT_FAILED') AND vk_external_id IS NULL AND vk_object_id IS NULL AND erid IS NULL AND evidence_ref IS NULL AND lock_state = 'MUTABLE')
    OR (local_state = 'SUBMITTED' AND vk_submission_state = 'SUBMITTED' AND vk_external_id IS NOT NULL AND vk_object_id IS NULL AND erid IS NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '' AND lock_state = 'MUTABLE')
    OR (local_state = 'CONFIRMED' AND vk_submission_state = 'SUBMITTED' AND vk_external_id IS NOT NULL AND vk_object_id IS NOT NULL AND erid IS NOT NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '' AND lock_state IN ('CORRECTION_ONLY', 'EXTERNALLY_LOCKED'))
  ),
  -- ERIR reconciliation evidence (round-3 P0.4) - never representable
  -- without its own durable provenance, and never before a real submission
  -- is on file (DRAFT can never carry a reconciliation fact).
  CHECK ((erir_code IS NULL) = (erir_evidence_ref IS NULL)),
  CHECK (erir_evidence_ref IS NULL OR trim(erir_evidence_ref) != ''),
  CHECK (local_state != 'DRAFT' OR erir_code IS NULL)
);
CREATE INDEX ord_creative_registrations_engagement_idx ON ord_creative_registrations(engagement_id);

-- Lineage + relational authority: revision > 1's predecessor is the SAME
-- creative_revision_id at EXACTLY revision - 1 and was itself already
-- CORRECTION_ONLY (only a committed/confirmed registration can be
-- corrected); registered_creative_target_url really is the named creative
-- revision's own creative_target_url; the provider-profile pins are real
-- CURRENT profiles of the right kind at insert time.
CREATE TRIGGER ord_creative_registrations_relational_consistency_guard
BEFORE INSERT ON ord_creative_registrations
WHEN NOT EXISTS (
  SELECT 1 FROM engagement_creative_revisions ecr
  WHERE ecr.id = NEW.creative_revision_id AND ecr.engagement_id = NEW.engagement_id AND ecr.creative_target_url = NEW.registered_creative_target_url
)
OR (NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM ord_creative_registrations prev WHERE prev.id = NEW.supersedes_registration_id AND prev.creative_revision_id = NEW.creative_revision_id AND prev.revision = NEW.revision - 1 AND prev.lock_state = 'CORRECTION_ONLY'
))
OR NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_counterparty_profile_id AND p.profile_kind = 'COUNTERPARTY'
    AND p.revision = (SELECT MAX(revision) FROM ord_provider_profile_revisions WHERE profile_kind = 'COUNTERPARTY')
)
OR NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_contract_profile_id AND p.profile_kind = 'CONTRACT'
    AND p.revision = (SELECT MAX(revision) FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT')
)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER ord_creative_registrations_terminal_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN OLD.lock_state = 'EXTERNALLY_LOCKED'
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER ord_creative_registrations_correction_only_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN OLD.lock_state = 'CORRECTION_ONLY' AND (
  NEW.local_state IS NOT OLD.local_state OR NEW.vk_submission_state IS NOT OLD.vk_submission_state OR NEW.vk_external_id IS NOT OLD.vk_external_id
  OR NEW.vk_object_id IS NOT OLD.vk_object_id OR NEW.erid IS NOT OLD.erid OR NEW.evidence_ref IS NOT OLD.evidence_ref
  OR (NEW.lock_state NOT IN ('CORRECTION_ONLY', 'EXTERNALLY_LOCKED'))
)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_CORRECTION_ONLY'); END;

CREATE TRIGGER ord_creative_registrations_authority_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN NEW.creative_revision_id IS NOT OLD.creative_revision_id
  OR NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.revision IS NOT OLD.revision
  OR NEW.supersedes_registration_id IS NOT OLD.supersedes_registration_id
  OR NEW.operation_key IS NOT OLD.operation_key
  OR NEW.provider_counterparty_profile_id IS NOT OLD.provider_counterparty_profile_id
  OR NEW.provider_contract_profile_id IS NOT OLD.provider_contract_profile_id
  OR NEW.registered_creative_target_url IS NOT OLD.registered_creative_target_url
  OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_AUTHORITY_COLUMNS_IMMUTABLE'); END;

-- A provider-observed identity (vk_external_id / vk_object_id / erid) or an
-- ERIR fact (erir_code), once set, can never be overwritten to a DIFFERENT
-- value - "provider external id rewritten after lock" and, more generally,
-- ever, even pre-lock (round-3 P0.4 extends this to erir_code: a raw
-- historical rewrite from ERIR code A to code B is no longer possible - a
-- genuine correction requires a new revision instead). A same-value
-- rewrite is an idempotent no-op the trigger does not need to special-case
-- (NEW IS NOT OLD is false when equal).
CREATE TRIGGER ord_creative_registrations_observed_ids_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN (OLD.vk_external_id IS NOT NULL AND NEW.vk_external_id IS NOT OLD.vk_external_id)
  OR (OLD.vk_object_id IS NOT NULL AND NEW.vk_object_id IS NOT OLD.vk_object_id)
  OR (OLD.erid IS NOT NULL AND NEW.erid IS NOT OLD.erid)
  OR (OLD.erir_code IS NOT NULL AND NEW.erir_code IS NOT OLD.erir_code)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_OBSERVED_ID_IMMUTABLE'); END;

-- round-3 P1.4: only the CURRENT (no strictly-higher revision yet exists)
-- registration for a creative_revision_id may ever be locked - locking a
-- stale revision would leave a newer CORRECTION_ONLY revision still able
-- to advance, breaking "EXTERNALLY_LOCKED is chain-terminal".
CREATE TRIGGER ord_creative_registrations_lock_requires_current_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN NEW.lock_state = 'EXTERNALLY_LOCKED' AND OLD.lock_state != 'EXTERNALLY_LOCKED' AND EXISTS (
  SELECT 1 FROM ord_creative_registrations newer WHERE newer.creative_revision_id = OLD.creative_revision_id AND newer.revision > OLD.revision
)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_LOCK_REQUIRES_CURRENT'); END;

CREATE TRIGGER ord_creative_registrations_delete_guard
BEFORE DELETE ON ord_creative_registrations
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_IMMUTABLE'); END;

-- 5. Distribution-period reporting authority (plan sections B-5c/B-10,
-- table named exactly "ord_distribution_period_reports"). Filed regulatory
-- evidence: NEVER UPDATEd - a correction is always the next revision, with
-- exact predecessor lineage, exactly engagement_distribution_revisions'
-- own pattern one table over. ERIR reconciliation arriving after a report
-- was filed is modelled the identical way (a correction revision whose
-- statistics AND distribution_revision_id are unchanged but whose
-- reconciliation evidence is new - see agent-referrals-ord-reporting.ts's
-- recordOrdDistributionPeriodReportReconciliation, which pins the
-- PREDECESSOR's own distribution_revision_id explicitly rather than
-- re-resolving "current" (P0.4): a distribution fact corrected AFTER a
-- report was filed against the OLD fact must never silently re-describe
-- that already-filed report as if it had always been about the NEW fact).
--
-- statistics_state/_json is the load-bearing invariant: REPORTING_DATA_
-- UNAVAILABLE forbids statistics_json outright (never a fabricated 0), and
-- ACTUAL requires it - enforced by CHECK, not merely by the application
-- writer, so a raw-SQL bypass cannot manufacture a zero for unavailable
-- data either. review_required is a STORED GENERATED column, mechanically
-- derived from statistics_state - REPORTING_DATA_UNAVAILABLE forces it to
-- 1 by construction (P0.6), not by convention any future caller could
-- forget; a reporting-tail-complete query is exactly "no current report for
-- this distribution has review_required = 1".
--
-- statistics_reason/zero_reward_closure_id keep ZERO_REWARD_STATISTICS and
-- CONTINUING_STATISTICS structurally distinct from ordinary reporting and
-- from each other (plan section B-3): both require a REAL
-- engagement_zero_reward_closures row for THIS distribution's own
-- engagement (never a fabricated zero-reward pretext, never merely
-- "amount happens to be low"), proven by the relational guard below, not
-- only by the CHECK's presence/absence pairing. PROVIDER_SPECIAL_PERIOD
-- zero/continuing classification is refused entirely in application code
-- (agent-referrals-ord-reporting.ts) until its exact period-ordering
-- representation is confirmed (P0.5) - this migration does not attempt to
-- encode a calendar-shaped comparison for a period whose own shape is
-- still PENDING_EXTERNAL_CONFIRMATION.
--
-- `evidence_ref` (always required) is the reported FACT's own evidence -
-- e.g. where the statistics figures came from - a wholly separate concern
-- from `submission_evidence_ref`, which evidences the CLAIM that this
-- report was actually submitted to VK. Conflating the two into one column
-- would force the submission-shape CHECK below to also require general
-- fact evidence be NULL for NOT_SUBMITTED reports, which is not what
-- either concern means - "independent" per the plan's own language.
--
-- Submission/reconciliation evidence has its own exact-shape CHECK
-- (P0.6): NOT_SUBMITTED carries no external id/erir/submission-evidence at
-- all; SUBMITTED requires a real vk_operation_external_id AND erir_code
-- AND a non-empty submission_evidence_ref together - independent local
-- authority, VK submission state and ERIR code, but a fact can never claim
-- "submitted" while leaving any of those three unproven.
CREATE TABLE ord_distribution_period_reports (
  id TEXT PRIMARY KEY,
  distribution_id TEXT NOT NULL REFERENCES engagement_distributions(id),
  distribution_revision_id TEXT NOT NULL REFERENCES engagement_distribution_revisions(id),
  reporting_basis TEXT NOT NULL CHECK (reporting_basis IN ('CALENDAR_MONTH', 'PROVIDER_SPECIAL_PERIOD')),
  reporting_period_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  supersedes_report_id TEXT REFERENCES ord_distribution_period_reports(id),
  statistics_state TEXT NOT NULL CHECK (statistics_state IN ('ACTUAL', 'REPORTING_DATA_UNAVAILABLE')),
  statistics_json TEXT,
  review_required INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN statistics_state = 'REPORTING_DATA_UNAVAILABLE' THEN 1 ELSE 0 END) STORED,
  statistics_reason TEXT NOT NULL DEFAULT 'ORDINARY' CHECK (statistics_reason IN ('ORDINARY', 'ZERO_REWARD_STATISTICS', 'CONTINUING_STATISTICS')),
  zero_reward_closure_id TEXT REFERENCES engagement_zero_reward_closures(id),
  operation_key TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_operation_external_id TEXT,
  erir_code TEXT,
  submission_evidence_ref TEXT,
  correction_reason TEXT,
  canonical_hash TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (distribution_id, reporting_period_key, revision),
  CHECK (revision = 1 OR correction_reason IS NOT NULL),
  CHECK ((revision = 1) = (supersedes_report_id IS NULL)),
  CHECK (
    (statistics_state = 'ACTUAL' AND statistics_json IS NOT NULL)
    OR (statistics_state = 'REPORTING_DATA_UNAVAILABLE' AND statistics_json IS NULL)
  ),
  CHECK (
    (statistics_reason = 'ORDINARY' AND zero_reward_closure_id IS NULL)
    OR (statistics_reason IN ('ZERO_REWARD_STATISTICS', 'CONTINUING_STATISTICS') AND zero_reward_closure_id IS NOT NULL)
  ),
  CHECK (
    (submission_state = 'NOT_SUBMITTED' AND vk_operation_external_id IS NULL AND erir_code IS NULL AND submission_evidence_ref IS NULL)
    OR (submission_state = 'SUBMIT_FAILED' AND vk_operation_external_id IS NULL AND erir_code IS NULL)
    OR (submission_state = 'SUBMITTED' AND vk_operation_external_id IS NOT NULL AND erir_code IS NOT NULL AND submission_evidence_ref IS NOT NULL AND trim(submission_evidence_ref) != '')
  )
);
CREATE INDEX ord_distribution_period_reports_distribution_idx ON ord_distribution_period_reports(distribution_id, reporting_period_key, revision);
CREATE INDEX ord_distribution_period_reports_zero_reward_idx ON ord_distribution_period_reports(zero_reward_closure_id);
CREATE INDEX ord_distribution_period_reports_review_required_idx ON ord_distribution_period_reports(distribution_id, review_required);

-- The exact predecessor lineage (plan's own required invariant list):
--   - distribution_revision_id genuinely belongs to distribution_id
--   - revision 1 has no predecessor; revision > 1's predecessor is EXACTLY
--     revision - 1 on the SAME distribution_id + reporting_period_key (a
--     wrong predecessor, a cross-distribution or cross-period supersession
--     all fail this join)
--   - a zero_reward_closure_id, when present, belongs to THIS report's own
--     distribution's engagement (never a foreign engagement's closure) and
--     is a genuine current closure (UNIQUE(engagement_id) on that table
--     already makes "genuine" trivial - there is at most one, ever)
--   - ZERO_REWARD_STATISTICS/CONTINUING_STATISTICS additionally require
--     NO live/paid AGENT_REFERRALS settlement to exist for that engagement
--     (mirrors engagement_zero_reward_closures' own mutual-exclusion guard
--     one migration over - "zero-reward operation -> positive E / real
--     settlement" must fail)
CREATE TRIGGER ord_distribution_period_reports_relational_consistency_guard
BEFORE INSERT ON ord_distribution_period_reports
WHEN NOT EXISTS (SELECT 1 FROM engagement_distribution_revisions edr WHERE edr.id = NEW.distribution_revision_id AND edr.distribution_id = NEW.distribution_id)
OR (NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM ord_distribution_period_reports prev
  WHERE prev.id = NEW.supersedes_report_id AND prev.distribution_id = NEW.distribution_id
    AND prev.reporting_period_key = NEW.reporting_period_key AND prev.revision = NEW.revision - 1
))
OR (NEW.zero_reward_closure_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM engagement_zero_reward_closures z JOIN engagement_distributions d ON d.engagement_id = z.engagement_id
  WHERE z.id = NEW.zero_reward_closure_id AND d.id = NEW.distribution_id
))
OR (NEW.statistics_reason IN ('ZERO_REWARD_STATISTICS', 'CONTINUING_STATISTICS') AND EXISTS (
  SELECT 1 FROM engagement_distributions d JOIN reward_settlements rs ON rs.engagement_id = d.engagement_id
  WHERE d.id = NEW.distribution_id AND rs.settlement_flow = 'AGENT_REFERRALS' AND rs.status != 'CANCELLED_BEFORE_PAYMENT'
))
BEGIN SELECT RAISE(ABORT, 'ORD_DISTRIBUTION_PERIOD_REPORT_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER ord_distribution_period_reports_immutable_guard
BEFORE UPDATE ON ord_distribution_period_reports
BEGIN SELECT RAISE(ABORT, 'ORD_DISTRIBUTION_PERIOD_REPORT_IMMUTABLE'); END;
CREATE TRIGGER ord_distribution_period_reports_delete_guard
BEFORE DELETE ON ord_distribution_period_reports
BEGIN SELECT RAISE(ABORT, 'ORD_DISTRIBUTION_PERIOD_REPORT_IMMUTABLE'); END;

-- 6. VK paid-invoice payload authority (plan Phase 8: "VKPaidInvoicePayload
-- ... constructible only from an exact ACT_ACCEPTED revision; every field
-- from pinned immutable sources"). UNIQUE(act_id): one payload per act,
-- ever - minting is idempotent, never a second divergent payload for the
-- same act. Every payload field below is copied from ALREADY-immutable
-- pinned sources (settlement_acts' own amount/engagement/partner columns,
-- settlement_act_acceptances' own accepted_amount_kopecks/
-- accepted_engagement_revision_id, reward_settlements' own tax_mode_
-- snapshot/legal_profile_revision_id_snapshot/contractor_type_snapshot) -
-- never a live re-read of a CURRENT/mutable table - so the payload is
-- byte-identical forever after minting even if the partner's legal profile,
-- payout profile, or current creative authorization later change. No
-- customer PII column exists on this table at all.
--
-- Exact-shape CHECK (P0.6): EXTERNALLY_LOCKED now requires
-- vk_operation_external_id AND erir_code AND a real non-empty evidence_ref
-- together - "reconciled" can no longer be claimed via erir_code alone
-- with no external operation id and no durable provenance.
CREATE TABLE ord_paid_invoice_payloads (
  id TEXT PRIMARY KEY,
  act_id TEXT NOT NULL UNIQUE REFERENCES settlement_acts(id),
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  accepted_amount_kopecks INTEGER NOT NULL CHECK (accepted_amount_kopecks > 0),
  accepted_engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  tax_mode_snapshot TEXT NOT NULL CHECK (tax_mode_snapshot IN ('NPD', 'OTHER')),
  legal_profile_revision_id_snapshot TEXT NOT NULL,
  contractor_type_snapshot TEXT NOT NULL,
  provider_contract_profile_id TEXT NOT NULL REFERENCES ord_provider_profile_revisions(id),
  operation_key TEXT NOT NULL UNIQUE,
  submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_operation_external_id TEXT,
  erir_code TEXT,
  evidence_ref TEXT,
  lock_state TEXT NOT NULL DEFAULT 'MUTABLE' CHECK (lock_state IN ('MUTABLE', 'EXTERNALLY_LOCKED')),
  canonical_hash TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Round-3 P1.1: four MUTUALLY EXCLUSIVE exact shapes, one per real state -
  -- not a loose "MUTABLE admits anything but SUBMITTED-without-evidence"
  -- branch, which still let raw SQL fabricate e.g. NOT_SUBMITTED with a
  -- populated vk_operation_external_id/erir_code, or SUBMIT_FAILED with
  -- external ids attached.
  CHECK (
    (lock_state = 'MUTABLE' AND submission_state = 'NOT_SUBMITTED' AND vk_operation_external_id IS NULL AND erir_code IS NULL AND evidence_ref IS NULL)
    OR (lock_state = 'MUTABLE' AND submission_state = 'SUBMIT_FAILED' AND vk_operation_external_id IS NULL AND erir_code IS NULL AND evidence_ref IS NULL)
    OR (lock_state = 'MUTABLE' AND submission_state = 'SUBMITTED' AND vk_operation_external_id IS NOT NULL AND erir_code IS NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '')
    OR (lock_state = 'EXTERNALLY_LOCKED' AND submission_state = 'SUBMITTED' AND vk_operation_external_id IS NOT NULL AND erir_code IS NOT NULL AND evidence_ref IS NOT NULL AND trim(evidence_ref) != '')
  )
);

-- Proves every pinned field really is that exact act's own frozen authority:
-- the act belongs to settlement_id/engagement_id/partner_identity_id named;
-- a genuine acceptance exists for this act whose OWN accepted_amount_kopecks
-- and accepted_engagement_revision_id equal what this payload claims (never
-- a caller-supplied amount overriding the accepted act); and the
-- settlement's own pinned tax_mode_snapshot/legal_profile_revision_id_
-- snapshot/contractor_type_snapshot equal what this payload claims (never a
-- mismatched or fabricated legal/tax fact). provider_contract_profile_id
-- must be a real CURRENT CONTRACT profile at insert time.
CREATE TRIGGER ord_paid_invoice_payloads_relational_consistency_guard
BEFORE INSERT ON ord_paid_invoice_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM settlement_acts a
  WHERE a.id = NEW.act_id AND a.settlement_id = NEW.settlement_id AND a.engagement_id = NEW.engagement_id AND a.partner_identity_id = NEW.partner_identity_id
)
OR NOT EXISTS (
  SELECT 1 FROM settlement_act_acceptances acc
  WHERE acc.act_id = NEW.act_id AND acc.accepted_amount_kopecks = NEW.accepted_amount_kopecks AND acc.accepted_engagement_revision_id = NEW.accepted_engagement_revision_id
)
OR NOT EXISTS (
  SELECT 1 FROM reward_settlements rs
  WHERE rs.id = NEW.settlement_id AND rs.settlement_flow = 'AGENT_REFERRALS'
    AND rs.tax_mode_snapshot = NEW.tax_mode_snapshot AND rs.legal_profile_revision_id_snapshot = NEW.legal_profile_revision_id_snapshot AND rs.contractor_type_snapshot = NEW.contractor_type_snapshot
)
OR NOT EXISTS (
  SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_contract_profile_id AND p.profile_kind = 'CONTRACT'
    AND p.revision = (SELECT MAX(revision) FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT')
)
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_RELATIONAL_INCONSISTENT'); END;

CREATE TRIGGER ord_paid_invoice_payloads_terminal_immutable_guard
BEFORE UPDATE ON ord_paid_invoice_payloads
WHEN OLD.lock_state = 'EXTERNALLY_LOCKED'
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER ord_paid_invoice_payloads_authority_immutable_guard
BEFORE UPDATE ON ord_paid_invoice_payloads
WHEN NEW.act_id IS NOT OLD.act_id OR NEW.settlement_id IS NOT OLD.settlement_id OR NEW.engagement_id IS NOT OLD.engagement_id OR NEW.partner_identity_id IS NOT OLD.partner_identity_id
  OR NEW.accepted_amount_kopecks IS NOT OLD.accepted_amount_kopecks OR NEW.accepted_engagement_revision_id IS NOT OLD.accepted_engagement_revision_id
  OR NEW.tax_mode_snapshot IS NOT OLD.tax_mode_snapshot OR NEW.legal_profile_revision_id_snapshot IS NOT OLD.legal_profile_revision_id_snapshot OR NEW.contractor_type_snapshot IS NOT OLD.contractor_type_snapshot
  OR NEW.provider_contract_profile_id IS NOT OLD.provider_contract_profile_id OR NEW.operation_key IS NOT OLD.operation_key OR NEW.canonical_hash IS NOT OLD.canonical_hash
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_AUTHORITY_COLUMNS_IMMUTABLE'); END;

CREATE TRIGGER ord_paid_invoice_payloads_observed_id_immutable_guard
BEFORE UPDATE ON ord_paid_invoice_payloads
WHEN OLD.vk_operation_external_id IS NOT NULL AND NEW.vk_operation_external_id IS NOT OLD.vk_operation_external_id
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_OBSERVED_ID_IMMUTABLE'); END;

CREATE TRIGGER ord_paid_invoice_payloads_delete_guard
BEFORE DELETE ON ord_paid_invoice_payloads
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_IMMUTABLE'); END;
