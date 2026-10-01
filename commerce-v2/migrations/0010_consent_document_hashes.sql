ALTER TABLE account_consents ADD COLUMN document_sha256 TEXT;
ALTER TABLE marketing_consents ADD COLUMN document_sha256 TEXT;

CREATE TRIGGER account_consents_document_hash_insert_guard
BEFORE INSERT ON account_consents
WHEN NEW.document_sha256 IS NULL OR NEW.document_sha256 GLOB '*[^0-9a-f]*' OR length(NEW.document_sha256) <> 64
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_CONSENT_DOCUMENT_HASH_INVALID');
END;

CREATE TRIGGER account_consents_document_hash_update_guard
BEFORE UPDATE OF document_sha256 ON account_consents
WHEN NEW.document_sha256 IS NULL OR NEW.document_sha256 GLOB '*[^0-9a-f]*' OR length(NEW.document_sha256) <> 64
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_CONSENT_DOCUMENT_HASH_INVALID');
END;

CREATE TRIGGER marketing_consents_document_hash_insert_guard
BEFORE INSERT ON marketing_consents
WHEN NEW.document_sha256 IS NULL OR NEW.document_sha256 GLOB '*[^0-9a-f]*' OR length(NEW.document_sha256) <> 64
BEGIN
  SELECT RAISE(ABORT, 'MARKETING_CONSENT_DOCUMENT_HASH_INVALID');
END;

CREATE TRIGGER marketing_consents_document_hash_update_guard
BEFORE UPDATE OF document_sha256 ON marketing_consents
WHEN NEW.document_sha256 IS NULL OR NEW.document_sha256 GLOB '*[^0-9a-f]*' OR length(NEW.document_sha256) <> 64
BEGIN
  SELECT RAISE(ABORT, 'MARKETING_CONSENT_DOCUMENT_HASH_INVALID');
END;
