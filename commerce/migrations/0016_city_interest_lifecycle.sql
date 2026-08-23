-- City-interest requests are purpose-limited personal data. Existing consent
-- evidence remains intact; expiry is deterministically derived from it.
ALTER TABLE city_interest_requests ADD COLUMN expires_at TEXT;

UPDATE city_interest_requests
  SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', consent_accepted_at, '+12 months')
  WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS city_interest_requests_expiry_idx
  ON city_interest_requests(expires_at);
