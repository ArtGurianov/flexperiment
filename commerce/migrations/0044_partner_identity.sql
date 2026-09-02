-- Agent Referrals partner identity: invite-only OWNER identity, admin-minted
-- invite capability, OTP challenge with unknown-outcome semantics, partner
-- session (separate realm from fx_admin_session), step-up grants,
-- onboarding state authority, framework acceptance + effective ORD
-- delegation, immutable payout-profile revisions, identity retention / legal
-- holds / destruction evidence. Ordinary migration - not FK-off. No PR5
-- engagement/publication/promo/creative/distribution tables.

-- 1. Partner identity. `agent_id` UNIQUE is the entire "exactly one OWNER per
-- partner" structural guarantee - a partner IS an agents row (PR2/PR3's
-- entity), and this table can never carry a second identity for the same
-- one. No role/team/membership vocabulary exists anywhere in this schema by
-- construction, which is what keeps RBAC from creeping in later.
--
-- submitted_legal_form/submitted_tax_mode are the partner's mutable DRAFT
-- claim, distinct from agent_referrals_legal_profile_revisions (PR3's
-- immutable evidence, written only once an admin verifies). The draft is
-- deliberately not itself evidence - it exists so the admin verification
-- command has something to read, and it becomes unwritable once verified
-- (enforced in commerce/src/agent-referrals-partner-identity.ts, gated on
-- onboarding_state).
CREATE TABLE partner_identities (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
  email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  onboarding_state TEXT NOT NULL DEFAULT 'INVITED' CHECK (onboarding_state IN ('INVITED', 'PROFILE_SUBMITTED', 'PROFILE_VERIFIED', 'FRAMEWORK_ISSUED', 'FRAMEWORK_ACCEPTED', 'PARTNER_ACTIVE')),
  onboarding_revision INTEGER NOT NULL DEFAULT 1,
  submitted_legal_form TEXT CHECK (submitted_legal_form IS NULL OR submitted_legal_form IN ('INDIVIDUAL', 'INDIVIDUAL_ENTREPRENEUR', 'LEGAL_ENTITY')),
  submitted_tax_mode TEXT CHECK (submitted_tax_mode IS NULL OR submitted_tax_mode IN ('NPD', 'OTHER')),
  legal_profile_revision_id TEXT REFERENCES agent_referrals_legal_profile_revisions(id),
  destroyed_at TEXT,
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Append-only partner-realm audit trail. Deliberately separate from
-- admin_audit_log (which is keyed admin_id and belongs to the ADMIN realm) -
-- realm separation is a hard boundary, and evidence produced by a partner
-- action must never live in the admin ledger.
CREATE TABLE partner_identity_events (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  event_kind TEXT NOT NULL,
  actor_realm TEXT NOT NULL CHECK (actor_realm IN ('ADMIN', 'PARTNER', 'SYSTEM')),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX partner_identity_events_partner_idx ON partner_identity_events(partner_identity_id, created_at);
CREATE TRIGGER partner_identity_events_immutable_guard
BEFORE UPDATE ON partner_identity_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_EVENT_IMMUTABLE'); END;
CREATE TRIGGER partner_identity_events_delete_guard
BEFORE DELETE ON partner_identity_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_EVENT_IMMUTABLE'); END;

-- 3. Admin-minted, one-time, expiry-bound, partner+purpose-bound invite
-- capability. Only a verifier hash is durable - the raw token exists only in
-- memory at mint time and in the URL the admin hands the partner out of
-- band. The partial unique index is the structural "at most one live invite
-- per partner" guarantee, mirroring outbox_attempt_active_unique: a reissue
-- must supersede or revoke the current one first, never leave two live.
CREATE TABLE partner_invite_capabilities (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  purpose TEXT NOT NULL CHECK (purpose = 'ONBOARDING'),
  verifier_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  superseded_by_id TEXT REFERENCES partner_invite_capabilities(id),
  created_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX partner_invite_capabilities_partner_idx ON partner_invite_capabilities(partner_identity_id);
CREATE UNIQUE INDEX partner_invite_capabilities_active_unique
  ON partner_invite_capabilities(partner_identity_id) WHERE consumed_at IS NULL AND revoked_at IS NULL AND superseded_by_id IS NULL;

-- 4. OTP challenge. Never a plaintext code/token column - only secret_hash,
-- persisted BEFORE any external send is attempted. send_outcome mirrors
-- outbox_attempt's outcome vocabulary, widened with UNKNOWN (ambiguity here
-- is a property of the challenge itself, since - unlike email_outbox/
-- outbox_attempt - there is no separate message/attempt split: each resend
-- mints an entirely new challenge and a brand-new secret, never a second
-- attempt against the same one). The partial unique index is "at most one
-- live challenge per identity", the same structural pattern as the invite
-- table above.
CREATE TABLE partner_otp_challenges (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  purpose TEXT NOT NULL CHECK (purpose = 'LOGIN'),
  secret_hash TEXT NOT NULL,
  send_outcome TEXT CHECK (send_outcome IS NULL OR send_outcome IN ('ACCEPTED', 'UNKNOWN', 'KNOWN_FAILED')),
  send_attempted_at TEXT,
  consumed_at TEXT,
  superseded_by_id TEXT REFERENCES partner_otp_challenges(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX partner_otp_challenges_partner_idx ON partner_otp_challenges(partner_identity_id);
CREATE UNIQUE INDEX partner_otp_challenges_active_unique
  ON partner_otp_challenges(partner_identity_id) WHERE consumed_at IS NULL AND superseded_by_id IS NULL;

-- 5. Partner session: a SEPARATE realm from fx_admin_session, never a
-- union-role session. Opaque high-entropy token; only its hash is durable,
-- so revocation deletes server authority rather than relying on the browser
-- to discard a cookie.
CREATE TABLE partner_sessions (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX partner_sessions_partner_idx ON partner_sessions(partner_identity_id);

-- 6. Step-up grant: pins the exact action AND the exact resource/revision it
-- authorizes (resource_hash over resource_json) - never a generic boolean.
-- Single-use via consumed_at, consumed atomically with the protected
-- mutation it authorizes (enforced in application code, not here).
CREATE TABLE step_up_grants (
  id TEXT PRIMARY KEY,
  partner_session_id TEXT NOT NULL REFERENCES partner_sessions(id),
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  action TEXT NOT NULL CHECK (action IN ('FRAMEWORK_ACCEPTANCE', 'PAYOUT_PROFILE_SUPERSESSION')),
  resource_json TEXT NOT NULL,
  resource_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX step_up_grants_partner_idx ON step_up_grants(partner_identity_id);

-- 7. Framework acceptance: pins BOTH exact template authorities the partner
-- actually accepted, never "current" resolved later. UNIQUE on the full
-- (partner, framework revision, delegation revision) triple is what makes an
-- exact-parameter replay idempotently detectable; a different revision on a
-- second call is a distinct triple, never silently treated as the same
-- acceptance. step_up_grant_id UNIQUE ties this evidence to the exact grant
-- that authorized it, one grant, one acceptance.
CREATE TABLE framework_acceptances (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  framework_agreement_revision_id TEXT NOT NULL REFERENCES framework_agreement_revisions(id),
  delegation_template_revision_id TEXT NOT NULL REFERENCES delegation_template_revisions(id),
  step_up_grant_id TEXT NOT NULL UNIQUE REFERENCES step_up_grants(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, framework_agreement_revision_id, delegation_template_revision_id)
);
CREATE TRIGGER framework_acceptances_immutable_guard
BEFORE UPDATE ON framework_acceptances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_IMMUTABLE'); END;
CREATE TRIGGER framework_acceptances_delete_guard
BEFORE DELETE ON framework_acceptances
BEGIN SELECT RAISE(ABORT, 'FRAMEWORK_ACCEPTANCE_IMMUTABLE'); END;

-- 8. The effective ORD delegation this framework acceptance creates. Kept
-- distinct from framework_acceptances (rather than folded into it) because
-- PR5's revokeDelegation() will stamp its own evidence onto this identity
-- later; ord_reporting_mode is always FLEXPERIMENT_DELEGATED per B-14 and the
-- CHECK enforces that structurally, matching delegation_template_revisions.
CREATE TABLE ord_reporting_delegations (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL UNIQUE REFERENCES partner_identities(id),
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

-- 9. Immutable payout-profile revisions. "Current" is always
-- MAX(revision) WHERE partner_identity_id = ?, exactly PR3's legal-profile
-- pattern - no stored pointer to drift. A REVOKED-kind revision closes the
-- profile (no destination fields) without ever mutating a prior row; a
-- supersession is simply the next revision. Sensitive fields (key_id,
-- ciphertext, nonce) are non-NULL only for ACTIVE_DESTINATION and NULL only
-- for REVOKED, enforced by the combined CHECK below - so a REVOKED revision
-- can never carry leftover ciphertext, and an ACTIVE_DESTINATION one can
-- never be missing it.
CREATE TABLE payout_profile_revisions (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ACTIVE_DESTINATION', 'REVOKED')),
  key_id TEXT,
  ciphertext TEXT,
  nonce TEXT,
  destination_kind TEXT CHECK (destination_kind IS NULL OR destination_kind IN ('BANK_CARD', 'BANK_ACCOUNT')),
  destination_last4 TEXT,
  supersedes_revision_id TEXT REFERENCES payout_profile_revisions(id),
  step_up_grant_id TEXT NOT NULL UNIQUE REFERENCES step_up_grants(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (partner_identity_id, revision),
  CHECK (
    (kind = 'ACTIVE_DESTINATION' AND key_id IS NOT NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND destination_kind IS NOT NULL)
    OR (kind = 'REVOKED' AND key_id IS NULL AND ciphertext IS NULL AND nonce IS NULL AND destination_kind IS NULL AND destination_last4 IS NULL)
  )
);
CREATE INDEX payout_profile_revisions_partner_idx ON payout_profile_revisions(partner_identity_id, revision);
CREATE TRIGGER payout_profile_revisions_immutable_guard
BEFORE UPDATE ON payout_profile_revisions
BEGIN SELECT RAISE(ABORT, 'PAYOUT_PROFILE_REVISION_IMMUTABLE'); END;
CREATE TRIGGER payout_profile_revisions_delete_guard
BEFORE DELETE ON payout_profile_revisions
BEGIN SELECT RAISE(ABORT, 'PAYOUT_PROFILE_REVISION_IMMUTABLE'); END;

-- 10. Identity retention: versioned policy, legal holds (mutable control
-- state - released_at set to lift one, never deleted), and immutable
-- destruction evidence. A legal hold blocks destruction; destruction never
-- hard-deletes partner_identities (which would break every FK evidence
-- chain above) - it scrubs only the PII columns (email/email_hash) on that
-- row under application authority and records what it destroyed here.
CREATE TABLE partner_identity_retention_policies (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  retention_period_days INTEGER NOT NULL CHECK (retention_period_days > 0),
  reason TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES partner_identity_retention_policies(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER partner_identity_retention_policies_immutable_guard
BEFORE UPDATE ON partner_identity_retention_policies
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE'); END;
CREATE TRIGGER partner_identity_retention_policies_delete_guard
BEFORE DELETE ON partner_identity_retention_policies
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE'); END;
-- Seeded static configuration (Phase 9 readiness distinguishes it from a
-- business record), matching PR3's channel-policy seeding precedent.
INSERT INTO partner_identity_retention_policies(id, revision, retention_period_days, reason)
  VALUES (lower(hex(randomblob(16))), 1, 1095, 'Seeded at foundation: 3-year default identity retention floor (PR4).');

CREATE TABLE partner_identity_legal_holds (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL REFERENCES partner_identities(id),
  reason TEXT NOT NULL,
  placed_by_admin_id TEXT NOT NULL,
  placed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  released_by_admin_id TEXT,
  released_reason TEXT
);
CREATE INDEX partner_identity_legal_holds_partner_idx ON partner_identity_legal_holds(partner_identity_id);
CREATE UNIQUE INDEX partner_identity_legal_holds_active_unique
  ON partner_identity_legal_holds(partner_identity_id) WHERE released_at IS NULL;

CREATE TABLE partner_identity_destruction_events (
  id TEXT PRIMARY KEY,
  partner_identity_id TEXT NOT NULL UNIQUE REFERENCES partner_identities(id),
  destroyed_fields_json TEXT NOT NULL,
  retention_policy_revision_id TEXT NOT NULL REFERENCES partner_identity_retention_policies(id),
  requested_by_admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER partner_identity_destruction_events_immutable_guard
BEFORE UPDATE ON partner_identity_destruction_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_DESTRUCTION_EVENT_IMMUTABLE'); END;
CREATE TRIGGER partner_identity_destruction_events_delete_guard
BEFORE DELETE ON partner_identity_destruction_events
BEGIN SELECT RAISE(ABORT, 'PARTNER_IDENTITY_DESTRUCTION_EVENT_IMMUTABLE'); END;
