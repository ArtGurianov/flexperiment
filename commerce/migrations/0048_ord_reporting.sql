-- Agent Referrals ORD/ERIR reporting: local/manual VK ORD provider profile
-- evidence, creative-registration authority (completing PR5's
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
  UNIQUE (profile_kind, revision)
);
CREATE TRIGGER ord_provider_profile_revisions_immutable_guard
BEFORE UPDATE ON ord_provider_profile_revisions
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE'); END;
CREATE TRIGGER ord_provider_profile_revisions_delete_guard
BEFORE DELETE ON ord_provider_profile_revisions
BEGIN SELECT RAISE(ABORT, 'ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE'); END;

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

-- 3. Creative registration authority (plan section B-5, named exactly
-- "ord_creative_registrations"). Keyed 1:1 to a creative CONTENT revision
-- (UNIQUE, not merely enforced by app-level idempotency) - this is the real
-- structural backstop for "at most one active registration per creative
-- content revision" and for the "two concurrent registrations for C1" race:
-- a second raw INSERT for the same creative_revision_id collides on this
-- UNIQUE constraint regardless of caller. A changed creative_hash always
-- means a NEW engagement_creative_revisions row, hence a fresh (unclaimed)
-- creative_revision_id here - never a second revision of THIS row - so an
-- ERID is never reused across a material creative change by construction,
-- not merely by convention (L6).
--
-- Structural independence of local authority/state, VK submission state,
-- ERIR reconciliation code, external lock state and observed provider ids
-- (per PR8's own review brief): local_state is OUR OWN business progress;
-- vk_submission_state is what we attempted to tell VK; vk_external_id/
-- vk_object_id/erid are NULLABLE OBSERVED facts VK reported back, never
-- assumed from a nullable id merely existing; erir_code is the separate
-- Roskomnadzor reconciliation fact. lock_state starts MUTABLE (recording
-- provider-observed facts as they arrive is ordinary progress, not a
-- correction) and becomes EXTERNALLY_LOCKED exactly once vk_object_id AND
-- erid are both on file - after that, no UPDATE of any kind is legal ever
-- again (the terminal-immutable guard below), matching "raw UPDATE cannot
-- rewrite filed facts once externally locked".
--
-- registered_creative_target_url is a pinned COPY of the creative's own
-- creative_target_url as of registration mint time - the frozen registered
-- fact CREATIVE_READY_TO_PUBLISH's provider half compares against,
-- independent evidence rather than a live re-read (the creative row is
-- itself immutable, so the two can never actually diverge, but pinning
-- keeps this table self-contained evidence, the same rationale PR7 pinned
-- reward_registry_hash onto reward_settlements rather than re-reading R).
--
-- Gated NEW_AUTHORITY (ORD_CREATIVE_REGISTRATION) for its ENTIRE lifecycle,
-- not only the initial mint: recording vk_object_id/erid and locking is
-- still completing authority that does not yet exist as a filed fact, the
-- same class as authorizeCreative itself (NEW_PUBLICATION_AUTHORITY) -
-- SUSPENDED must not let a registration silently complete into a locked,
-- ERID-bearing fact once the feature has been suspended.
CREATE TABLE ord_creative_registrations (
  id TEXT PRIMARY KEY,
  creative_revision_id TEXT NOT NULL UNIQUE REFERENCES engagement_creative_revisions(id),
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
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
  lock_state TEXT NOT NULL DEFAULT 'MUTABLE' CHECK (lock_state IN ('MUTABLE', 'EXTERNALLY_LOCKED')),
  evidence_ref TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (lock_state = 'MUTABLE' OR (vk_object_id IS NOT NULL AND erid IS NOT NULL))
);
CREATE INDEX ord_creative_registrations_engagement_idx ON ord_creative_registrations(engagement_id);

-- Proves the registration's own provider-profile pins are real CURRENT
-- profiles of the right kind at mint time (never a stale or wrong-kind
-- profile id), and that registered_creative_target_url really is the named
-- creative revision's own creative_target_url (never a fabricated/mismatched
-- pin) - "can raw SQL create a plausible but false regulatory fact" applied
-- to this table's own insert-time authority.
CREATE TRIGGER ord_creative_registrations_relational_consistency_guard
BEFORE INSERT ON ord_creative_registrations
WHEN NOT EXISTS (
  SELECT 1 FROM engagement_creative_revisions ecr
  WHERE ecr.id = NEW.creative_revision_id AND ecr.engagement_id = NEW.engagement_id AND ecr.creative_target_url = NEW.registered_creative_target_url
)
OR NOT EXISTS (SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_counterparty_profile_id AND p.profile_kind = 'COUNTERPARTY')
OR NOT EXISTS (SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_contract_profile_id AND p.profile_kind = 'CONTRACT')
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_RELATIONAL_INCONSISTENT'); END;

-- Once EXTERNALLY_LOCKED, no further UPDATE of any kind - the ERID and every
-- other filed fact on this row are permanently frozen. A material creative
-- change never reuses this row; it mints an entirely new
-- engagement_creative_revisions + a new ord_creative_registrations row.
CREATE TRIGGER ord_creative_registrations_terminal_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN OLD.lock_state = 'EXTERNALLY_LOCKED'
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_TERMINAL_IMMUTABLE'); END;

-- Identity/authority columns never move once written, even pre-lock -
-- exactly PR6/PR7's "authority columns immutable, ordinary progress fields
-- remain mutable" split. Only local_state/vk_submission_state/
-- vk_external_id/vk_object_id/erid/erir_code/lock_state/evidence_ref may
-- ever change (via the ordinary pre-lock UPDATE path the app functions use).
CREATE TRIGGER ord_creative_registrations_authority_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN NEW.creative_revision_id IS NOT OLD.creative_revision_id
  OR NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.operation_key IS NOT OLD.operation_key
  OR NEW.provider_counterparty_profile_id IS NOT OLD.provider_counterparty_profile_id
  OR NEW.provider_contract_profile_id IS NOT OLD.provider_contract_profile_id
  OR NEW.registered_creative_target_url IS NOT OLD.registered_creative_target_url
  OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_AUTHORITY_COLUMNS_IMMUTABLE'); END;

-- A provider-observed identity (vk_external_id / vk_object_id / erid), once
-- set to a non-NULL value, can never be overwritten to a DIFFERENT value -
-- "provider external id rewritten after lock" and, more generally, ever -
-- even pre-lock. Recording the exact same value again is a no-op the
-- trigger does not need to special-case (NEW IS NOT OLD is false when equal).
CREATE TRIGGER ord_creative_registrations_observed_ids_immutable_guard
BEFORE UPDATE ON ord_creative_registrations
WHEN (OLD.vk_external_id IS NOT NULL AND NEW.vk_external_id IS NOT OLD.vk_external_id)
  OR (OLD.vk_object_id IS NOT NULL AND NEW.vk_object_id IS NOT OLD.vk_object_id)
  OR (OLD.erid IS NOT NULL AND NEW.erid IS NOT OLD.erid)
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_OBSERVED_ID_IMMUTABLE'); END;

CREATE TRIGGER ord_creative_registrations_delete_guard
BEFORE DELETE ON ord_creative_registrations
BEGIN SELECT RAISE(ABORT, 'ORD_CREATIVE_REGISTRATION_IMMUTABLE'); END;

-- 4. Distribution-period reporting authority (plan sections B-5c/B-10,
-- table named exactly "ord_distribution_period_reports"). Filed regulatory
-- evidence: NEVER UPDATEd - a correction is always the next revision, with
-- exact predecessor lineage, exactly engagement_distribution_revisions'
-- own pattern one table over. ERIR reconciliation arriving after a report
-- was filed is modelled the identical way (a correction revision whose
-- statistics are unchanged but whose reconciliation evidence is new) -
-- deliberately no separate mutable "reconciliation status" column that
-- could let regulatory evidence drift without its own revision.
--
-- statistics_state/_json is the load-bearing invariant: REPORTING_DATA_
-- UNAVAILABLE forbids statistics_json outright (never a fabricated 0), and
-- ACTUAL requires it - enforced by CHECK, not merely by the application
-- writer, so a raw-SQL bypass cannot manufacture a zero for unavailable
-- data either.
--
-- statistics_reason/zero_reward_closure_id keep ZERO_REWARD_STATISTICS and
-- CONTINUING_STATISTICS structurally distinct from ordinary reporting and
-- from each other (plan section B-3): both require a REAL
-- engagement_zero_reward_closures row for THIS distribution's own
-- engagement (never a fabricated zero-reward pretext, never merely
-- "amount happens to be low"), proven by the relational guard below, not
-- only by the CHECK's presence/absence pairing.
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
  statistics_reason TEXT NOT NULL DEFAULT 'ORDINARY' CHECK (statistics_reason IN ('ORDINARY', 'ZERO_REWARD_STATISTICS', 'CONTINUING_STATISTICS')),
  zero_reward_closure_id TEXT REFERENCES engagement_zero_reward_closures(id),
  operation_key TEXT NOT NULL UNIQUE,
  submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submission_state IN ('NOT_SUBMITTED', 'SUBMITTED', 'SUBMIT_FAILED')),
  vk_operation_external_id TEXT,
  erir_code TEXT,
  evidence_ref TEXT,
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
  )
);
CREATE INDEX ord_distribution_period_reports_distribution_idx ON ord_distribution_period_reports(distribution_id, reporting_period_key, revision);
CREATE INDEX ord_distribution_period_reports_zero_reward_idx ON ord_distribution_period_reports(zero_reward_closure_id);

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

-- 5. VK paid-invoice payload authority (plan Phase 8: "VKPaidInvoicePayload
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
  lock_state TEXT NOT NULL DEFAULT 'MUTABLE' CHECK (lock_state IN ('MUTABLE', 'EXTERNALLY_LOCKED')),
  canonical_hash TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (lock_state = 'MUTABLE' OR erir_code IS NOT NULL)
);

-- Proves every pinned field really is that exact act's own frozen authority:
-- the act belongs to settlement_id/engagement_id/partner_identity_id named;
-- a genuine acceptance exists for this act whose OWN accepted_amount_kopecks
-- and accepted_engagement_revision_id equal what this payload claims (never
-- a caller-supplied amount overriding the accepted act); and the
-- settlement's own pinned tax_mode_snapshot/legal_profile_revision_id_
-- snapshot/contractor_type_snapshot equal what this payload claims (never a
-- mismatched or fabricated legal/tax fact).
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
OR NOT EXISTS (SELECT 1 FROM ord_provider_profile_revisions p WHERE p.id = NEW.provider_contract_profile_id AND p.profile_kind = 'CONTRACT')
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

CREATE TRIGGER ord_paid_invoice_payloads_delete_guard
BEFORE DELETE ON ord_paid_invoice_payloads
BEGIN SELECT RAISE(ABORT, 'ORD_PAID_INVOICE_PAYLOAD_IMMUTABLE'); END;
