-- PR-C2 review round 2, P1: a monotone per-partner sequence for legal-profile
-- change requests, because the pin the submit command carried was not
-- actually a proof.
--
-- Submitting a supersession was classified STALE_BOUND on the CURRENT
-- verified legal-profile revision. That misses a legal B*:
--
--   verified profile = L1
--   A: submit R1, pinned to revision 1
--   B: an admin REJECTS R1
--        -> the verified profile is STILL L1 (a rejection mints nothing)
--        -> the "one PENDING per partner" slot is free again
--   retry A, byte for byte, pinned to revision 1
--        -> the pin still matches, and R2 is filed
--
-- A rejection is ordinary admin work, it frees the write precondition, and
-- it does not move the pinned value. So the verified revision alone cannot
-- separate a lost-response retry from a deliberate re-application after a
-- refusal.
--
-- This adds the value that does move: the number of requests ever filed for
-- that partner. A submit pins BOTH - the verified revision it is changing
-- FROM, and the request-chain head it is filing AFTER - which together also
-- read as the truthful description of the command ("the next request after
-- the one I saw, against the profile I saw").
--
-- Why not the verified revision plus "no PENDING exists": that is the write
-- precondition itself, and a precondition a legal B* can restore is exactly
-- what this whole matrix stopped accepting as a proof.
ALTER TABLE agent_referrals_legal_profile_change_requests
  ADD COLUMN request_sequence INTEGER NOT NULL DEFAULT 0;

-- Deterministic backfill, per partner, in filing order - never all-zero.
-- created_at is second-precision here, so id breaks a same-second tie; the
-- result only has to be a stable 1..n, not a reconstruction of the exact
-- historical instants.
UPDATE agent_referrals_legal_profile_change_requests AS r
SET request_sequence = (
  SELECT COUNT(*) FROM agent_referrals_legal_profile_change_requests AS earlier
  WHERE earlier.partner_identity_id = r.partner_identity_id
    AND (earlier.created_at < r.created_at
      OR (earlier.created_at = r.created_at AND earlier.id <= r.id))
);

-- Structural, not merely allocated in application code: two concurrent
-- submits that both read the same MAX must not both land. The writers open
-- BEGIN IMMEDIATE, so this is a backstop rather than the primary mechanism -
-- which is the same division of labour partner_invite_capabilities and the
-- distribution event stream already use.
CREATE UNIQUE INDEX agent_referrals_legal_profile_change_requests_sequence_unique
  ON agent_referrals_legal_profile_change_requests(partner_identity_id, request_sequence);

-- The "заявка" column group is immutable from INSERT, and request_sequence
-- belongs to it: it identifies WHICH filing this row is, not how it was
-- resolved. SQLite cannot alter a trigger, so 0051's guard is dropped and
-- recreated with the new column rather than a second overlapping guard
-- being added beside it.
DROP TRIGGER agent_referrals_legal_profile_change_requests_request_fields_immutable_guard;
CREATE TRIGGER agent_referrals_legal_profile_change_requests_request_fields_immutable_guard
BEFORE UPDATE ON agent_referrals_legal_profile_change_requests
WHEN NEW.partner_identity_id IS NOT OLD.partner_identity_id
  OR NEW.legal_form IS NOT OLD.legal_form
  OR NEW.tax_mode IS NOT OLD.tax_mode
  OR NEW.assertion_source IS NOT OLD.assertion_source
  OR NEW.evidence_ref IS NOT OLD.evidence_ref
  OR NEW.reason IS NOT OLD.reason
  OR NEW.supersedes_revision_id IS NOT OLD.supersedes_revision_id
  OR NEW.request_sequence IS NOT OLD.request_sequence
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE'); END;
