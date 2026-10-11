-- Email ownership verified later is not proof of who checked an earlier form.
-- Preserve historical rows; never upgrade them based on the customer's current user.
ALTER TABLE account_consents ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'LEGACY_UNQUALIFIED'
  CHECK (evidence_status IN ('LEGACY_UNQUALIFIED', 'UNVERIFIED_INTENT', 'AUTHENTICATED_ACTION'));
ALTER TABLE account_consents ADD COLUMN confirmed_auth_user_id TEXT REFERENCES "user"(id);
ALTER TABLE account_consents ADD COLUMN confirmed_at TEXT;
ALTER TABLE marketing_consents ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'LEGACY_UNQUALIFIED'
  CHECK (evidence_status IN ('LEGACY_UNQUALIFIED', 'UNVERIFIED_INTENT', 'AUTHENTICATED_ACTION'));
ALTER TABLE marketing_consents ADD COLUMN confirmed_auth_user_id TEXT REFERENCES "user"(id);
ALTER TABLE marketing_consents ADD COLUMN confirmed_at TEXT;

CREATE TRIGGER account_consent_attribution_insert
BEFORE INSERT ON account_consents
WHEN (NEW.evidence_status = 'AUTHENTICATED_ACTION' AND (
  NEW.source <> 'AUTHENTICATED_ACCOUNT_ACTION' OR datetime(NEW.confirmed_at) IS NULL OR NOT EXISTS (
    SELECT 1 FROM customers c JOIN "user" u ON u.id=c.auth_user_id
    WHERE c.id=NEW.customer_id AND u.id=NEW.confirmed_auth_user_id
      AND u.email_verified=1 AND lower(trim(u.email))=c.email_normalized
  ))) OR (NEW.evidence_status <> 'AUTHENTICATED_ACTION' AND
    (NEW.confirmed_auth_user_id IS NOT NULL OR NEW.confirmed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_CONSENT_ATTRIBUTION_INVALID'); END;

CREATE TRIGGER marketing_consent_attribution_insert
BEFORE INSERT ON marketing_consents
WHEN (NEW.evidence_status = 'AUTHENTICATED_ACTION' AND (
  NEW.source <> 'AUTHENTICATED_ACCOUNT_ACTION' OR datetime(NEW.confirmed_at) IS NULL OR NOT EXISTS (
    SELECT 1 FROM customers c JOIN "user" u ON u.id=c.auth_user_id
    WHERE c.id=NEW.customer_id AND u.id=NEW.confirmed_auth_user_id
      AND u.email_verified=1 AND lower(trim(u.email))=c.email_normalized
  ))) OR (NEW.evidence_status <> 'AUTHENTICATED_ACTION' AND
    (NEW.confirmed_auth_user_id IS NOT NULL OR NEW.confirmed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'MARKETING_CONSENT_ATTRIBUTION_INVALID'); END;

-- Reaffirmation must be a NEW authenticated action, never a rewritten old intent.
CREATE TRIGGER account_consent_attribution_immutable
BEFORE UPDATE ON account_consents
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_CONSENT_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER marketing_consent_attribution_immutable
BEFORE UPDATE ON marketing_consents
BEGIN SELECT RAISE(ABORT, 'MARKETING_CONSENT_HISTORY_IMMUTABLE'); END;
