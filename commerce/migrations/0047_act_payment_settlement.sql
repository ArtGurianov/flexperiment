-- Agent Referrals act/payment/settlement authority (plan section B-6/B-7,
-- Phase 7). settlement_flow partitions the existing four-state
-- reward_settlements lifecycle (PREPARED -> PENDING_DOCUMENT -> SETTLED,
-- PREPARED -> CANCELLED_BEFORE_PAYMENT, F5) between LEGACY (untouched) and
-- AGENT_REFERRALS (derived-from-E, never caller input). Ordinary migration
-- - not FK-off. No ORD/VK/ERIR provider schema (0048+).
--
-- reward_settlements is NOT rebuilt (it has real ongoing legacy UPDATE
-- traffic via prepareSettlement()/markSettlementPaymentMade()/
-- completeSettlementDocuments()/cancelSettlementBeforePayment(), and a
-- rebuild would require FK-off - out of scope, exactly the 0046 rationale
-- for `orders`). Every new column is `ALTER TABLE ... ADD COLUMN`; the two
-- structural invariants a multi-column CHECK would normally carry (tuple
-- consistency, column immutability) are triggers instead, exactly the 0046
-- pattern.

-- 1. settlement_flow. Historical NULL cannot exist here (unlike 0046's
-- nullable referral_rewards.reward_authority_kind): NOT NULL DEFAULT
-- 'LEGACY' backfills every existing row to the true, not fabricated,
-- classification via ALTER TABLE's own default fill (no application
-- backfill logic runs), and every future legacy-path INSERT (the unchanged
-- prepareSettlement()) continues to omit this column and gets 'LEGACY' for
-- free - domain.ts's legacy INSERT statement needs no edit at all.
ALTER TABLE reward_settlements ADD COLUMN settlement_flow TEXT NOT NULL DEFAULT 'LEGACY' CHECK (settlement_flow IN ('LEGACY', 'AGENT_REFERRALS'));

-- 2. Agent Referrals authority pins. All NULL for LEGACY; all-or-nothing
-- for AGENT_REFERRALS, proven relationally below - not merely non-NULL.
-- amount_kopecks (the pre-existing column) is proven equal to the pinned
-- effective snapshot's own total in the same guard: this is the literal
-- structural proof that F10's "amount is derived, never supplied" holds -
-- raw SQL cannot insert an AGENT_REFERRALS row whose amount disagrees with
-- its own pinned E.
ALTER TABLE reward_settlements ADD COLUMN engagement_id TEXT REFERENCES engagements(id);
ALTER TABLE reward_settlements ADD COLUMN engagement_revision_id TEXT REFERENCES engagement_revisions(id);
ALTER TABLE reward_settlements ADD COLUMN base_registry_snapshot_id TEXT REFERENCES engagement_reward_registry_snapshot(id);
ALTER TABLE reward_settlements ADD COLUMN effective_reward_snapshot_id TEXT REFERENCES engagement_effective_reward_snapshots(id);
ALTER TABLE reward_settlements ADD COLUMN partner_identity_id TEXT REFERENCES partner_identities(id);
ALTER TABLE reward_settlements ADD COLUMN payout_profile_revision_id TEXT REFERENCES payout_profile_revisions(id);
ALTER TABLE reward_settlements ADD COLUMN tax_mode_snapshot TEXT CHECK (tax_mode_snapshot IS NULL OR tax_mode_snapshot IN ('NPD', 'OTHER'));
ALTER TABLE reward_settlements ADD COLUMN legal_profile_revision_id_snapshot TEXT REFERENCES agent_referrals_legal_profile_revisions(id);
-- Supersession lineage (§B-6). Points at the OLD settlement this one
-- replaces after a reward correction; cancellation_reason is written onto
-- the OLD row at the moment it is cancelled (never onto the new one) -
-- these are deliberately two different rows' evidence, matching the
-- plan's own language ("old settlement -> CANCELLED_BEFORE_PAYMENT reason
-- = SUPERSEDED_BY_REWARD_CORRECTION", a fact about the OLD row; "new
-- settlement supersedes_settlement_id = old.id", a fact about the NEW
-- one). Legacy's own cancelSettlementBeforePayment() keeps using the
-- pre-existing free-text `note` column exactly as before - untouched.
ALTER TABLE reward_settlements ADD COLUMN supersedes_settlement_id TEXT REFERENCES reward_settlements(id);
ALTER TABLE reward_settlements ADD COLUMN cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION');

-- No half-shaped authority row: LEGACY carries no AGENT_REFERRALS pin at
-- all; AGENT_REFERRALS carries every one of them, RELATIONALLY consistent
-- (not merely non-NULL):
--   amount_kopecks == the pinned effective snapshot's own reward_total_kopecks
--     (F10 - the derived-not-supplied proof)
--   the pinned E actually belongs to the pinned engagement/revision/R
--   the engagement's occurrence is actually COMPLETED (§B-6 hard invariant
--     on positive payout authority - CANCELLED-terminal engagements can
--     never reach a positive E per PR6's own absorbing-zero correction
--     rule, but this is the direct, load-bearing recheck at the
--     settlement-authority boundary itself)
--   partner_identity_id really owns agent_id, and really owns this exact
--     engagement/occurrence (closes "settlement points at the wrong
--     partner")
--   the payout profile really belongs to this partner and is the CURRENT
--     usable (ACTIVE_DESTINATION, not REVOKED, not a superseded revision)
--     one - the "payout profile still usable" recheck, at creation time
--   supersession lineage, when present: the named predecessor is itself a
--     genuine AGENT_REFERRALS settlement for the SAME engagement, already
--     CANCELLED_BEFORE_PAYMENT for exactly SUPERSEDED_BY_REWARD_CORRECTION,
--     and this row's own E is the pinned IMMEDIATE successor
--     (supersedes_effective_snapshot_id) of the predecessor's own E - so a
--     replacement settlement can never attach to a stale or unrelated E,
--     never skip a step in the chain, never re-base onto a different
--     engagement.
-- "At most one settlement per E, ever" is NOT this trigger's job - see the
-- partial UNIQUE index below, which is the real backstop a raw concurrent
-- duplicate write still hits (a WHEN-clause NOT-EXISTS is not safe against
-- that race by itself).
CREATE TRIGGER reward_settlements_authority_tuple_consistency_guard
BEFORE INSERT ON reward_settlements
WHEN NOT (
  (NEW.settlement_flow = 'LEGACY'
    AND NEW.engagement_id IS NULL AND NEW.engagement_revision_id IS NULL
    AND NEW.base_registry_snapshot_id IS NULL AND NEW.effective_reward_snapshot_id IS NULL
    AND NEW.partner_identity_id IS NULL AND NEW.payout_profile_revision_id IS NULL
    AND NEW.tax_mode_snapshot IS NULL AND NEW.legal_profile_revision_id_snapshot IS NULL
    AND NEW.supersedes_settlement_id IS NULL AND NEW.cancellation_reason IS NULL)
  OR
  (NEW.settlement_flow = 'AGENT_REFERRALS'
    AND NEW.engagement_id IS NOT NULL AND NEW.engagement_revision_id IS NOT NULL
    AND NEW.base_registry_snapshot_id IS NOT NULL AND NEW.effective_reward_snapshot_id IS NOT NULL
    AND NEW.partner_identity_id IS NOT NULL AND NEW.payout_profile_revision_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM engagement_effective_reward_snapshots e
      WHERE e.id = NEW.effective_reward_snapshot_id
        AND e.engagement_id = NEW.engagement_id
        AND e.engagement_revision_id = NEW.engagement_revision_id
        AND e.base_registry_snapshot_id = NEW.base_registry_snapshot_id
        AND e.reward_total_kopecks = NEW.amount_kopecks
    )
    AND EXISTS (
      SELECT 1 FROM engagements en JOIN occurrences o ON o.id = en.occurrence_id
      WHERE en.id = NEW.engagement_id AND en.occurrence_id = NEW.occurrence_id AND o.fulfillment_status = 'COMPLETED'
    )
    AND EXISTS (SELECT 1 FROM partner_identities pi WHERE pi.id = NEW.partner_identity_id AND pi.agent_id = NEW.agent_id)
    AND EXISTS (SELECT 1 FROM engagements en2 WHERE en2.id = NEW.engagement_id AND en2.partner_identity_id = NEW.partner_identity_id)
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

-- At most one settlement per effective snapshot, ever - the real
-- structural backstop for "two preparePartnerSettlement writers for the
-- same E" (a WHEN-clause NOT EXISTS is not safe against that race by
-- itself; a partial UNIQUE index is).
CREATE UNIQUE INDEX reward_settlements_effective_snapshot_unique
  ON reward_settlements(effective_reward_snapshot_id) WHERE effective_reward_snapshot_id IS NOT NULL;

-- DB-immutable authority columns. Deliberately narrow - this must NOT
-- block the legacy status-machine UPDATEs
-- (markSettlementPaymentMade/completeSettlementDocuments/
-- cancelSettlementBeforePayment) or this PR's own new AGENT_REFERRALS
-- status transitions (PREPARED -> PENDING_DOCUMENT -> SETTLED, PREPARED ->
-- CANCELLED_BEFORE_PAYMENT), both of which legitimately UPDATE `status`
-- and its timestamp/document columns. cancellation_reason is deliberately
-- OMITTED here: it is written exactly once, in the same UPDATE that moves
-- status to CANCELLED_BEFORE_PAYMENT for supersession, and no further
-- UPDATE of any kind is legal against a CANCELLED_BEFORE_PAYMENT row in
-- either flow - so it needs no separate guard.
CREATE TRIGGER reward_settlements_authority_columns_immutable_guard
BEFORE UPDATE ON reward_settlements
WHEN NEW.settlement_flow IS NOT OLD.settlement_flow
  OR NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.engagement_revision_id IS NOT OLD.engagement_revision_id
  OR NEW.base_registry_snapshot_id IS NOT OLD.base_registry_snapshot_id
  OR NEW.effective_reward_snapshot_id IS NOT OLD.effective_reward_snapshot_id
  OR NEW.partner_identity_id IS NOT OLD.partner_identity_id
  OR NEW.payout_profile_revision_id IS NOT OLD.payout_profile_revision_id
  OR NEW.tax_mode_snapshot IS NOT OLD.tax_mode_snapshot
  OR NEW.legal_profile_revision_id_snapshot IS NOT OLD.legal_profile_revision_id_snapshot
  OR NEW.supersedes_settlement_id IS NOT OLD.supersedes_settlement_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.occurrence_id IS NOT OLD.occurrence_id
  OR NEW.amount_kopecks IS NOT OLD.amount_kopecks
BEGIN SELECT RAISE(ABORT, 'REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE'); END;

-- 3. Settlement-scoped step-up grants (Phase 7's own table, parallel to
-- 0044's step_up_grants and 0045's engagement_step_up_grants - see 0045's
-- header for why an existing action-CHECK table cannot simply admit a new
-- value without an FK-off rebuild). ACT_ACCEPTANCE is partner-only by
-- construction: nothing in this schema lets an AdminPrincipal ever consume
-- one (application code, agent-referrals-settlement-step-up.ts, only
-- accepts a PartnerPrincipal - the identical structural argument already
-- relied on for acceptEngagement/framework acceptance).
CREATE TABLE settlement_step_up_grants (
  id TEXT PRIMARY KEY,
  partner_session_id TEXT NOT NULL REFERENCES partner_sessions(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  action TEXT NOT NULL CHECK (action = 'ACT_ACCEPTANCE'),
  resource_json TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX settlement_step_up_grants_partner_idx ON settlement_step_up_grants(partner_identity_id);

-- 4. Acts. Not a mutable document row: identity/financial pin is immutable
-- from creation, and "accepted"/"disputed" are separate append-only
-- evidence tables below rather than a mutable status column - so there is
-- no "accepted=true" flag anywhere for raw SQL (or a future careless
-- caller) to flip without producing the immutable acceptance evidence that
-- is supposed to justify it. presented_at is the one legitimate one-way
-- mutation (ACT_PREPARED -> ACT_PRESENTED), mirroring
-- partner_identity_legal_holds' released_at pattern exactly: NULL ->
-- timestamp, once, never reversible, nothing else on the row changes with
-- it. UNIQUE(settlement_id) means a superseding settlement (a distinct
-- row, minted fresh after correction/supersession) starts with NO act at
-- all - it is structurally impossible for BEGIN_PAYMENT to ever find an
-- old accepted act for a new settlement id, which is exactly "old accepted
-- act does not authorize a superseding settlement".
CREATE TABLE settlement_acts (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL UNIQUE REFERENCES reward_settlements(id),
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  effective_reward_snapshot_id TEXT NOT NULL REFERENCES engagement_effective_reward_snapshots(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  presented_at TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX settlement_acts_partner_idx ON settlement_acts(partner_identity_id);
-- The act's own pin must exactly mirror the AGENT_REFERRALS settlement it
-- names - never a formally-linked-but-fabricated amount/revision/partner.
CREATE TRIGGER settlement_acts_relational_consistency_guard
BEFORE INSERT ON settlement_acts
WHEN NOT EXISTS (
  SELECT 1 FROM reward_settlements rs
  WHERE rs.id = NEW.settlement_id AND rs.settlement_flow = 'AGENT_REFERRALS'
    AND rs.engagement_id = NEW.engagement_id AND rs.engagement_revision_id = NEW.engagement_revision_id
    AND rs.effective_reward_snapshot_id = NEW.effective_reward_snapshot_id
    AND rs.partner_identity_id = NEW.partner_identity_id AND rs.amount_kopecks = NEW.amount_kopecks
)
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_RELATIONAL_INCONSISTENT'); END;
CREATE TRIGGER settlement_acts_fields_immutable_guard
BEFORE UPDATE ON settlement_acts
WHEN NEW.settlement_id IS NOT OLD.settlement_id OR NEW.engagement_id IS NOT OLD.engagement_id
  OR NEW.engagement_revision_id IS NOT OLD.engagement_revision_id OR NEW.effective_reward_snapshot_id IS NOT OLD.effective_reward_snapshot_id
  OR NEW.partner_identity_id IS NOT OLD.partner_identity_id OR NEW.amount_kopecks IS NOT OLD.amount_kopecks
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_FIELDS_IMMUTABLE'); END;
CREATE TRIGGER settlement_acts_presented_one_way_guard
BEFORE UPDATE ON settlement_acts
WHEN OLD.presented_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_ALREADY_PRESENTED'); END;
CREATE TRIGGER settlement_acts_delete_guard
BEFORE DELETE ON settlement_acts
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_IMMUTABLE'); END;

-- 5. Acceptance and dispute: separate, mutually exclusive, append-only
-- evidence tables - never a status column on settlement_acts. UNIQUE(act_id)
-- on each is "at most one of this kind, ever"; the cross-table EXISTS
-- checks below are "never both kinds for the same act". Acceptance pins
-- BOTH the act id AND a redundant copy of its own amount/revision (Phase
-- 4/5's own "acceptance pins exact act/revision" idiom, e.g.
-- framework_acceptances) - so acceptance evidence is self-describing even
-- read in isolation from the act row. step_up_grant_id UNIQUE ties
-- acceptance to the exact grant that authorized it, one grant, one
-- acceptance, and - because settlement_step_up_grants.action is
-- structurally restricted to 'ACT_ACCEPTANCE' and its consumption
-- (agent-referrals-settlement-step-up.ts) only ever accepts a
-- PartnerPrincipal - an admin can never mint or consume the grant this
-- table requires, so "admin cannot ACT_ACCEPTED" holds without a
-- database-visible admin/partner discriminator column on this table at all.
CREATE TABLE settlement_act_acceptances (
  id TEXT PRIMARY KEY,
  act_id TEXT NOT NULL UNIQUE REFERENCES settlement_acts(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  step_up_grant_id TEXT NOT NULL UNIQUE REFERENCES settlement_step_up_grants(id),
  accepted_amount_kopecks INTEGER NOT NULL,
  accepted_engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER settlement_act_acceptances_relational_consistency_guard
BEFORE INSERT ON settlement_act_acceptances
WHEN (NOT EXISTS (
  SELECT 1 FROM settlement_acts a
  WHERE a.id = NEW.act_id AND a.presented_at IS NOT NULL
    AND a.partner_identity_id = NEW.partner_identity_id
    AND a.amount_kopecks = NEW.accepted_amount_kopecks
    AND a.engagement_revision_id = NEW.accepted_engagement_revision_id
))
OR EXISTS (SELECT 1 FROM settlement_act_disputes d WHERE d.act_id = NEW.act_id)
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_ACCEPTANCE_INVALID'); END;
CREATE TRIGGER settlement_act_acceptances_immutable_guard
BEFORE UPDATE ON settlement_act_acceptances
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE'); END;
CREATE TRIGGER settlement_act_acceptances_delete_guard
BEFORE DELETE ON settlement_act_acceptances
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE'); END;

-- DOCUMENT_DISPUTED: limited reason set, no ticketing/negotiation
-- subsystem. Blocks payment authorization structurally (see
-- payment_authorizations' own guard below, which requires an acceptance
-- AND requires no dispute).
CREATE TABLE settlement_act_disputes (
  id TEXT PRIMARY KEY,
  act_id TEXT NOT NULL UNIQUE REFERENCES settlement_acts(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  reason TEXT NOT NULL CHECK (reason IN ('AMOUNT_INCORRECT', 'PARTNER_DETAILS_INCORRECT', 'SERVICE_NOT_RENDERED', 'OTHER')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER settlement_act_disputes_relational_consistency_guard
BEFORE INSERT ON settlement_act_disputes
WHEN (NOT EXISTS (
  SELECT 1 FROM settlement_acts a WHERE a.id = NEW.act_id AND a.presented_at IS NOT NULL AND a.partner_identity_id = NEW.partner_identity_id
))
OR EXISTS (SELECT 1 FROM settlement_act_acceptances acc WHERE acc.act_id = NEW.act_id)
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_DISPUTE_INVALID'); END;
CREATE TRIGGER settlement_act_disputes_immutable_guard
BEFORE UPDATE ON settlement_act_disputes
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_DISPUTE_IMMUTABLE'); END;
CREATE TRIGGER settlement_act_disputes_delete_guard
BEFORE DELETE ON settlement_act_disputes
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_ACT_DISPUTE_IMMUTABLE'); END;

-- 6. NPD status checks: the real payout authority (never
-- agents.npd_status_checked_at, a bare nullable timestamp with no status
-- and no freshness). Explicit injected/manual evidence boundary - no FNS
-- adapter ships in this PR, so every row is written by an explicit
-- recordNpdStatusCheck() call carrying its own evidence_ref, never
-- fabricated. Immutable, one fact per check, freshness is compared in
-- application code (agent-referrals-npd.ts) using julianday() arithmetic
-- against a named constant, matching how every other freshness window in
-- this codebase (e.g. STALE_PREPARED_SETTLEMENT_MS) is handled - never a
-- magic number baked into a trigger.
CREATE TABLE npd_status_checks (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'UNKNOWN')),
  checked_at TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX npd_status_checks_partner_idx ON npd_status_checks(partner_identity_id, checked_at);
CREATE TRIGGER npd_status_checks_immutable_guard BEFORE UPDATE ON npd_status_checks BEGIN SELECT RAISE(ABORT, 'NPD_STATUS_CHECK_IMMUTABLE'); END;
CREATE TRIGGER npd_status_checks_delete_guard BEFORE DELETE ON npd_status_checks BEGIN SELECT RAISE(ABORT, 'NPD_STATUS_CHECK_IMMUTABLE'); END;

-- 7. PaymentAuthorization: a capability, not a status field. Fully
-- immutable from creation (no UPDATE at all, ever) - "single-use" is
-- proven by payment_attempts.payment_authorization_id being UNIQUE and
-- created atomically with the authorization in the same BEGIN IMMEDIATE
-- transaction (agent-referrals-payment.ts's beginPayment()), never by a
-- mutable consumed_at flag application convention alone would have to be
-- trusted to set. The relational guard below is the real re-check gate:
-- everything BEGIN_PAYMENT must re-verify (settlement still PREPARED and
-- not superseded, exact undisputed accepted act, payout profile still the
-- current usable revision, exact fresh ACTIVE NPD check when tax_mode is
-- NPD, no fabricated NPD authority required for OTHER) is proven exactly
-- once, structurally, at the moment the authorization itself is inserted -
-- raw SQL cannot construct one that skips any of it.
CREATE TABLE payment_authorizations (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  act_id TEXT NOT NULL REFERENCES settlement_acts(id),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  payout_profile_revision_id TEXT NOT NULL REFERENCES payout_profile_revisions(id),
  npd_status_check_id TEXT REFERENCES npd_status_checks(id),
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX payment_authorizations_settlement_idx ON payment_authorizations(settlement_id);
CREATE TRIGGER payment_authorizations_relational_consistency_guard
BEFORE INSERT ON payment_authorizations
WHEN NOT (
  EXISTS (
    SELECT 1 FROM reward_settlements rs
    WHERE rs.id = NEW.settlement_id AND rs.settlement_flow = 'AGENT_REFERRALS'
      AND rs.amount_kopecks = NEW.amount_kopecks
      AND rs.payout_profile_revision_id = NEW.payout_profile_revision_id
      AND rs.status = 'PREPARED'
      AND NOT EXISTS (SELECT 1 FROM reward_settlements later WHERE later.supersedes_settlement_id = rs.id)
      AND (
        (rs.tax_mode_snapshot = 'NPD' AND NEW.npd_status_check_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM npd_status_checks c WHERE c.id = NEW.npd_status_check_id AND c.status = 'ACTIVE' AND c.partner_identity_id = rs.partner_identity_id))
        OR (rs.tax_mode_snapshot = 'OTHER' AND NEW.npd_status_check_id IS NULL)
      )
  )
  AND EXISTS (
    SELECT 1 FROM settlement_acts a
    WHERE a.id = NEW.act_id AND a.settlement_id = NEW.settlement_id AND a.presented_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM settlement_act_acceptances acc WHERE acc.act_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM settlement_act_disputes d WHERE d.act_id = a.id)
  )
  AND EXISTS (
    SELECT 1 FROM payout_profile_revisions ppr
    WHERE ppr.id = NEW.payout_profile_revision_id AND ppr.kind = 'ACTIVE_DESTINATION'
      AND ppr.revision = (SELECT MAX(revision) FROM payout_profile_revisions WHERE partner_identity_id = ppr.partner_identity_id)
  )
)
BEGIN SELECT RAISE(ABORT, 'PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT'); END;
CREATE TRIGGER payment_authorizations_immutable_guard BEFORE UPDATE ON payment_authorizations BEGIN SELECT RAISE(ABORT, 'PAYMENT_AUTHORIZATION_IMMUTABLE'); END;
CREATE TRIGGER payment_authorizations_delete_guard BEFORE DELETE ON payment_authorizations BEGIN SELECT RAISE(ABORT, 'PAYMENT_AUTHORIZATION_IMMUTABLE'); END;

-- 8. Payment attempts. IN_PROGRESS | MADE | PAYOUT_UNKNOWN |
-- CONFIRMED_NOT_MADE - mirroring outbox_attempt's outcome/settlement shape
-- (0041) but with its own vocabulary, since the payout invariant differs:
-- PAYOUT_UNKNOWN is a real state here (not folded into a message-level
-- ambiguity flag), reachable only from IN_PROGRESS, and CONFIRMED_NOT_MADE
-- is reachable from IN_PROGRESS (a synchronous, definitive failure) or
-- from PAYOUT_UNKNOWN (later reconciliation evidence) - never
-- automatically, never by a timeout. MADE is reachable ONLY from
-- IN_PROGRESS: there is no PAYOUT_UNKNOWN -> MADE edge, matching "a missing
-- answer is never read as ACTIVE" applied to payouts - an unresolved
-- payout is never later relabelled paid by this attempt's own lifecycle: a
-- genuinely-late discovery that money did leave is an out-of-band
-- reconciliation fact, outside this attempt's structural vocabulary.
--
-- The partial unique index is the real "at most one unsettled attempt per
-- settlement" backstop (not merely BEGIN IMMEDIATE): only once an attempt
-- reaches CONFIRMED_NOT_MADE does the slot free for a fresh authorization's
-- fresh attempt - MADE also occupies the slot forever, since no second
-- attempt should ever be creatable once one has actually paid.
CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  payment_authorization_id TEXT NOT NULL UNIQUE REFERENCES payment_authorizations(id),
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'MADE', 'PAYOUT_UNKNOWN', 'CONFIRMED_NOT_MADE')),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  made_at TEXT,
  payout_unknown_at TEXT,
  confirmed_not_made_at TEXT,
  evidence_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'IN_PROGRESS')
    OR (status = 'MADE' AND made_at IS NOT NULL)
    OR (status = 'PAYOUT_UNKNOWN' AND payout_unknown_at IS NOT NULL)
    OR (status = 'CONFIRMED_NOT_MADE' AND confirmed_not_made_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX payment_attempts_active_unique
  ON payment_attempts(settlement_id) WHERE status != 'CONFIRMED_NOT_MADE';
CREATE INDEX payment_attempts_settlement_idx ON payment_attempts(settlement_id);
CREATE TRIGGER payment_attempts_relational_consistency_guard
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_authorizations pa
  WHERE pa.id = NEW.payment_authorization_id AND pa.settlement_id = NEW.settlement_id AND pa.amount_kopecks = NEW.amount_kopecks
)
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_RELATIONAL_INCONSISTENT'); END;
CREATE TRIGGER payment_attempts_identity_immutable_guard
BEFORE UPDATE ON payment_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.payment_authorization_id IS NOT OLD.payment_authorization_id
  OR NEW.settlement_id IS NOT OLD.settlement_id OR NEW.amount_kopecks IS NOT OLD.amount_kopecks
  OR NEW.started_at IS NOT OLD.started_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_IDENTITY_IMMUTABLE'); END;
-- Once MADE or CONFIRMED_NOT_MADE, the row is history - no further UPDATE
-- of any kind, matching outbox_attempt_settled_immutable_guard exactly.
CREATE TRIGGER payment_attempts_terminal_immutable_guard
BEFORE UPDATE ON payment_attempts
WHEN OLD.status = 'MADE' OR OLD.status = 'CONFIRMED_NOT_MADE'
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_TERMINAL_IMMUTABLE'); END;
CREATE TRIGGER payment_attempts_transition_legality_guard
BEFORE UPDATE ON payment_attempts
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('MADE', 'PAYOUT_UNKNOWN', 'CONFIRMED_NOT_MADE'))
  OR (OLD.status = 'PAYOUT_UNKNOWN' AND NEW.status = 'CONFIRMED_NOT_MADE')
)
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_TRANSITION_ILLEGAL'); END;
CREATE TRIGGER payment_attempts_delete_guard
BEFORE DELETE ON payment_attempts
BEGIN SELECT RAISE(ABORT, 'PAYMENT_ATTEMPT_IMMUTABLE'); END;

-- 9. NPD receipts. A missing receipt never retries payment, never erases
-- MADE, never turns a payout back to UNKNOWN - it only gates the NPD
-- document-completion path (PENDING_DOCUMENT -> SETTLED). Bound to the
-- EXACT payment_attempt_id (UNIQUE), so one settlement/payment's receipt
-- can never close another. Requires the attempt to already be MADE and
-- the settlement to actually be NPD - closes "receipt of one settlement
-- closes another" and "OTHER forced through the NPD document lifecycle"
-- at once.
CREATE TABLE npd_receipts (
  id TEXT PRIMARY KEY,
  payment_attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
  settlement_id TEXT NOT NULL REFERENCES reward_settlements(id),
  receipt_reference TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER npd_receipts_relational_consistency_guard
BEFORE INSERT ON npd_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_attempts pat
  JOIN reward_settlements rs ON rs.id = pat.settlement_id
  WHERE pat.id = NEW.payment_attempt_id AND pat.status = 'MADE' AND pat.settlement_id = NEW.settlement_id
    AND rs.tax_mode_snapshot = 'NPD'
)
BEGIN SELECT RAISE(ABORT, 'NPD_RECEIPT_RELATIONAL_INCONSISTENT'); END;
CREATE TRIGGER npd_receipts_immutable_guard BEFORE UPDATE ON npd_receipts BEGIN SELECT RAISE(ABORT, 'NPD_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER npd_receipts_delete_guard BEFORE DELETE ON npd_receipts BEGIN SELECT RAISE(ABORT, 'NPD_RECEIPT_IMMUTABLE'); END;

-- 10. Zero-reward closure (§B-3/§B-6). Mutually exclusive with a
-- settlement by construction: reward_total_kopecks is CHECK'd = 0 here,
-- while reward_settlements/settlement_acts both CHECK amount_kopecks > 0
-- and the settlement authority-tuple guard proves amount_kopecks equals
-- the pinned E's own total - so a positive settlement referencing a
-- zero-total E, or a zero closure referencing a positive-total E, are both
-- structurally unrepresentable. UNIQUE(engagement_id): once an engagement's
-- E reaches zero it is an absorbing floor (PR6's own "no increase"
-- correction rule), so at most one zero closure per engagement is not
-- merely idempotent bookkeeping, it is the true cardinality.
CREATE TABLE engagement_zero_reward_closures (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL UNIQUE REFERENCES engagements(id),
  engagement_revision_id TEXT NOT NULL REFERENCES engagement_revisions(id),
  base_registry_snapshot_id TEXT NOT NULL REFERENCES engagement_reward_registry_snapshot(id),
  effective_reward_snapshot_id TEXT NOT NULL REFERENCES engagement_effective_reward_snapshots(id),
  reward_total_kopecks INTEGER NOT NULL CHECK (reward_total_kopecks = 0),
  closure_reason TEXT NOT NULL CHECK (closure_reason IN ('NO_ELIGIBLE_CONVERSIONS', 'FULLY_REFUNDED', 'OCCURRENCE_CANCELLED', 'OTHER_POLICY_ZERO', 'CORRECTED_TO_ZERO')),
  occurrence_fulfillment_status TEXT NOT NULL CHECK (occurrence_fulfillment_status IN ('COMPLETED', 'CANCELLED')),
  service_period_start_at TEXT NOT NULL,
  service_period_end_at TEXT NOT NULL,
  reporting_policy_version INTEGER NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  canonical_hash TEXT NOT NULL,
  closed_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER engagement_zero_reward_closures_relational_consistency_guard
BEFORE INSERT ON engagement_zero_reward_closures
WHEN NOT (
  EXISTS (
    SELECT 1 FROM engagement_effective_reward_snapshots e
    WHERE e.id = NEW.effective_reward_snapshot_id AND e.engagement_id = NEW.engagement_id
      AND e.engagement_revision_id = NEW.engagement_revision_id AND e.base_registry_snapshot_id = NEW.base_registry_snapshot_id
      AND e.reward_total_kopecks = 0
  )
  AND EXISTS (SELECT 1 FROM engagement_reward_registry_snapshot r WHERE r.id = NEW.base_registry_snapshot_id AND r.engagement_id = NEW.engagement_id)
)
BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ZERO_REWARD_CLOSURE_RELATIONAL_INCONSISTENT'); END;
CREATE TRIGGER engagement_zero_reward_closures_immutable_guard BEFORE UPDATE ON engagement_zero_reward_closures BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE'); END;
CREATE TRIGGER engagement_zero_reward_closures_delete_guard BEFORE DELETE ON engagement_zero_reward_closures BEGIN SELECT RAISE(ABORT, 'ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE'); END;
