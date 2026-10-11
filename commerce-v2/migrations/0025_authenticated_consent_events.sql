-- New authenticated actions, never an upgrade/rewrite of historical intents.
CREATE TABLE authenticated_consent_actions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  auth_user_id TEXT NOT NULL REFERENCES "user"(id),
  storefront TEXT NOT NULL CHECK (storefront IN ('COURSES','LAB')),
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  release_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256)=64),
  action_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
  recorded_at TEXT NOT NULL CHECK (datetime(recorded_at) IS NOT NULL),
  UNIQUE(customer_id,storefront,action_key)
);
CREATE TABLE authenticated_consent_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES authenticated_consent_actions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('personal_data','account_terms','marketing_consent')),
  granted INTEGER NOT NULL CHECK (granted IN (0,1)),
  document_version TEXT NOT NULL,
  document_sha256 TEXT NOT NULL CHECK (length(document_sha256)=64),
  UNIQUE(action_id,kind)
);
CREATE TRIGGER authenticated_consent_action_authority BEFORE INSERT ON authenticated_consent_actions
WHEN NOT EXISTS (
  SELECT 1 FROM customers c JOIN "user" u ON u.id=c.auth_user_id
  JOIN legal_releases l ON l.id=NEW.legal_release_id
  WHERE c.id=NEW.customer_id AND u.id=NEW.auth_user_id AND u.email_verified=1
    AND lower(trim(u.email))=c.email_normalized AND l.active=1 AND l.storefront=NEW.storefront AND l.version=NEW.release_version
)
BEGIN SELECT RAISE(ABORT,'AUTHENTICATED_CONSENT_AUTHORITY_INVALID'); END;
CREATE TRIGGER authenticated_consent_event_document BEFORE INSERT ON authenticated_consent_events
WHEN (NEW.kind<>'marketing_consent' AND NEW.granted<>1) OR NOT EXISTS (
  SELECT 1 FROM authenticated_consent_actions a JOIN legal_releases l ON l.id=a.legal_release_id
    JOIN customers c ON c.id=a.customer_id JOIN "user" u ON u.id=c.auth_user_id,
    json_each(l.manifest_json,'$.documents') d
  WHERE a.id=NEW.action_id AND l.active=1 AND u.id=a.auth_user_id AND u.email_verified=1
    AND lower(trim(u.email))=c.email_normalized AND json_extract(d.value,'$.kind')=NEW.kind
    AND json_extract(d.value,'$.version')=NEW.document_version
    AND json_extract(d.value,'$.sha256')=NEW.document_sha256
)
BEGIN SELECT RAISE(ABORT,'AUTHENTICATED_CONSENT_DOCUMENT_INVALID'); END;
CREATE TRIGGER authenticated_consent_action_immutable BEFORE UPDATE ON authenticated_consent_actions
BEGIN SELECT RAISE(ABORT,'AUTHENTICATED_CONSENT_ACTION_IMMUTABLE'); END;
CREATE TRIGGER authenticated_consent_event_immutable BEFORE UPDATE ON authenticated_consent_events
BEGIN SELECT RAISE(ABORT,'AUTHENTICATED_CONSENT_EVENT_IMMUTABLE'); END;
