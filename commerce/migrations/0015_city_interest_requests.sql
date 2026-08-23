CREATE TABLE IF NOT EXISTS city_interest_requests (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  city_slug TEXT NOT NULL,
  privacy_policy_version TEXT NOT NULL,
  privacy_policy_sha256 TEXT NOT NULL,
  pd_consent_version TEXT NOT NULL,
  pd_consent_sha256 TEXT NOT NULL,
  consent_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (email_hash, city_slug)
);

CREATE INDEX IF NOT EXISTS city_interest_requests_city_created_at_idx
  ON city_interest_requests(city_slug, created_at);
