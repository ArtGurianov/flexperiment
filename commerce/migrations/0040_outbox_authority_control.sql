-- Outbox authority control: the compatibility layer that makes the NEXT
-- authority migration safe.
--
-- This release introduces no attempt table, no backfill and no authority
-- change. Its entire purpose is to retrofit a fence onto the email worker that
-- is ALREADY RUNNING in production, before anything it must contain exists.
--
-- Why a database fence rather than a flag the worker reads: the deployed binary
-- never reads any flag. It wakes every 30 seconds unconditionally, so
-- "dispatch paused, no leases held, nothing in SENDING" proves only that the
-- last sweep drained. Draining is not exclusion - an idle old worker can wake a
-- moment later and claim again. The fence therefore sits on the claim
-- transition itself, which the old worker performs before it touches the
-- provider, so a binary that has never heard of this table still obeys it.
--
--   no email leases, nothing in SENDING     drain proof
--   email_dispatch_paused + trigger         future-dispatch exclusion proof
--
-- The worker is NOT paused; outbound email dispatch is. A sweep does twelve
-- things - refund submission and reconciliation, payment recovery, stale
-- prepared settlements, overdue venue announcements, command recovery, two
-- notification lifecycles, provider event-dump reconciliation - and only
-- processEmailOutbox dispatches mail. Freezing all of it to migrate email
-- authority would enlarge the blast radius for no benefit, and would stop the
-- very reconciliation that can usefully keep observing provider evidence while
-- dispatch is fenced.

CREATE TABLE outbox_authority (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  -- LEGACY only. Not "no command sets it" - the state space of this release
  -- literally does not contain ATTEMPT, so `UPDATE outbox_authority SET
  -- attempt_authority = 'ATTEMPT'` fails on the CHECK no matter who runs it.
  --
  -- An enum admitting a value nothing may set is a loaded gun: it would let a
  -- stray statement activate the freeze guard below while no attempt authority
  -- exists to receive the writes it blocks. The freeze guard still names
  -- 'ATTEMPT' - that branch is simply unreachable until a later migration
  -- widens this CHECK by rebuilding the table.
  --
  -- That rebuild has no inbound foreign keys to carry, but it is NOT free:
  -- RENAME rewrites the two triggers below to reference the temporary table, so
  -- dropping it leaves both guards dangling and the fence silently stops
  -- fencing. The widening migration MUST drop and recreate both triggers in the
  -- same transaction. This is proven in outbox-authority-control.test.ts, which
  -- performs the real upgrade path rather than an idealised one.
  attempt_authority TEXT NOT NULL DEFAULT 'LEGACY' CHECK (attempt_authority = 'LEGACY'),
  email_dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK (email_dispatch_paused IN (0, 1)),

  -- Which release epoch holds the fence. Without this the durable authority
  -- belongs to whoever possesses the release-control credential rather than to
  -- the cutover that acquired it, and CAS alone does not help: a second
  -- controller can read the current revision and unfence in the middle of the
  -- first one's migration.
  --
  -- Ownership lives here and NOT on the release sales gate deliberately. If
  -- unfencing required the sales gate to still be owned, an abort or a
  -- completed release would strand email dispatch fenced with no way back.
  dispatch_owner_release_id TEXT,
  dispatch_owner_generation INTEGER,

  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Fenced and owned are the same fact, in the shape 0039 used: a fence with no
  -- owner could never be released, and an owner with no fence is a claim on
  -- nothing.
  CHECK ((email_dispatch_paused = 1) = (dispatch_owner_release_id IS NOT NULL))
);

-- Starts safe: legacy authority, dispatch open, revision 1.
INSERT INTO outbox_authority(singleton) VALUES (1);

-- Append-only. The action vocabulary is deliberately limited to the two
-- transitions this release is allowed to perform: there is no activation action
-- to record, because there is no activation.
CREATE TABLE outbox_authority_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('DISPATCH_FENCED', 'DISPATCH_UNFENCED')),
  -- The epoch, not "release-control". An audit line naming only the shared
  -- credential answers who had the token, not which migration stopped the mail.
  owner_release_id TEXT NOT NULL,
  owner_generation INTEGER,
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX outbox_authority_events_created_idx ON outbox_authority_events(created_at);

-- The fence. It intercepts exactly the transition the worker makes at the
-- provider boundary: PENDING or SEND_UNKNOWN to SENDING, taking the lease and
-- incrementing attempts, all before the provider is called. Aborting here means
-- no send can begin, whatever the calling binary believes.
CREATE TRIGGER email_outbox_dispatch_pause_guard
BEFORE UPDATE ON email_outbox
WHEN NEW.status = 'SENDING'
  AND OLD.status IN ('PENDING', 'SEND_UNKNOWN')
  -- COALESCE, because a missing control row yields NULL and `NULL = 1` is not
  -- true - the fence would fail OPEN for exactly the old binary it exists to
  -- stop, while the application reader failed closed. Two authorities
  -- disagreeing about corruption is the defect this table exists to prevent.
  AND COALESCE((SELECT email_dispatch_paused FROM outbox_authority WHERE singleton = 1), 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_DISPATCH_PAUSED');
END;

-- Installed now, inert until authority moves, so the next release does not have
-- to introduce a guard at the same moment it starts relying on it.
--
-- A database guard rather than a test: email_outbox has 21 distinct UPDATE
-- sites - claim, settle, ambiguous deferral, exhaustion, supersession,
-- suppression, webhook projection - and a forgotten twenty-second path must
-- fail closed rather than silently write to a store nobody reads. That is
-- exactly how 0039's trigger caught the parameter-bound write source review had
-- missed.
--
-- Compared with `IS NOT`, which is null-safe, rather than `UPDATE OF`, which
-- SQLite silently ignores for a misspelled column name.
--
-- Message-level facts are deliberately absent from this list and stay writable
-- under ATTEMPT: status, delivery_outcome, sent_at, delivered_at, bounced_at,
-- suppressed_at, superseded_at, superseded_reason, ops_acknowledged_at,
-- ops_acknowledged_reason, and message identity.
CREATE TRIGGER email_outbox_legacy_attempt_freeze_guard
BEFORE UPDATE ON email_outbox
-- Unreachable in this release: the CHECK above admits only LEGACY. Written now
-- so the next migration does not have to introduce a guard at the same moment
-- it starts depending on one.
WHEN COALESCE((SELECT attempt_authority FROM outbox_authority WHERE singleton = 1), 'LEGACY') = 'ATTEMPT'
  AND (
    NEW.provider_idempotence_key IS NOT OLD.provider_idempotence_key
    OR NEW.job_id IS NOT OLD.job_id
    OR NEW.lease_owner IS NOT OLD.lease_owner
    OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
    OR NEW.send_started_at IS NOT OLD.send_started_at
    OR NEW.provider_request_started_at IS NOT OLD.provider_request_started_at
    OR NEW.attempts IS NOT OLD.attempts
    OR NEW.last_error IS NOT OLD.last_error
    OR NEW.provider_error_code IS NOT OLD.provider_error_code
    OR NEW.provider_error_message IS NOT OLD.provider_error_message
    OR NEW.next_attempt_at IS NOT OLD.next_attempt_at
  )
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_OUTBOX_LEGACY_ATTEMPT_FROZEN');
END;
